"""
Demo Seeder — pre-populates 15 days of data across every pipeline layer.

Uses the EXACT SAME code as the live pipeline:
  Silver   → inference_service/src/ml_engine.MLEngine.process_batch()
  Gold     → gold_service/src/aggregator.HealthAggregator
             gold_service/src/state_manager.GoldStateManager
  Alerts   → alerts_service/src/alert_engine.AlertEngine
             alerts_service/src/state_manager.AlertStateManager

All tunable parameters (weights, penalties, score deltas) live in
  config/pipeline_config.json
which both this seeder and the live services read — so they can never diverge.

PRE-REQUISITE:
  Vehicle CSV files must exist under  data/vehicles/{sim_id}/*.csv
  If missing: run  extras/Copy_raw_vehicles_csv.ipynb  first.

Usage:  python tools/demo_seeder.py [--days 15]
After:  python tools/start_demo.py
"""

import sys
import os
import gc
import json
import pickle
import hashlib
import shutil
import argparse
import time
from pathlib import Path
from datetime import datetime, timezone

import pandas as pd
import pyarrow as pa
from deltalake import write_deltalake, DeltaTable

ROOT = Path(__file__).resolve().parents[1]

BRONZE_ROOT      = ROOT / "data"              / "delta" / "bronze"
SILVER_ROOT      = ROOT / "data"              / "delta" / "silver"
GOLD_ROOT        = ROOT / "data"              / "delta" / "gold" / "vehicle_health"
ALERTS_ROOT      = ROOT / "data"              / "delta" / "gold" / "alerts"
VEHICLES_ROOT    = ROOT / "data"              / "vehicles"
INF_STATE_DIR    = ROOT / "inference_service" / "state"
GOLD_STATE_DIR   = ROOT / "gold_service"      / "state"
ALERTS_STATE_DIR = ROOT / "alerts_service"    / "state"
REPLAY_CKPT_DIR  = ROOT / "replay"            / "checkpoints"
WRITER_CKPT_DIR  = ROOT / "data"              / "checkpoints" / "writer"
CONTRACTS_FILE   = ROOT / "contracts"         / "master.json"
PIPELINE_CFG     = ROOT / "config"            / "pipeline_config.json"
REPLAY_CFG       = ROOT / "replay"            / "config" / "replay_config.json"

BASE_DATE = pd.Timestamp("2024-07-05", tz="UTC")


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _find_csv(sim_dir: Path, file_pattern: str) -> Path | None:
    matches = list(sim_dir.glob(file_pattern))
    return matches[0] if len(matches) == 1 else None


def _row_hash(sim_id: str, module: str, ingest_ts: str) -> str:
    return hashlib.sha256(f"{sim_id}|{module}|{ingest_ts}".encode()).hexdigest()


# ── Service class importers ───────────────────────────────────────────────────
# Each service has its own  src/  package.  We must isolate the imports so that
# gold_service/src/config.py  and  alerts_service/src/config.py  don't collide
# in sys.modules.  Strategy: clear src.* from the module cache before each
# import block, then let Python re-resolve from the freshly-inserted sys.path
# entry.  After import the class objects hold direct references to their own
# config module objects — those bindings survive the subsequent cache clear.

def _clear_src_cache() -> None:
    for key in list(sys.modules.keys()):
        if key == "src" or key.startswith("src."):
            del sys.modules[key]


def _import_inference_classes():
    _clear_src_cache()
    inf_dir = str(ROOT / "inference_service")
    if inf_dir not in sys.path:
        sys.path.insert(0, inf_dir)
    from src.ml_engine import MLEngine
    return MLEngine


def _import_gold_classes():
    _clear_src_cache()
    gold_dir = str(ROOT / "gold_service")
    if gold_dir in sys.path:
        sys.path.remove(gold_dir)
    sys.path.insert(0, gold_dir)
    from src.aggregator   import HealthAggregator
    from src.state_manager import GoldStateManager
    _clear_src_cache()
    return HealthAggregator, GoldStateManager


