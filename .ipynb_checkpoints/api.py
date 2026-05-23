import asyncio
import json
import pickle
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

ROOT          = Path(__file__).resolve().parents[1]
BRONZE_ROOT   = ROOT / "data" / "delta" / "bronze"
SILVER_ROOT   = ROOT / "data" / "delta" / "silver"
GOLD_ROOT     = ROOT / "data" / "delta" / "gold" / "vehicle_health"
ALERTS_ROOT   = ROOT / "data" / "delta" / "gold" / "alerts"
VEHICLE_CACHE = ROOT / "gold_service" / "state" / "vehicle_cache.pkl"
PIPELINE_CFG  = ROOT / "config" / "pipeline_config.json"
DTC_HISTORY   = ROOT / "data" / "dtc_history.json"

_pipeline_cfg = json.loads(PIPELINE_CFG.read_text()) if PIPELINE_CFG.exists() else {}
MODULES       = _pipeline_cfg.get("enabled_modules", ["engine", "transmission", "battery", "body", "tyre"])
WEIGHTS       = _pipeline_cfg.get("module_weights", {})
_total_w      = sum(WEIGHTS.get(m, 0.0) for m in MODULES)
NORM_WEIGHTS  = (
    {m: WEIGHTS.get(m, 0.0) / _total_w for m in MODULES}
    if _total_w > 0
    else {m: 1.0 / len(MODULES) for m in MODULES}
)

_fleet_cache: dict = {}
_heartbeat: dict = {
    "seq": 0,
    "layers": {
        "bronze": {"seq": 0, "max_ts": ""},
        "silver": {"seq": 0, "max_ts": ""},
        "gold":   {"seq": 0, "max_ts": ""},
        "alerts": {"seq": 0, "max_ts": ""},
    },
}

