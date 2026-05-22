"""
Demo Seeder — pre-populates 15 days of data across every pipeline layer.

Designed for 280 000+ rows / vehicle / module.
Peak RAM at any point: ~200 MB regardless of dataset size.

Key memory controls:
  CHUNK_SIZE      = 20 000  rows read per CSV chunk (Bronze + Silver)
  INFERENCE_BATCH = 60      rows per LSTM forward pass
  Silver written after EACH inference batch (never accumulated)
  Alerts loads only 5 narrow columns per module (skips top_features JSON)
  Gold pre-aggregates Silver to 1 row per (vehicle, 5-min window) before
  feeding the actual HealthAggregator

Uses EXACT pipeline code:
  Silver  → inference_service/src/ml_engine.MLEngine.process_batch()
  Gold    → gold_service/src/aggregator.HealthAggregator
            gold_service/src/state_manager.GoldStateManager
  Alerts  → alerts_service/src/alert_engine.AlertEngine
            alerts_service/src/state_manager.AlertStateManager

PRE-REQUISITE:
  Vehicle CSVs must exist under  data/vehicles/{sim_id}/*.csv
  If missing: run  extras/Copy_raw_vehicles_csv.ipynb  first.

Usage:  python tools/demo_seeder.py [--days 15]
After:  python tools/start_demo.py
"""

import sys
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
REPLAY_CFG       = ROOT / "replay"            / "config"      / "replay_config.json"

BASE_DATE        = pd.Timestamp("2024-07-05", tz="UTC")
GOLD_WINDOW_SEC  = 300     # 5-min — matches gold_service/src/config.py
CHUNK_SIZE       = 20_000  # CSV rows per Bronze/Silver write cycle
INFERENCE_BATCH  = 60      # rows per LSTM forward pass
ALERT_BATCH      = 20_000  # rows per dict-iteration batch for alerts


# ── Helpers ───────────────────────────────────────────────────────────────────

def _j(p: Path) -> dict:
    return json.loads(p.read_text())


def _find_csv(sim_dir: Path, pattern: str) -> Path | None:
    m = list(sim_dir.glob(pattern))
    return m[0] if len(m) == 1 else None


def _hash(sim: str, mod: str, ts: str) -> str:
    return hashlib.sha256(f"{sim}|{mod}|{ts}".encode()).hexdigest()


def _delta_append(path: Path, df) -> None:
    """Append df to a Delta table, creating it if needed.
    Always uses mode='append' — matches the live services exactly and avoids
    the Windows delta-rs lock hang caused by overwrite→append transitions.
    Uses POSIX path string to prevent backslash issues on Windows."""
    path.mkdir(parents=True, exist_ok=True)
    write_deltalake(path.as_posix(), df, mode="append")


# ── Service class importers ───────────────────────────────────────────────────
# gold_service and alerts_service both expose a src/ package.  We clear
# src.* from sys.modules before each import block so Python resolves the
# correct config.py.  After import the class objects hold direct references
# to their own config module — those bindings survive the cache clear.

def _clr() -> None:
    for k in list(sys.modules):
        if k == "src" or k.startswith("src."):
            del sys.modules[k]


def _imp_inf():
    _clr()
    d = str(ROOT / "inference_service")
    if d not in sys.path:
        sys.path.insert(0, d)
    from src.ml_engine import MLEngine  # noqa: PLC0415
    return MLEngine


def _imp_gold():
    _clr()
    d = str(ROOT / "gold_service")
    if d in sys.path:
        sys.path.remove(d)
    sys.path.insert(0, d)
    from src.aggregator    import HealthAggregator   # noqa: PLC0415
    from src.state_manager import GoldStateManager   # noqa: PLC0415
    _clr()
    return HealthAggregator, GoldStateManager


def _imp_alerts():
    _clr()
    d = str(ROOT / "alerts_service")
    if d in sys.path:
        sys.path.remove(d)
    sys.path.insert(0, d)
    from src.alert_engine  import AlertEngine        # noqa: PLC0415
    from src.state_manager import AlertStateManager  # noqa: PLC0415
    _clr()
    return AlertEngine, AlertStateManager


# ── In-memory inference state (no disk I/O during seeding loop) ───────────────