def _import_alerts_classes():
    _clear_src_cache()
    alerts_dir = str(ROOT / "alerts_service")
    if alerts_dir in sys.path:
        sys.path.remove(alerts_dir)
    sys.path.insert(0, alerts_dir)
    from src.alert_engine  import AlertEngine
    from src.state_manager import AlertStateManager
    _clear_src_cache()
    return AlertEngine, AlertStateManager


# ── Minimal in-memory StateManager for inference seeding ─────────────────────

class SeedInferenceState:
    """
    Same interface as inference_service/src/state_manager.StateManager but
    holds everything in memory — no disk I/O during the seeding loop.
    Results are written to disk at the end of each module.
    """

    def __init__(self, module: str):
        self.module      = module
        self.checkpoints: dict = {}
        self.ml_state:    dict = {}

    def get_last_timestamp(self, sim_id: str) -> str:
        return self.checkpoints.get(f"{sim_id}_{self.module}", "1970-01-01T00:00:00.000Z")

    def update_checkpoint(self, sim_id: str, ts: str) -> None:
        self.checkpoints[f"{sim_id}_{self.module}"] = ts

    def get_ml_state(self, sim_id: str) -> dict:
        key = f"{sim_id}_{self.module}"
        if key not in self.ml_state:
            self.ml_state[key] = {
                "ema_error": 0.0,
                "persistence_counter": 0,
                "last_window_data": None,
            }
        return self.ml_state[key]

    def update_ml_state(self, sim_id: str, ema: float, pers: int, window) -> None:
        self.ml_state[f"{sim_id}_{self.module}"] = {
            "ema_error": float(ema),
            "persistence_counter": int(pers),
            "last_window_data": window,
        }

    def log_alert(self, sim_id: str, level: str, msg: str) -> None:
        pass


# ── Pre-flight check ──────────────────────────────────────────────────────────

def preflight(vehicles: list, modules: list, contracts: dict) -> bool:
    ok = True
    for sim in vehicles:
        sim_dir = VEHICLES_ROOT / sim
        if not sim_dir.is_dir():
            print(f"  MISSING  data/vehicles/{sim}/  — run extras/Copy_raw_vehicles_csv.ipynb")
            ok = False
            continue
        for mod in modules:
            pattern = contracts["modules"][mod]["file_pattern"]
            if _find_csv(sim_dir, pattern) is None:
                print(f"  MISSING  data/vehicles/{sim}/{pattern}")
                ok = False
    return ok


# ── Phase 1: Bronze + Silver (one module, one vehicle at a time) ──────────────

