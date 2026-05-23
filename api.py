import os
import sys
import json
import asyncio
import pandas as pd
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

ROOT_DIR    = Path(__file__).resolve().parent.parent
DTC_HISTORY = ROOT_DIR / "data" / "dtc_history.json"
_DTC_HISTORY_MAX = 200
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from deltalake import DeltaTable
import pyarrow.compute as pc

from DTC.src.inference import DTCInferenceService
from DTC.src.config import load_dtc_master

BRONZE_ROOT    = ROOT_DIR / "data" / "delta" / "bronze"
DTC_MASTER_JSON = ROOT_DIR / "contracts" / "DTC_master.json"
DTC_LOOKBACK_ROWS = 600
VEHICLE_MODULES   = ["engine", "transmission", "battery", "body", "tyre"]

_dtc_services: dict[str, DTCInferenceService] = {}
_msg_maps:     dict[str, dict[str, str]]       = {}

app = FastAPI(title="DTC Analysis Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    await asyncio.to_thread(_load_all_models)


def _load_all_models() -> None:
    try:
        master = load_dtc_master()
    except Exception as e:
        print(f"[DTC] Could not load master contract: {e}")
        return

    for module in VEHICLE_MODULES:
        if module not in master.get("modules", {}):
            continue
        try:
            svc = DTCInferenceService(module)
            _dtc_services[module] = svc
            _msg_maps[module] = {
                d["dtc_code"]: d["dashboard_message"]
                for d in master["modules"][module]
            }
            print(f"[DTC] {module}: {len(svc.models)} models loaded")
        except Exception as e:
            print(f"[DTC] {module}: load failed — {e}")


def _fetch_traceback(source_id: str, module: str, peak_ts: pd.Timestamp) -> pd.DataFrame:
    dt_path = (BRONZE_ROOT / module).as_posix()
    if not os.path.exists(dt_path):
        return pd.DataFrame()
    try:
        dataset = DeltaTable(dt_path).to_pyarrow_dataset()
        df = (
            dataset.scanner(filter=(pc.field("source_id") == source_id))
            .to_table()
            .to_pandas()
        )
        if df.empty:
            return df
        df["timestamp"] = pd.to_datetime(df["timestamp"])
        df = df[df["timestamp"] <= peak_ts]
        df = df.sort_values("timestamp").tail(DTC_LOOKBACK_ROWS).reset_index(drop=True)
        return df.ffill().fillna(0.0)
    except Exception as e:
        print(f"[DTC] fetch_traceback error for {source_id}/{module}: {e}")
        return pd.DataFrame()


def _smart_attribution(
    raw_crit: pd.DataFrame,
    raw_noncrit: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    cols_crit    = [c for c in raw_crit.columns    if c != "timestamp"]
    cols_noncrit = [c for c in raw_noncrit.columns if c != "timestamp"]

    raw_buildups: dict = {}
    for col in cols_crit:
        floor = raw_crit[col].median()
        raw_buildups[col] = ((raw_crit[col] - floor).clip(lower=0.0) ** 2).cumsum()
    for col in cols_noncrit:
        floor = raw_noncrit[col].median()
        raw_buildups[col] = ((raw_noncrit[col] - floor).clip(lower=0.0) ** 2).cumsum()

    global_max   = max((s.max() for s in raw_buildups.values()), default=0.0)
    scale_factor = (1.0 / global_max) if global_max > 1e-6 else 0.0

    df_crit = pd.DataFrame(index=raw_crit.index)
    if "timestamp" in raw_crit.columns:
        df_crit["timestamp"] = raw_crit["timestamp"]
    for col in cols_crit:
        df_crit[col] = (raw_buildups[col] * scale_factor).clip(upper=1.0)

    df_noncrit = pd.DataFrame(index=raw_noncrit.index)
    if "timestamp" in raw_noncrit.columns:
        df_noncrit["timestamp"] = raw_noncrit["timestamp"]
    for col in cols_noncrit:
        df_noncrit[col] = (raw_buildups[col] * scale_factor).clip(upper=1.0)

    return df_crit, df_noncrit


def _append_dtc_history(module: str, source_id: str, peak_ts: str, triggers: list) -> None:
    import datetime
    DTC_HISTORY.parent.mkdir(parents=True, exist_ok=True)
    try:
        entries = json.loads(DTC_HISTORY.read_text()) if DTC_HISTORY.exists() else []
    except Exception:
        entries = []
    entries.append({
        "run_ts":    datetime.datetime.utcnow().isoformat(),
        "module":    module,
        "source_id": source_id,
        "peak_ts":   peak_ts,
        "triggers":  triggers,
    })
    if len(entries) > _DTC_HISTORY_MAX:
        entries = entries[-_DTC_HISTORY_MAX:]
    DTC_HISTORY.write_text(json.dumps(entries, indent=2))


def _run_dtc_pipeline(module: str, source_id: str, peak_ts: str) -> dict:
    import plotly.express as px

    svc = _dtc_services.get(module)
    if svc is None:
        return {"error": f"No DTC models loaded for module '{module}'. Check DTC/artifacts/{module}/."}

    peak_datetime = pd.to_datetime(peak_ts)
    bronze_df     = _fetch_traceback(source_id, module, peak_datetime)

    if bronze_df.empty:
        return {"error": f"No Bronze traceback data found for {source_id} / {module} at {peak_ts}."}

    msg_map     = _msg_maps.get(module, {})
    diagnostics = {"models_loaded": len(svc.models), "skipped_dtcs": {}}
    for dtc_code in svc.models:
        missing = [f for f in svc.configs[dtc_code]["features"] if f not in bronze_df.columns]
        if missing:
            diagnostics["skipped_dtcs"][dtc_code] = missing

    raw_results      = svc.analyze_window(bronze_df)
    df_crit, df_noncrit = _smart_attribution(
        raw_results["critical"], raw_results["non_critical"]
    )

    triggers: list = []
    for col in (c for c in df_crit.columns    if c != "timestamp"):
        if df_crit[col].max() >= 0.99:
            triggers.append({"code": col, "severity": "CRITICAL", "message": msg_map.get(col, "Unknown Critical Fault")})
    for col in (c for c in df_noncrit.columns if c != "timestamp"):
        if df_noncrit[col].max() >= 0.99:
            triggers.append({"code": col, "severity": "WARNING",  "message": msg_map.get(col, "Unknown Warning")})

    def _render(df: pd.DataFrame, title: str, palette: list) -> dict | None:
        cols = [c for c in df.columns if c != "timestamp"]
        if df.empty or not cols:
            return None
        melted = df.melt(id_vars=["timestamp"], value_vars=cols, var_name="DTC_Code", value_name="Risk_Level")
        fig = px.line(melted, x="timestamp", y="Risk_Level", color="DTC_Code",
                      title=title, color_discrete_sequence=palette)
        fig.add_hline(y=1.0, line_dash="dash", line_color="red", annotation_text="100% Failure Trigger")
        fig.update_yaxes(range=[0, 1.1])
        fig.update_layout(
            template="plotly_white",
            margin=dict(l=20, r=20, t=40, b=20),
            paper_bgcolor="rgba(0,0,0,0)",
            plot_bgcolor="rgba(0,0,0,0)",
        )
        return json.loads(fig.to_json())

    result = {
        "success":          True,
        "triggers":         triggers,
        "diagnostics":      diagnostics,
        "critical_plot":    _render(df_crit,    "Critical Fault Maturation",     px.colors.qualitative.Set1),
        "non_critical_plot":_render(df_noncrit, "Non-Critical Fault Maturation", px.colors.qualitative.Pastel1),
    }
    _append_dtc_history(module, source_id, peak_ts, triggers)
    return result


@app.get("/health")
def health() -> dict:
    return {
        "status":         "DTC Service Online",
        "port":           8007,
        "modules_loaded": list(_dtc_services.keys()),
    }


@app.get("/api/dtc/analyze")
async def analyze_dtc(module: str, source_id: str, peak_ts: str) -> dict:
    try:
        return await asyncio.to_thread(_run_dtc_pipeline, module, source_id, peak_ts)
    except Exception as e:
        return {"error": f"DTC pipeline failed: {str(e)}"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8007)
