import os
import asyncio
import pandas as pd
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from deltalake import DeltaTable

# --- Paths & Constants ---
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
SILVER_ROOT = os.path.join(PROJECT_ROOT, "data", "delta", "silver")
GOLD_ROOT = os.path.join(PROJECT_ROOT, "data", "delta", "gold", "vehicle_health")

try:
    from src import config as gold_config
    GOLD_ENABLED_MODULES = gold_config.ENABLED_MODULES
    GOLD_WEIGHTS = gold_config.NORMALIZED_WEIGHTS
    GOLD_PENALTIES = gold_config.TIER_1_PENALTIES
except ImportError:
    GOLD_ENABLED_MODULES = ["engine", "transmission", "battery", "body", "tyre"]
    GOLD_WEIGHTS = {"engine": 0.35, "transmission": 0.25, "battery": 0.20, "body": 0.10, "tyre": 0.10}
    GOLD_PENALTIES = {"engine": 30.0, "transmission": 25.0, "battery": 20.0}

# --- Cache ---
GOLD_METRICS_CACHE = {
    "active_sims": [],
    "total_gold_rows": 0,
    "processing_lags": {mod: 0 for mod in GOLD_ENABLED_MODULES}
}

# --- App Definition ---
app = FastAPI(title="Gold Service Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Background Logic ---
def _sync_update_metrics():
    """Synchronous file I/O operations executed in a separate thread"""
    global GOLD_METRICS_CACHE
    try:
        silver_counts = {m: 0 for m in GOLD_ENABLED_MODULES}
        for mod in GOLD_ENABLED_MODULES:
            silver_path = Path(SILVER_ROOT) / mod
            if silver_path.exists():
                try:
                    if DeltaTable.is_deltatable(silver_path.as_posix()):
                        silver_counts[mod] = DeltaTable(silver_path.as_posix()).to_pyarrow_dataset().count_rows()
                except Exception:
                    pass

        gold_count = 0
        active_sims = set()
        gold_path = Path(GOLD_ROOT)
        if gold_path.exists():
            try:
                if DeltaTable.is_deltatable(gold_path.as_posix()):
                    dt = DeltaTable(gold_path.as_posix())
                    ds = dt.to_pyarrow_dataset()
                    gold_count = ds.count_rows()
                    tbl = ds.to_table(columns=["source_id"])
                    active_sims = set(tbl.column("source_id").to_pylist())
            except Exception:
                pass

        GOLD_METRICS_CACHE["active_sims"] = sorted(list(active_sims))
        GOLD_METRICS_CACHE["total_gold_rows"] = gold_count
        GOLD_METRICS_CACHE["processing_lags"] = {mod: max(0, silver_counts[mod] - gold_count) for mod in GOLD_ENABLED_MODULES}

    except Exception as e:
        print(f"Gold metrics loop failed: {e}")

async def update_gold_metrics_loop():
    while True:
        await asyncio.to_thread(_sync_update_metrics)
        await asyncio.sleep(2)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(update_gold_metrics_loop())

# --- Endpoints ---
@app.get("/api/gold/metrics")
def get_gold_metrics():
    return GOLD_METRICS_CACHE

@app.get("/api/gold/config")
def get_gold_config():
    return {
        "enabled_modules": GOLD_ENABLED_MODULES,
        "default_weights": GOLD_WEIGHTS,
        "tier_1_penalties": GOLD_PENALTIES
    }

@app.get("/api/gold/history/{sim_id}")
def get_gold_history(sim_id: str):
    gold_path = Path(GOLD_ROOT)
    if not gold_path.exists():
        return {"data": []}
    try:
        if not DeltaTable.is_deltatable(gold_path.as_posix()):
            return {"data": []}
        df = DeltaTable(gold_path.as_posix()).to_pyarrow_dataset().to_table().to_pandas()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    if df.empty or 'source_id' not in df.columns:
        return {"data": []}

    if sim_id.upper() != "ALL":
        df = df[df['source_id'] == sim_id]

    if df.empty:
        return {"data": []}

    if 'gold_window_ts' in df.columns:
        df['gold_window_ts'] = pd.to_datetime(df['gold_window_ts'])
        df = df.sort_values('gold_window_ts', ascending=True)
        if sim_id.upper() != "ALL":
            df = df.drop_duplicates(subset=['gold_window_ts'], keep='last')

    df = df.fillna(0)
    for col in df.select_dtypes(include=['datetime64[ns]', 'datetime64[ns, UTC]']).columns:
        df[col] = df[col].astype(str)

    return {"data": df.tail(1000).to_dict(orient="records")}

if __name__ == "__main__":
    import uvicorn
    # Gold runs on port 8003
    uvicorn.run("api:app", host="127.0.0.1", port=8003, reload=True)