def seed_bronze_and_silver(
    module: str,
    vehicles: list,
    contracts: dict,
    cutoff_ts: pd.Timestamp,
) -> None:

    MLEngine = _import_inference_classes()
    pattern  = contracts["modules"][module]["file_pattern"]

    bronze_path = BRONZE_ROOT / module
    silver_path = SILVER_ROOT / module

    for p in (bronze_path, silver_path):
        if p.exists():
            shutil.rmtree(p)

    seed_state = SeedInferenceState(module)
    ml         = MLEngine(seed_state, module)

    BATCH_SIZE   = 60
    first_bronze = True
    first_silver = True

    for sim_id in vehicles:
        sim_dir  = VEHICLES_ROOT / sim_id
        csv_path = _find_csv(sim_dir, pattern)
        if csv_path is None:
            print(f"    [{module.upper()}] {sim_id}: no CSV — skipped")
            continue

        t0 = time.time()

        df_full = pd.read_csv(csv_path, low_memory=False)
        df_full["_ts"] = pd.to_datetime(df_full["timestamp"], utc=True)

        seed_mask = df_full["_ts"] < cutoff_ts
        df_seed   = df_full[seed_mask].copy().reset_index(drop=True)

        if df_seed.empty:
            del df_full, df_seed
            gc.collect()
            print(f"    [{module.upper()}] {sim_id}: no rows before cutoff — skipped")
            continue

        n_seed             = len(df_seed)
        last_seed_row_idx  = int(seed_mask.sum()) - 1

        ts_strs            = df_seed["_ts"].dt.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")
        df_seed["source_id"] = sim_id
        df_seed["ingest_ts"] = ts_strs.values
        df_seed["writer_ts"] = ts_strs.values
        df_seed["row_hash"]  = [_row_hash(sim_id, module, t) for t in ts_strs]
        df_seed["timestamp"] = ts_strs.values
        df_seed = df_seed.drop(columns=["_ts", "date"], errors="ignore")

        last_hash = _row_hash(sim_id, module, df_seed.iloc[-1]["ingest_ts"])

        del df_full
        gc.collect()

        # Write Bronze (append after first vehicle, overwrite first time)
        bronze_path.mkdir(parents=True, exist_ok=True)
        write_deltalake(
            str(bronze_path), df_seed,
            mode="overwrite" if first_bronze else "append",
            schema_mode="overwrite" if first_bronze else "merge",
        )
        first_bronze = False

        # Replay checkpoint for this vehicle + module
        REPLAY_CKPT_DIR.mkdir(parents=True, exist_ok=True)
        (REPLAY_CKPT_DIR / f"{sim_id}_{module}.json").write_text(json.dumps({
            "source_id":      f"{sim_id}_{module}",
            "last_row_index": last_seed_row_idx,
            "last_row_hash":  last_hash,
            "updated_at":     datetime.now(timezone.utc).isoformat(),
        }))

        # Inference — exact same call as inference_service/app.py
        silver_parts: list = []
        for start in range(0, n_seed, BATCH_SIZE):
            batch = df_seed.iloc[start : start + BATCH_SIZE].copy()
            try:
                out = ml.process_batch(batch, sim_id)
                if not out.empty:
                    # Override inference_ts with the original timestamp so that
                    # Gold/Alerts checkpoints (set to max(inference_ts) Day 15)
                    # correctly exclude this pre-seeded data from reprocessing.
                    out["inference_ts"] = batch["ingest_ts"].values[: len(out)]
                    silver_parts.append(out)
            except Exception as exc:
                print(f"    [{module.upper()}] {sim_id} batch @{start}: {exc}")

        del df_seed
        gc.collect()

        if silver_parts:
            silver_df = pd.concat(silver_parts, ignore_index=True)
            silver_path.mkdir(parents=True, exist_ok=True)
            write_deltalake(
                str(silver_path), silver_df,
                mode="overwrite" if first_silver else "append",
                schema_mode="overwrite" if first_silver else "merge",
            )
            first_silver = False
            seed_state.update_checkpoint(sim_id, str(silver_df["inference_ts"].max()))
            n_silver = len(silver_df)
            del silver_df
        else:
            n_silver = 0

        del silver_parts
        gc.collect()

        print(f"    [{module.upper()}] {sim_id}: {n_seed} Bronze → {n_silver} Silver  "
              f"({round(time.time() - t0, 1)}s)")

    del ml
    gc.collect()

    # Persist inference state
    INF_STATE_DIR.mkdir(parents=True, exist_ok=True)
    (INF_STATE_DIR / f"checkpoints_{module}.json").write_text(
        json.dumps(seed_state.checkpoints, indent=2)
    )
    with open(INF_STATE_DIR / f"ml_state_{module}.pkl", "wb") as fh:
        pickle.dump(seed_state.ml_state, fh)

    print(f"  [{module.upper()}] Inference state saved.")


# ── Phase 2: Gold (uses actual HealthAggregator + GoldStateManager) ───────────