class _Inf:
    def __init__(self, module: str):
        self.module = module
        self.checkpoints: dict = {}
        self.ml_state:    dict = {}

    def get_last_timestamp(self, sim: str) -> str:
        return self.checkpoints.get(f"{sim}_{self.module}", "1970-01-01T00:00:00.000Z")

    def update_checkpoint(self, sim: str, ts: str) -> None:
        self.checkpoints[f"{sim}_{self.module}"] = ts

    def get_ml_state(self, sim: str) -> dict:
        k = f"{sim}_{self.module}"
        if k not in self.ml_state:
            self.ml_state[k] = {"ema_error": 0.0, "persistence_counter": 0,
                                 "last_window_data": None}
        return self.ml_state[k]

    def update_ml_state(self, sim: str, ema: float, pers: int, win) -> None:
        self.ml_state[f"{sim}_{self.module}"] = {
            "ema_error": float(ema), "persistence_counter": int(pers),
            "last_window_data": win,
        }

    def log_alert(self, *_) -> None:
        pass


# ── Pre-flight ────────────────────────────────────────────────────────────────

def preflight(vehicles: list, modules: list, contracts: dict) -> bool:
    ok = True
    for sim in vehicles:
        d = VEHICLES_ROOT / sim
        if not d.is_dir():
            print(f"  MISSING  data/vehicles/{sim}/  "
                  "— run extras/Copy_raw_vehicles_csv.ipynb first")
            ok = False
            continue
        for mod in modules:
            if _find_csv(d, contracts["modules"][mod]["file_pattern"]) is None:
                print(f"  MISSING  {sim}/{contracts['modules'][mod]['file_pattern']}")
                ok = False
    return ok


# ── Phase 1 — Bronze + Silver (chunked, Silver written per-batch) ─────────────
#
# Memory budget per iteration:
#   CHUNK_SIZE rows × ~120 bytes/row   ≈  2.4 MB  (Bronze chunk)
#   write_deltalake overhead (3×)       ≈  7.2 MB
#   INFERENCE_BATCH rows × 15 cols      ≈  0.07 MB (one Silver batch)
#   Silver written immediately — never accumulated
#   MLEngine (PyTorch + GMM)            ≈ 100 MB
#   ──────────────────────────────────────────────
#   Total peak per vehicle              ≈ 110 MB

def seed_bronze_silver(module: str, vehicles: list, contracts: dict,
                       cutoff_ts: pd.Timestamp) -> None:

    MLEngine  = _imp_inf()
    pattern   = contracts["modules"][module]["file_pattern"]
    inf_st    = _Inf(module)
    ml        = MLEngine(inf_st, module)

    bp = BRONZE_ROOT / module
    sp = SILVER_ROOT / module
    for p in (bp, sp):
        if p.exists():
            shutil.rmtree(p)

    for sim in vehicles:
        csv = _find_csv(VEHICLES_ROOT / sim, pattern)
        if not csv:
            print(f"    [{module.upper()}] {sim}: no CSV — skipped")
            continue

        t0 = time.time()
        cum_idx     = 0   # running row index in the full (unsliced) CSV
        seed_total  = 0
        rp_idx      = -1
        rp_hash     = ""
        last_its    = ""

        for raw in pd.read_csv(csv, chunksize=CHUNK_SIZE, low_memory=False):
            raw["_ts"] = pd.to_datetime(raw["timestamp"], utc=True)
            part = raw[raw["_ts"] < cutoff_ts]

            if part.empty:
                cum_idx += len(raw)
                del raw, part
                gc.collect()
                break

            part = part.copy().reset_index(drop=True)
            n = len(part)

            tss = part["_ts"].dt.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")
            part["source_id"] = sim
            part["ingest_ts"] = tss.values
            part["writer_ts"] = tss.values
            part["row_hash"]  = [_hash(sim, module, t) for t in tss]
            part["timestamp"] = tss.values
            part = part.drop(columns=["_ts", "date"], errors="ignore")

            rp_idx  = cum_idx + n - 1
            rp_hash = _hash(sim, module, part.iloc[-1]["ingest_ts"])
            last_its = part.iloc[-1]["ingest_ts"]
            seed_total += n

            # ── write Bronze chunk ──────────────────────────────────────────
            _delta_append(bp, part)

            # ── inference + write Silver ONE BATCH AT A TIME ───────────────
            # Never accumulate Silver rows in a list; write each 60-row batch
            # immediately so Silver memory stays ≈ one batch at a time.
            for start in range(0, n, INFERENCE_BATCH):
                batch = part.iloc[start : start + INFERENCE_BATCH].copy()
                try:
                    out = ml.process_batch(batch, sim)
                    if not out.empty:
                        out["inference_ts"] = batch["ingest_ts"].values[: len(out)]
                        _delta_append(sp, out)
                        del out
                except Exception:
                    pass
                del batch
            # ──────────────────────────────────────────────────────────────

            del part
            gc.collect()

            past_cutoff = n < len(raw)
            cum_idx += len(raw)
            del raw
            gc.collect()

            if past_cutoff:
                break

        if rp_idx >= 0:
            REPLAY_CKPT_DIR.mkdir(parents=True, exist_ok=True)
            (REPLAY_CKPT_DIR / f"{sim}_{module}.json").write_text(json.dumps({
                "source_id":      f"{sim}_{module}",
                "last_row_index": rp_idx,
                "last_row_hash":  rp_hash,
                "updated_at":     datetime.now(timezone.utc).isoformat(),
            }))
            inf_st.update_checkpoint(sim, last_its)

        print(f"    [{module.upper()}] {sim}: {seed_total} rows  "
              f"({round(time.time() - t0, 1)}s)")

    del ml
    gc.collect()

    INF_STATE_DIR.mkdir(parents=True, exist_ok=True)
    (INF_STATE_DIR / f"checkpoints_{module}.json").write_text(
        json.dumps(inf_st.checkpoints, indent=2))
    with open(INF_STATE_DIR / f"ml_state_{module}.pkl", "wb") as fh:
        pickle.dump(inf_st.ml_state, fh)
    print(f"  [{module.upper()}] Inference state saved.")