app = FastAPI(title="Analytics Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _lttb(timestamps: list, values: list, n_out: int) -> tuple[list, list]:
    n = len(timestamps)
    if n <= n_out or n_out < 3:
        return timestamps, values
    result_idx = [0]
    bucket_size = (n - 2) / (n_out - 2)
    a = 0
    for i in range(n_out - 2):
        avg_start = int((i + 1) * bucket_size) + 1
        avg_end   = min(int((i + 2) * bucket_size) + 1, n)
        avg_count = avg_end - avg_start
        avg_x     = (avg_start + avg_end - 1) / 2.0
        avg_y     = sum(values[avg_start:avg_end]) / avg_count
        b_start   = int(i * bucket_size) + 1
        b_end     = int((i + 1) * bucket_size) + 1
        max_area  = -1.0
        max_idx   = b_start
        ax, ay    = float(a), values[a]
        for j in range(b_start, b_end):
            area = abs((ax - avg_x) * (values[j] - ay) - (ax - float(j)) * (avg_y - ay))
            if area > max_area:
                max_area = area
                max_idx  = j
        result_idx.append(max_idx)
        a = max_idx
    result_idx.append(n - 1)
    return [timestamps[i] for i in result_idx], [values[i] for i in result_idx]


def _envelope(timestamps: list, values: list, n_bins: int) -> list:
    n = len(timestamps)
    if n == 0:
        return []
    bin_size = max(n / n_bins, 1)
    result = []
    for i in range(n_bins):
        s = int(i * bin_size)
        e = min(int((i + 1) * bin_size), n)
        if s >= e:
            break
        bucket = values[s:e]
        result.append({
            "ts":   timestamps[s + (e - s) // 2],
            "min":  min(bucket),
            "mean": sum(bucket) / len(bucket),
            "max":  max(bucket),
        })
    return result


def _read_delta(
    path: Path,
    ts_col: str,
    source_id: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    columns: Optional[list] = None,
) -> pd.DataFrame:
    if not path.exists():
        return pd.DataFrame()
    try:
        from deltalake import DeltaTable
        import pyarrow.compute as pc
        dt   = DeltaTable(path.as_posix())
        ds   = dt.to_pyarrow_dataset()
        expr = None
        if source_id:
            expr = pc.equal(pc.field("source_id"), source_id)
        if start:
            cmp  = pc.greater_equal(pc.field(ts_col), start[:19])
            expr = cmp if expr is None else pc.and_(expr, cmp)
        if end:
            cmp  = pc.less_equal(pc.field(ts_col), end[:19])
            expr = cmp if expr is None else pc.and_(expr, cmp)
        tbl = ds.to_table(filter=expr, columns=columns)
        return tbl.to_pandas()
    except Exception:
        return pd.DataFrame()


def _max_ts_in_table(path: Path, ts_col: str) -> Optional[str]:
    if not path.exists():
        return None
    try:
        from deltalake import DeltaTable
        dt  = DeltaTable(path.as_posix())
        ds  = dt.to_pyarrow_dataset()
        tbl = ds.to_table(columns=[ts_col])
        if len(tbl) == 0:
            return None
        df     = tbl.to_pandas()
        max_ts = df[ts_col].max()
        return str(max_ts)[:19] if not pd.isna(max_ts) else None
    except Exception:
        return None


def _window_from_max(path: Path, ts_col: str, hours: int) -> tuple[Optional[str], Optional[str]]:
    max_ts = _max_ts_in_table(path, ts_col)
    if max_ts is None:
        return None, None
    end_dt   = pd.to_datetime(max_ts)
    start_dt = end_dt - pd.Timedelta(hours=hours)
    return str(start_dt)[:19], max_ts


def _sync_load_fleet_cache() -> dict:
    if not VEHICLE_CACHE.exists():
        return {}
    try:
        with open(VEHICLE_CACHE, "rb") as f:
            return pickle.load(f)
    except Exception:
        return {}


def _sync_update_heartbeat() -> None:
    checks = [
        ("bronze", BRONZE_ROOT / MODULES[0] if MODULES else BRONZE_ROOT, "timestamp"),
        ("silver", SILVER_ROOT / MODULES[0] if MODULES else SILVER_ROOT, "inference_ts"),
        ("gold",   GOLD_ROOT,                                             "gold_window_ts"),
        ("alerts", ALERTS_ROOT,                                           "last_updated_ts"),
    ]
    for layer, path, ts_col in checks:
        if not path.exists():
            continue
        max_ts = _max_ts_in_table(path, ts_col)
        if max_ts and max_ts != _heartbeat["layers"][layer]["max_ts"]:
            _heartbeat["layers"][layer]["max_ts"] = max_ts
            _heartbeat["layers"][layer]["seq"]    += 1
            _heartbeat["seq"]                      += 1


async def _cache_loop() -> None:
    global _fleet_cache
    while True:
        _fleet_cache = await asyncio.to_thread(_sync_load_fleet_cache)
        await asyncio.sleep(2)


async def _heartbeat_loop() -> None:
    while True:
        await asyncio.to_thread(_sync_update_heartbeat)
        await asyncio.sleep(2)


@app.on_event("startup")
async def _startup() -> None:
    global _fleet_cache
    _fleet_cache = await asyncio.to_thread(_sync_load_fleet_cache)
    asyncio.create_task(_cache_loop())
    asyncio.create_task(_heartbeat_loop())


@app.get("/health")
def health() -> dict:
    return {"status": "Analytics Service Online", "port": 8008}


@app.get("/api/heartbeat")
def heartbeat() -> dict:
    return _heartbeat


# ── FLEET ─────────────────────────────────────────────────────────────────────

@app.get("/api/fleet/current-status")
def fleet_current_status() -> dict:
    result = []
    for sim_id, modules in _fleet_cache.items():
        mod_health = {m: round(float(s.get("health", 100.0)), 2) for m, s in modules.items()}
        weighted   = sum(NORM_WEIGHTS.get(m, 0.0) * h for m, h in mod_health.items())
        result.append({
            "sim_id":         sim_id,
            "vehicle_health": round(weighted, 2),
            "modules":        mod_health,
        })
    result.sort(key=lambda x: x["vehicle_health"])
    return {"vehicles": result, "count": len(result)}


@app.get("/api/fleet/health-trend")
def fleet_health_trend(
    hours: int = Query(default=24, ge=1, le=720),
    n_out: int = Query(default=200, ge=10, le=1000),
) -> dict:
    start, end = _window_from_max(GOLD_ROOT, "gold_window_ts", hours)
    df = _read_delta(
        GOLD_ROOT, "gold_window_ts",
        start=start, end=end,
        columns=["source_id", "gold_window_ts", "vehicle_health_score"],
    )
    if df.empty:
        return {"vehicles": []}
    df.sort_values("gold_window_ts", inplace=True)
    vehicles = []
    for sim_id, grp in df.groupby("source_id"):
        ts   = grp["gold_window_ts"].astype(str).tolist()
        vals = grp["vehicle_health_score"].astype(float).tolist()
        ts, vals = _lttb(ts, vals, n_out)
        vehicles.append({"sim_id": sim_id, "ts": ts, "health": vals})
    return {"vehicles": vehicles}


@app.get("/api/fleet/alerts-summary")
def fleet_alerts_summary() -> dict:
    df = _read_delta(
        ALERTS_ROOT, "last_updated_ts",
        columns=["alert_id", "source_id", "module", "status",
                 "peak_anomaly_ts", "max_composite_score", "alert_start_ts"],
    )
    if df.empty:
        return {"open_count": 0, "closed_count": 0, "open": [], "closed": []}
    for col in df.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
        df[col] = df[col].astype(str)
    df.fillna("", inplace=True)
    open_df   = df[df["status"] == "OPEN"].sort_values("peak_anomaly_ts", ascending=False)
    closed_df = df[df["status"] == "CLOSED"].sort_values("peak_anomaly_ts", ascending=False).head(50)
    return {
        "open_count":   len(open_df),
        "closed_count": len(df[df["status"] == "CLOSED"]),
        "open":         open_df.to_dict(orient="records"),
        "closed":       closed_df.to_dict(orient="records"),
    }


# ── VEHICLE ───────────────────────────────────────────────────────────────────

@app.get("/api/vehicle/{sim_id}/profile")
def vehicle_profile(sim_id: str) -> dict:
    state        = _fleet_cache.get(sim_id, {})
    mod_health   = {}
    mod_features = {}
    for mod, s in state.items():
        mod_health[mod] = round(float(s.get("health", 100.0)), 2)
        try:
            mod_features[mod] = json.loads(s.get("feats", "{}"))
        except Exception:
            mod_features[mod] = {}
    weighted = sum(NORM_WEIGHTS.get(m, 0.0) * h for m, h in mod_health.items())
    return {
        "sim_id":         sim_id,
        "vehicle_health": round(weighted, 2),
        "modules":        mod_health,
        "top_features":   mod_features,
    }


@app.get("/api/vehicle/{sim_id}/gold-history")
def vehicle_gold_history(
    sim_id: str,
    hours:  int = Query(default=24, ge=1, le=720),
    n_out:  int = Query(default=200, ge=10, le=1000),
) -> dict:
    start, end = _window_from_max(GOLD_ROOT, "gold_window_ts", hours)
    cols = ["gold_window_ts", "vehicle_health_score"] + [f"{m}_contrib" for m in MODULES]
    df = _read_delta(GOLD_ROOT, "gold_window_ts", source_id=sim_id, start=start, end=end, columns=cols)
    if df.empty:
        return {"sim_id": sim_id, "data": []}
    df.sort_values("gold_window_ts", inplace=True)
    ts   = df["gold_window_ts"].astype(str).tolist()
    vals = df["vehicle_health_score"].astype(float).tolist()
    ts, _ = _lttb(ts, vals, n_out)
    ts_set     = set(ts)
    df_out     = df[df["gold_window_ts"].astype(str).isin(ts_set)].copy()
    for col in df_out.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
        df_out[col] = df_out[col].astype(str)
    return {"sim_id": sim_id, "data": df_out.to_dict(orient="records")}


@app.get("/api/vehicle/{sim_id}/silver-history/{module}")
def vehicle_silver_history(
    sim_id: str,
    module: str,
    hours:  int = Query(default=24, ge=1, le=720),
    n_out:  int = Query(default=200, ge=10, le=1000),
) -> dict:
    path = SILVER_ROOT / module
    start, end = _window_from_max(path, "inference_ts", hours)
    df = _read_delta(
        path, "inference_ts", source_id=sim_id, start=start, end=end,
        columns=["inference_ts", "health_score", "severity", "composite_score"],
    )
    if df.empty:
        return {"sim_id": sim_id, "module": module, "data": []}
    df.sort_values("inference_ts", inplace=True)
    for col in df.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
        df[col] = df[col].astype(str)
    ts   = df["inference_ts"].tolist()
    vals = df["health_score"].astype(float).tolist()
    ts, _ = _lttb(ts, vals, n_out)
    ts_set = set(ts)
    df_out = df[df["inference_ts"].isin(ts_set)]
    return {"sim_id": sim_id, "module": module, "data": df_out.to_dict(orient="records")}


@app.get("/api/vehicle/{sim_id}/alerts")
def vehicle_alerts(
    sim_id: str,
    offset: int = Query(default=0, ge=0),
    limit:  int = Query(default=50, ge=1, le=200),
) -> dict:
    df = _read_delta(
        ALERTS_ROOT, "last_updated_ts", source_id=sim_id,
        columns=["alert_id", "source_id", "module", "status", "alert_start_ts",
                 "alert_end_ts", "peak_anomaly_ts", "max_composite_score", "top_10_features"],
    )
    if df.empty:
        return {"sim_id": sim_id, "total": 0, "data": []}
    for col in df.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
        df[col] = df[col].astype(str)
    df.fillna("", inplace=True)
    df.sort_values("peak_anomaly_ts", ascending=False, inplace=True)
    total = len(df)
    page  = df.iloc[offset: offset + limit]
    return {"sim_id": sim_id, "total": total, "data": page.to_dict(orient="records")}


# ── MODULE ─────────────────────────────────────────────────────────────────────

@app.get("/api/module/{module}/fleet-health")
def module_fleet_health(module: str) -> dict:
    result = []
    for sim_id, modules in _fleet_cache.items():
        state = modules.get(module, {})
        result.append({
            "sim_id": sim_id,
            "health": round(float(state.get("health", 100.0)), 2),
        })
    result.sort(key=lambda x: x["health"])
    return {"module": module, "vehicles": result}


@app.get("/api/module/{module}/sensor-history/{sim_id}")
def module_sensor_history(
    module:  str,
    sim_id:  str,
    sensor:  str = Query(...),
    hours:   int = Query(default=24, ge=1, le=720),
    n_out:   int = Query(default=300, ge=10, le=1000),
    mode:    str = Query(default="lttb"),
    n_bins:  int = Query(default=100, ge=10, le=500),
) -> dict:
    path = BRONZE_ROOT / module
    start, end = _window_from_max(path, "timestamp", hours)
    df = _read_delta(path, "timestamp", source_id=sim_id, start=start, end=end, columns=["timestamp", sensor])
    if df.empty or sensor not in df.columns:
        return {"sim_id": sim_id, "module": module, "sensor": sensor, "ts": [], "values": []}
    df.sort_values("timestamp", inplace=True)
    df.dropna(subset=[sensor], inplace=True)
    ts   = df["timestamp"].astype(str).tolist()
    vals = df[sensor].astype(float).tolist()
    if mode == "envelope":
        return {
            "sim_id": sim_id, "module": module, "sensor": sensor,
            "mode": "envelope", "data": _envelope(ts, vals, n_bins),
        }
    ts, vals = _lttb(ts, vals, n_out)
    return {"sim_id": sim_id, "module": module, "sensor": sensor, "mode": "lttb", "ts": ts, "values": vals}


@app.get("/api/module/{module}/sensor-fleet-history")
def module_sensor_fleet_history(
    module: str,
    sensor: str = Query(...),
    hours:  int = Query(default=24, ge=1, le=720),
    n_bins: int = Query(default=100, ge=10, le=500),
) -> dict:
    path = BRONZE_ROOT / module
    start, end = _window_from_max(path, "timestamp", hours)
    df = _read_delta(path, "timestamp", start=start, end=end, columns=["timestamp", sensor])
    if df.empty or sensor not in df.columns:
        return {"module": module, "sensor": sensor, "data": []}
    df.sort_values("timestamp", inplace=True)
    df.dropna(subset=[sensor], inplace=True)
    ts   = df["timestamp"].astype(str).tolist()
    vals = df[sensor].astype(float).tolist()
    return {"module": module, "sensor": sensor, "data": _envelope(ts, vals, n_bins)}


@app.get("/api/module/{module}/sensor-stats/{sim_id}")
def module_sensor_stats(
    module: str,
    sim_id: str,
    hours:  int = Query(default=24, ge=1, le=720),
) -> dict:
    path = BRONZE_ROOT / module
    start, end = _window_from_max(path, "timestamp", hours)
    df = _read_delta(path, "timestamp", source_id=sim_id, start=start, end=end)
    if df.empty:
        return {"sim_id": sim_id, "module": module, "stats": {}}
    exclude = {"source_id", "timestamp", "ingest_ts", "writer_ts", "row_hash", "date"}
    stats = {}
    for col in df.columns:
        if col in exclude:
            continue
        try:
            s = df[col].dropna().astype(float)
            if len(s) == 0:
                continue
            stats[col] = {
                "min":   round(float(s.min()), 4),
                "max":   round(float(s.max()), 4),
                "mean":  round(float(s.mean()), 4),
                "p50":   round(float(s.quantile(0.50)), 4),
                "p95":   round(float(s.quantile(0.95)), 4),
                "std":   round(float(s.std()), 4),
                "count": int(len(s)),
            }
        except Exception:
            pass
    return {"sim_id": sim_id, "module": module, "stats": stats}


@app.get("/api/module/{module}/feature-importance")
def module_feature_importance(
    module: str,
    sim_id: Optional[str] = Query(default=None),
    limit:  int           = Query(default=10, ge=1, le=50),
    hours:  int           = Query(default=24, ge=1, le=720),
) -> dict:
    path = SILVER_ROOT / module
    start, end = _window_from_max(path, "inference_ts", hours)
    df = _read_delta(
        path, "inference_ts",
        source_id=sim_id, start=start, end=end,
        columns=["inference_ts", "top_features"],
    )
    if df.empty or "top_features" not in df.columns:
        return {"module": module, "features": []}
    counts: dict = {}
    for raw in df["top_features"].dropna():
        try:
            feats = json.loads(raw) if isinstance(raw, str) else raw
            if isinstance(feats, dict):
                for name, score in feats.items():
                    counts[name] = counts.get(name, 0.0) + float(score)
            elif isinstance(feats, list):
                for item in feats:
                    if isinstance(item, dict):
                        name  = item.get("feature") or item.get("name", "")
                        score = float(item.get("score", item.get("importance", 1.0)))
                        if name:
                            counts[name] = counts.get(name, 0.0) + score
        except Exception:
            pass
    sorted_feats = sorted(counts.items(), key=lambda x: x[1], reverse=True)[:limit]
    return {
        "module":   module,
        "features": [{"name": n, "score": round(s, 4)} for n, s in sorted_feats],
    }


# ── DTC ───────────────────────────────────────────────────────────────────────

@app.get("/api/dtc/history")
def dtc_history(
    offset: int = Query(default=0, ge=0),
    limit:  int = Query(default=50, ge=1, le=200),
) -> dict:
    if not DTC_HISTORY.exists():
        return {"total": 0, "data": []}
    try:
        entries = json.loads(DTC_HISTORY.read_text())
    except Exception:
        return {"total": 0, "data": []}
    entries = list(reversed(entries))
    total = len(entries)
    return {"total": total, "data": entries[offset: offset + limit]}


@app.get("/api/dtc/latest")
def dtc_latest() -> dict:
    if not DTC_HISTORY.exists():
        return {"entry": None}
    try:
        entries = json.loads(DTC_HISTORY.read_text())
        return {"entry": entries[-1] if entries else None}
    except Exception:
        return {"entry": None}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api:app", host="127.0.0.1", port=8008, reload=True)