def seed_gold(enabled_modules: list) -> dict:
    """Returns max inference_ts per module (used later for alert checkpoints)."""

    HealthAggregator, GoldStateManager = _import_gold_classes()

    # Re-import after cache clear so the classes bind to the gold config
    _clear_src_cache()
    gold_dir = str(ROOT / "gold_service")
    if gold_dir not in sys.path:
        sys.path.insert(0, gold_dir)
    from src.aggregator    import HealthAggregator  # noqa: F811
    from src.state_manager import GoldStateManager   # noqa: F811
    import src.config as gold_cfg

    # Clear existing gold state so GoldStateManager starts fresh
    for f in (GOLD_STATE_DIR / "checkpoints.json", GOLD_STATE_DIR / "vehicle_cache.pkl"):
        if f.exists():
            f.unlink()
    if GOLD_ROOT.exists():
        shutil.rmtree(GOLD_ROOT)
    GOLD_ROOT.mkdir(parents=True, exist_ok=True)

    state      = GoldStateManager()
    aggregator = HealthAggregator(state)

    max_inf_ts: dict = {}
    first_write = True

    print("\n[GOLD] Loading Silver tables and aggregating 5-minute windows...")

    for module in enabled_modules:
        silver_path = SILVER_ROOT / module
        if not silver_path.exists():
            print(f"  [GOLD] Silver/{module} missing — skipped")
            continue

        try:
            df = DeltaTable(str(silver_path)).to_pandas()
        except Exception as exc:
            print(f"  [GOLD] Cannot read Silver/{module}: {exc}")
            continue

        if "inference_ts" in df.columns and not df.empty:
            max_inf_ts[module] = str(df["inference_ts"].max())

        df["timestamp"]   = pd.to_datetime(df["timestamp"], utc=True)
        df["window_ts"]   = df["timestamp"].dt.floor(f"{gold_cfg.AGGREGATION_WINDOW_SEC}s")
        df["module_name"] = module  # ← matches exactly what gold_service/app.py does

        gold_records: list = []

        # Replicate EXACTLY the loop in gold_service/app.py
        for (sim_id, window_ts), group in df.groupby(["source_id", "window_ts"]):
            for _, row in group.iterrows():
                state.update_module_state(
                    sim_id=sim_id,
                    module=row["module_name"],
                    health=row["health_score"],
                    features_json=row["top_features"],
                )
            gold_records.append(aggregator.compute_gold_record(sim_id, str(window_ts)))

        del df
        gc.collect()

        if gold_records:
            gold_df = pd.DataFrame(gold_records)
            write_deltalake(
                str(GOLD_ROOT), gold_df,
                mode="overwrite" if first_write else "append",
                schema_mode="overwrite" if first_write else "merge",
            )
            first_write = False
            print(f"  [GOLD] {module}: {len(gold_records)} windows written")
            del gold_df
            gc.collect()

    # Update checkpoint to Day-15 end so live Gold service skips pre-seeded Silver
    for module, ts in max_inf_ts.items():
        state.checkpoints[module] = ts
    state.save_state()

    print(f"  [GOLD] State saved. Checkpoints: {max_inf_ts}")
    _clear_src_cache()
    return max_inf_ts


# ── Phase 3: Alerts (uses actual AlertEngine + AlertStateManager) ─────────────