# ── Phase 2 — Gold  (pre-aggregate Silver then actual HealthAggregator) ───────
#
# Pre-aggregation: 280 k Silver rows → ~4 000 window-reps per vehicle.
# For 7 vehicles × 5 modules ≈ 140 k window-reps total — fits comfortably.
# Result is IDENTICAL to the live service because the last update_module_state
# call within a window is the one that sticks in vehicle_cache, which is
# exactly what groupby.last() captures.

def seed_gold(modules: list) -> dict:

    _clr()
    gd = str(ROOT / "gold_service")
    if gd in sys.path:
        sys.path.remove(gd)
    sys.path.insert(0, gd)
    from src.aggregator    import HealthAggregator  # noqa: PLC0415
    from src.state_manager import GoldStateManager  # noqa: PLC0415

    for f in (GOLD_STATE_DIR / "checkpoints.json",
              GOLD_STATE_DIR / "vehicle_cache.pkl"):
        if f.exists():
            f.unlink()
    if GOLD_ROOT.exists():
        shutil.rmtree(GOLD_ROOT)
    GOLD_ROOT.mkdir(parents=True, exist_ok=True)

    state      = GoldStateManager()
    aggregator = HealthAggregator(state)
    max_its: dict = {}

    print("\n[GOLD] Pre-aggregating Silver → window representatives...")

    for mod in modules:
        sp = SILVER_ROOT / mod
        if not sp.exists():
            print(f"  [GOLD] Silver/{mod} missing — skipped"); continue
        try:
            df = DeltaTable(str(sp)).to_pandas()
        except Exception as e:
            print(f"  [GOLD] Cannot read Silver/{mod}: {e}"); continue

        if "inference_ts" in df.columns and not df.empty:
            max_its[mod] = str(df["inference_ts"].max())

        df["_ts"]       = pd.to_datetime(df["timestamp"], utc=True)
        df["window_ts"] = df["_ts"].dt.floor(f"{GOLD_WINDOW_SEC}s")
        df["module_name"] = mod

        agg = (
            df[["source_id", "window_ts", "_ts", "health_score",
                "top_features", "module_name"]]
            .sort_values("_ts")
            .groupby(["source_id", "window_ts"], sort=False)
            .last()
            .reset_index()
        )
        del df; gc.collect()
        print(f"  [GOLD] {mod}: {len(agg)} window-reps")

        gold_recs: list = []
        for (sim, wts), grp in agg.groupby(["source_id", "window_ts"]):
            for _, row in grp.iterrows():
                state.update_module_state(
                    sim_id=sim, module=row["module_name"],
                    health=row["health_score"],
                    features_json=row.get("top_features", "{}"),
                )
            gold_recs.append(aggregator.compute_gold_record(sim, str(wts)))

        del agg; gc.collect()

        if gold_recs:
            _delta_append(GOLD_ROOT, pd.DataFrame(gold_recs))
            print(f"  [GOLD] {mod}: {len(gold_recs)} health records written")

    for mod, ts in max_its.items():
        state.checkpoints[mod] = ts
    state.save_state()
    print(f"  [GOLD] Checkpoints: {max_its}")
    _clr()
    return max_its


# ── Phase 3 — Alerts  (actual AlertEngine, batch dict-iteration) ──────────────
#
# Memory strategy:
#   Load Silver per module with only 5 narrow columns — excludes top_features
#   (200-char JSON × 1.96 M rows = ~400 MB per module avoided).
#   Alert firing is driven by severity/composite_score, not top_features.
#   Top_features defaults to {} in AlertEngine when the key is absent.
#   Process in ALERT_BATCH-row dict batches — ~8× faster than iterrows.