def seed_alerts(enabled_modules: list, max_inf_ts: dict) -> None:

    _clear_src_cache()
    alerts_dir = str(ROOT / "alerts_service")
    if alerts_dir in sys.path:
        sys.path.remove(alerts_dir)
    sys.path.insert(0, alerts_dir)
    from src.alert_engine  import AlertEngine        # noqa: F811
    from src.state_manager import AlertStateManager  # noqa: F811

    # Clear existing alert state
    for f in (ALERTS_STATE_DIR / "checkpoints.json", ALERTS_STATE_DIR / "alert_state_cache.pkl"):
        if f.exists():
            f.unlink()
    if ALERTS_ROOT.exists():
        shutil.rmtree(ALERTS_ROOT)
    ALERTS_ROOT.mkdir(parents=True, exist_ok=True)

    state  = AlertStateManager()
    engine = AlertEngine(state)

    ALERT_SCHEMA = pa.schema([
        ("alert_id",            pa.string()),
        ("source_id",           pa.string()),
        ("module",              pa.string()),
        ("status",              pa.string()),
        ("alert_start_ts",      pa.string()),
        ("alert_end_ts",        pa.string()),
        ("peak_anomaly_ts",     pa.string()),
        ("max_composite_score", pa.float64()),
        ("top_10_features",     pa.string()),
        ("last_updated_ts",     pa.string()),
    ])

    print("\n[ALERTS] Running leaky-bucket state machine on Silver data...")

    all_silver_parts: list = []
    for module in enabled_modules:
        silver_path = SILVER_ROOT / module
        if not silver_path.exists():
            continue
        try:
            df = DeltaTable(str(silver_path)).to_pandas()
            df["module_name"] = module  # ← matches exactly what alerts_service/app.py does
            all_silver_parts.append(df)
        except Exception as exc:
            print(f"  [ALERTS] Cannot read Silver/{module}: {exc}")

    if not all_silver_parts:
        print("  [ALERTS] No Silver data — skipped")
        _clear_src_cache()
        return

    combined = pd.concat(all_silver_parts, ignore_index=True)
    del all_silver_parts
    gc.collect()

    combined["timestamp"] = pd.to_datetime(combined["timestamp"], utc=True)
    combined = combined.sort_values("timestamp", ascending=True)

    alert_updates: dict = {}

    # Replicate EXACTLY the loop in alerts_service/app.py
    for _, row in combined.iterrows():
        payload = engine.process_row(row)
        if payload:
            alert_updates[payload["alert_id"]] = payload

    del combined
    gc.collect()

    if alert_updates:
        alerts_df = pd.DataFrame(list(alert_updates.values()))
        write_deltalake(
            str(ALERTS_ROOT),
            pa.Table.from_pandas(alerts_df, schema=ALERT_SCHEMA),
            mode="append",
        )
        print(f"  [ALERTS] Written: {len(alert_updates)} alert records")
    else:
        print("  [ALERTS] No alerts fired during 15-day window")

    # Set checkpoints to Day-15 end so live alerts service skips pre-seeded Silver
    for module, ts in max_inf_ts.items():
        state.checkpoints[module] = ts
    state.save_state()

    print("  [ALERTS] State saved.")
    _clear_src_cache()


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=15)
    args = parser.parse_args()

    pipeline_cfg    = _load_json(PIPELINE_CFG)
    replay_cfg      = _load_json(REPLAY_CFG)
    contracts       = _load_json(CONTRACTS_FILE)
    enabled_modules = pipeline_cfg["enabled_modules"]
    vehicles        = replay_cfg["enabled_sims"]
    cutoff_ts       = BASE_DATE + pd.Timedelta(days=args.days)

    print("=" * 60)
    print(f"DEMO SEEDER — {args.days}-day pre-seed")
    print(f"  Vehicles  : {vehicles}")
    print(f"  Modules   : {enabled_modules}")
    print(f"  Cutoff    : {cutoff_ts.date()}  (stream starts Day {args.days + 1})")
    print("=" * 60)

    print("\nPRE-FLIGHT — verifying vehicle CSVs...")
    if not preflight(vehicles, enabled_modules, contracts):
        print(
            "\nERROR: Vehicle CSV data missing from data/vehicles/\n"
            "Run  extras/Copy_raw_vehicles_csv.ipynb  first."
        )
        sys.exit(1)
    print("  All CSVs found.\n")

    t_start = time.time()

    for module in enabled_modules:
        print(f"\n{'─' * 50}")
        print(f"MODULE: {module.upper()}")
        print(f"{'─' * 50}")
        t_mod = time.time()
        seed_bronze_and_silver(module, vehicles, contracts, cutoff_ts)
        print(f"  [{module.upper()}] Done in {round(time.time() - t_mod, 1)}s")

    max_inf_ts = seed_gold(enabled_modules)
    seed_alerts(enabled_modules, max_inf_ts)

    if WRITER_CKPT_DIR.exists():
        shutil.rmtree(WRITER_CKPT_DIR)
    WRITER_CKPT_DIR.mkdir(parents=True, exist_ok=True)
    print("\n[WRITER] Spark checkpoints cleared.")

    elapsed = round(time.time() - t_start, 1)
    print("\n" + "=" * 60)
    print(f"SEEDING COMPLETE in {elapsed}s  ({round(elapsed / 60, 1)} min)")
    print("Next:  python tools/start_demo.py")
    print("=" * 60)


if __name__ == "__main__":
    main()