def seed_alerts(modules: list, max_its: dict) -> None:

    _clr()
    ad = str(ROOT / "alerts_service")
    if ad in sys.path:
        sys.path.remove(ad)
    sys.path.insert(0, ad)
    from src.alert_engine  import AlertEngine        # noqa: PLC0415
    from src.state_manager import AlertStateManager  # noqa: PLC0415

    for f in (ALERTS_STATE_DIR / "checkpoints.json",
              ALERTS_STATE_DIR / "alert_state_cache.pkl"):
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

    SLIM_COLS = ["source_id", "module_name", "timestamp",
                 "severity", "composite_score"]

    print("\n[ALERTS] Running leaky-bucket (module by module, dict iteration)...")

    all_alerts: dict = {}

    for mod in modules:
        sp = SILVER_ROOT / mod
        if not sp.exists():
            continue
        try:
            df = DeltaTable(str(sp)).to_pandas()
        except Exception as e:
            print(f"  [ALERTS] Cannot read Silver/{mod}: {e}"); continue

        df["module_name"] = mod
        df["timestamp"]   = pd.to_datetime(df["timestamp"], utc=True)
        df = df.sort_values("timestamp", ascending=True)

        present = [c for c in SLIM_COLS if c in df.columns]
        df = df[present]

        df["source_id"]    = df["source_id"].astype("category")
        df["severity"]     = df["severity"].astype("category")

        n_before = len(all_alerts)
        t_a = time.time()

        for b_start in range(0, len(df), ALERT_BATCH):
            batch_dicts = df.iloc[b_start : b_start + ALERT_BATCH].to_dict("records")
            for row_d in batch_dicts:
                payload = engine.process_row(row_d)
                if payload:
                    all_alerts[payload["alert_id"]] = payload
            del batch_dicts
            gc.collect()

        del df; gc.collect()
        fired = len(all_alerts) - n_before
        print(f"  [ALERTS] {mod}: {fired} new records  "
              f"({round(time.time() - t_a, 1)}s)")

    if all_alerts:
        adf = pd.DataFrame(list(all_alerts.values()))
        write_deltalake(str(ALERTS_ROOT),
                        pa.Table.from_pandas(adf, schema=ALERT_SCHEMA),
                        mode="append")
        del adf; gc.collect()
        print(f"  [ALERTS] Written: {len(all_alerts)} total alert records")
    else:
        print("  [ALERTS] No alerts fired — clean 15-day history")

    for mod, ts in max_its.items():
        state.checkpoints[mod] = ts
    state.save_state()
    print("  [ALERTS] State saved.")
    _clr()


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days", type=int, default=15)
    args = parser.parse_args()

    pipeline_cfg = _j(PIPELINE_CFG)
    replay_cfg   = _j(REPLAY_CFG)
    contracts    = _j(CONTRACTS_FILE)
    modules      = pipeline_cfg["enabled_modules"]
    vehicles     = replay_cfg["enabled_sims"]
    cutoff_ts    = BASE_DATE + pd.Timedelta(days=args.days)

    print("=" * 60)
    print(f"DEMO SEEDER — {args.days}-day pre-seed  "
          f"(chunk={CHUNK_SIZE}, alert_batch={ALERT_BATCH})")
    print(f"  Vehicles : {vehicles}")
    print(f"  Modules  : {modules}")
    print(f"  Cutoff   : {cutoff_ts.date()}")
    print("=" * 60)

    print("\nPRE-FLIGHT...")
    if not preflight(vehicles, modules, contracts):
        print("\nERROR: run extras/Copy_raw_vehicles_csv.ipynb first.")
        sys.exit(1)
    print("  OK\n")

    t0 = time.time()

    for mod in modules:
        print(f"\n{'─'*50}\nMODULE: {mod.upper()}\n{'─'*50}")
        tm = time.time()
        seed_bronze_silver(mod, vehicles, contracts, cutoff_ts)
        print(f"  [{mod.upper()}] Done in {round(time.time()-tm,1)}s")

    max_its = seed_gold(modules)

    gold_ckpt = GOLD_STATE_DIR / "checkpoints.json"
    seed_alerts(modules, _j(gold_ckpt) if gold_ckpt.exists() else max_its)

    if WRITER_CKPT_DIR.exists():
        shutil.rmtree(WRITER_CKPT_DIR)
    WRITER_CKPT_DIR.mkdir(parents=True, exist_ok=True)
    print("\n[WRITER] Spark checkpoints cleared.")

    elapsed = round(time.time()-t0, 1)
    print(f"\n{'='*60}")
    print(f"SEEDING COMPLETE in {elapsed}s  ({round(elapsed/60,1)} min)")
    print("Next:  python tools/start_demo.py")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
