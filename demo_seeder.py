"""
Demo Seeder — pre-populates 15 days of data across every pipeline layer.

Designed for 280 000+ rows / vehicle / module.  All known hang and crash
points are addressed below.

Known hazards on Windows (all mitigated):
  1. delta-rs overwrite→append OS lock contention     → always mode="append"
  2. pd.to_datetime(utc=True) on large string arrays  → str[:19] trick + astype int64
  3. Too many delta write transactions causing log     → 1 Silver write / vehicle
     scan to hang
  4. Loading ALL Silver columns incl top_features      → PyArrow column projection
     (~490 MB per module crash)
  5. Backslash paths in delta-rs Rust layer            → path.as_posix() everywhere
  6. pd.concat of thousands of small DataFrames        → periodic consolidation

Uses EXACT pipeline code for scoring/aggregation:
  Silver  → inference_service/src/ml_engine.MLEngine.process_batch()
  Gold    → gold_service/src/aggregator.HealthAggregator
            gold_service/src/state_manager.GoldStateManager
  Alerts  → alerts_service/src/alert_engine.AlertEngine
            alerts_service/src/state_manager.AlertStateManager

PRE-REQUISITE:
  Vehicle CSVs must exist under  data/vehicles/{sim_id}/*.csv
  Run  extras/Copy_raw_vehicles_csv.ipynb  first if missing.

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

SEED_BASELINE_DIR  = ROOT / "tools" / "_seed_baseline"
BASE_DATE          = pd.Timestamp("2024-07-05", tz="UTC")
GOLD_WINDOW_SEC    = 300       # 5-min — mirrors gold_service/src/config.py
CHUNK_SIZE         = 20_000    # CSV rows per Bronze write cycle
INFERENCE_BATCH    = 60        # rows per LSTM forward pass
CONSOLIDATE_EVERY  = 1_000     # merge Silver buffer every N inference batches
ALERT_BATCH        = 20_000    # rows per Alerts dict-iteration batch


# ── Helpers ───────────────────────────────────────────────────────────────────

def _j(p: Path) -> dict:
    return json.loads(p.read_text())


def _find_csv(sim_dir: Path, pattern: str) -> Path | None:
    m = list(sim_dir.glob(pattern))
    return m[0] if len(m) == 1 else None


def _hash(sim: str, mod: str, ts: str) -> str:
    return hashlib.sha256(f"{sim}|{mod}|{ts}".encode()).hexdigest()


def _delta_append(path: Path, df) -> None:
    """
    Append df to a Delta table (creates it on first call).
    Always mode='append' — avoids the Windows delta-rs lock hang that occurs
    when switching from mode='overwrite' to mode='append' in the same session.
    POSIX path prevents backslash issues in the Rust delta-rs layer.
    """
    path.mkdir(parents=True, exist_ok=True)
    write_deltalake(path.as_posix(), df, mode="append")


def _silver_columns(path: Path, columns: list) -> pd.DataFrame:
    """
    Read only the specified columns from a Silver Delta table.
    Uses PyArrow column projection so top_features (200-char JSON × 1.96 M rows
    ≈ 490 MB) is never loaded — only the columns actually needed are read.
    POSIX path avoids Windows backslash hang in delta-rs Rust layer.
    """
    return (
        DeltaTable(path.as_posix())
        .to_pyarrow_dataset()
        .to_table(columns=columns)
        .to_pandas()
    )


# ── Service class importers ───────────────────────────────────────────────────
# gold_service and alerts_service both expose a src/ package.  We clear
# src.* from sys.modules before each import block so Python re-resolves
# the correct config.py for each service.

def _clr() -> None:
    for k in list(sys.modules):
        if k == "src" or k.startswith("src."):
            del sys.modules[k]


def _purge_service_paths() -> None:
    """
    Remove every service directory from sys.path AND clear src.* from sys.modules.

    Root cause of the 'No module named src.alert_engine' error:
      inference_service/src/ has an __init__.py (regular package).
      When alerts_service is on sys.path[0] but inference_service is still on
      sys.path[N], Python finds inference_service/src/__init__.py and resolves
      the entire 'src' namespace to inference_service/src/ — which has no
      alert_engine.py.  Removing ALL service paths before each import block
      makes Python see exactly ONE src/ directory at a time.
    """
    for svc in ("inference_service", "gold_service", "alerts_service"):
        d = str(ROOT / svc)
        while d in sys.path:
            sys.path.remove(d)
    _clr()


def _imp_inf():
    _purge_service_paths()
    d = str(ROOT / "inference_service")
    sys.path.insert(0, d)
    from src.ml_engine import MLEngine  # noqa: PLC0415
    sys.path.remove(d)
    _clr()
    return MLEngine


# ── In-memory inference state ─────────────────────────────────────────────────

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
                print(f"  MISSING  {sim} / {contracts['modules'][mod]['file_pattern']}")
                ok = False
    return ok


# ── Phase 1 — Bronze + Silver ─────────────────────────────────────────────────
#
# Memory budget (per vehicle, worst case):
#   One 20 k-row Bronze chunk       ≈   2 MB
#   delta_append Bronze overhead    ≈   6 MB
#   CONSOLIDATE_EVERY Silver parts  ≈  30 MB  (1 000 × 60 rows × 15 cols)
#   One Silver write (280 k rows)   ≈  34 MB
#   MLEngine (PyTorch + GMM)        ≈ 100 MB
#   ─────────────────────────────────────────
#   Total peak                      ≈ 170 MB
#
# Hang mitigations applied here:
#   • String prefix comparison for cutoff  — avoids pd.to_datetime(utc=True)
#   • One Silver Delta write per vehicle   — avoids thousands of log-scan cycles
#   • Periodic Silver buffer consolidation — avoids slow pd.concat of 4 667 DFs

def seed_bronze_silver(module: str, vehicles: list, contracts: dict,
                       cutoff_ts: pd.Timestamp) -> None:

    MLEngine = _imp_inf()
    pattern  = contracts["modules"][module]["file_pattern"]
    inf_st   = _Inf(module)
    ml       = MLEngine(inf_st, module)

    bp = BRONZE_ROOT / module
    sp = SILVER_ROOT / module
    for p in (bp, sp):
        if p.exists():
            shutil.rmtree(p)

    # "2024-07-20" — used for fast string prefix comparison, no datetime overhead
    cutoff_date = cutoff_ts.strftime("%Y-%m-%d")

    for sim in vehicles:
        csv = _find_csv(VEHICLES_ROOT / sim, pattern)
        if not csv:
            print(f"    [{module.upper()}] {sim}: no CSV — skipped")
            continue

        t0         = time.time()
        cum_idx    = 0
        seed_total = 0
        rp_idx     = -1
        rp_hash    = ""
        last_its   = ""

        # Silver accumulated per-vehicle; written in ONE Delta call at the end.
        # Periodic consolidation keeps pd.concat fast (never merges > CONSOLIDATE_EVERY DFs).
        sim_silver:   list = []
        silver_count: int  = 0

        for raw in pd.read_csv(csv, chunksize=CHUNK_SIZE, low_memory=False):
            # str[:10] < "2024-07-20" — ISO date prefix comparison, no parsing
            seed_mask = raw["timestamp"].str[:10] < cutoff_date

            if not seed_mask.any():
                cum_idx += len(raw)
                del raw, seed_mask
                gc.collect()
                break

            part = raw[seed_mask].copy().reset_index(drop=True)
            n    = len(part)

            # Use original CSV timestamp string directly — inference service
            # compares ingest_ts as plain strings so exact format is irrelevant.
            part["source_id"] = sim
            part["ingest_ts"] = part["timestamp"]
            part["writer_ts"] = part["timestamp"]
            part["row_hash"]  = [_hash(sim, module, t) for t in part["timestamp"]]
            part = part.drop(columns=["date"], errors="ignore")

            rp_idx   = cum_idx + n - 1
            rp_hash  = _hash(sim, module, part.iloc[-1]["ingest_ts"])
            last_its = part.iloc[-1]["ingest_ts"]
            seed_total += n

            _delta_append(bp, part)

            for start in range(0, n, INFERENCE_BATCH):
                batch = part.iloc[start : start + INFERENCE_BATCH].copy()
                try:
                    out = ml.process_batch(batch, sim)
                    if not out.empty:
                        out["inference_ts"] = batch["ingest_ts"].values[: len(out)]
                        sim_silver.append(out)
                        silver_count += len(out)
                        del out
                except Exception:
                    pass
                del batch

            del part
            gc.collect()

            # Periodically merge the Silver buffer so the final pd.concat
            # only joins a small number of large DataFrames (fast).
            if len(sim_silver) >= CONSOLIDATE_EVERY:
                sim_silver = [pd.concat(sim_silver, ignore_index=True)]
                gc.collect()

            past_cutoff = n < len(raw)
            cum_idx    += len(raw)
            del raw
            gc.collect()

            if past_cutoff:
                break

        # ONE Silver write per vehicle — keeps Delta transaction log tiny
        if sim_silver:
            silver_df = pd.concat(sim_silver, ignore_index=True)
            _delta_append(sp, silver_df)
            del silver_df
        del sim_silver
        gc.collect()

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


# ── Phase 2 — Gold ────────────────────────────────────────────────────────────
#
# Memory budget (peak across all modules):
#   Silver load per module (3 cols, NO top_features)   ≈  35 MB
#   Timestamps converted to int64 immediately          →   8 bytes/row (not strings)
#   Combined window-reps (5 mods × 7 veh × ~4 k wins)  ≈  15 MB
#   ─────────────────────────────────────────────────────────────
#   Total peak                                          ≈  50 MB
#
# Hang mitigations applied here:
#   • PyArrow column projection (no top_features)     — avoids 490 MB crash
#   • str[:19] + astype int64                         — avoids pd.to_datetime(utc=True) hang
#   • path.as_posix() for DeltaTable                  — avoids backslash hang
#   • max_its read from inference checkpoint files    — no Silver read needed for it
#   • ALL modules combined before Gold computation    — ONE Gold record per (sim, window)

def seed_gold(modules: list) -> dict:

    _purge_service_paths()
    gd = str(ROOT / "gold_service")
    sys.path.insert(0, gd)
    from src.aggregator    import HealthAggregator  # noqa: PLC0415
    from src.state_manager import GoldStateManager  # noqa: PLC0415
    sys.path.remove(gd)
    _clr()

    for f in (GOLD_STATE_DIR / "checkpoints.json",
              GOLD_STATE_DIR / "vehicle_cache.pkl"):
        if f.exists():
            f.unlink()
    if GOLD_ROOT.exists():
        shutil.rmtree(GOLD_ROOT)
    GOLD_ROOT.mkdir(parents=True, exist_ok=True)

    state      = GoldStateManager()
    aggregator = HealthAggregator(state)

    # Get max_its from already-saved inference checkpoint files.
    # Since inference_ts == ingest_ts in the seeder, max(ingest_ts) per module
    # is exactly what Gold needs as its checkpoint.
    max_its: dict = {}
    for mod in modules:
        ckpt_file = INF_STATE_DIR / f"checkpoints_{mod}.json"
        if ckpt_file.exists():
            inf_ckpts = json.loads(ckpt_file.read_text())
            if inf_ckpts:
                max_its[mod] = max(inf_ckpts.values())

    WINDOW_NS = GOLD_WINDOW_SEC * 1_000_000_000  # 300 s in nanoseconds

    print("\n[GOLD] Loading Silver window-reps (column-projected, no top_features)...")
    all_reps: list = []

    for mod in modules:
        sp = SILVER_ROOT / mod
        if not sp.exists():
            print(f"  [GOLD] Silver/{mod} missing — skipped")
            continue
        try:
            # Column projection: load ONLY source_id, timestamp, health_score.
            # top_features excluded — ~490 MB saving per module.
            df = _silver_columns(sp, ["source_id", "timestamp", "health_score"])
        except Exception as e:
            print(f"  [GOLD] Cannot read Silver/{mod}: {e}")
            continue

        # Convert timestamp to int64 nanoseconds via str[:19] trick.
        # "2024-07-05 08:00:00" → pd.to_datetime (fast, no UTC) → int64 (8 bytes).
        # This avoids pd.to_datetime(utc=True) which hangs on Windows for large arrays.
        df["_ts_ns"]   = pd.to_datetime(df["timestamp"].str[:19]).astype("int64")
        df["window_ns"] = (df["_ts_ns"] // WINDOW_NS) * WINDOW_NS
        df["source_id"] = df["source_id"].astype(str)
        df["module_name"] = mod

        agg = (
            df[["source_id", "window_ns", "_ts_ns", "health_score", "module_name"]]
            .sort_values("_ts_ns")
            .groupby(["source_id", "window_ns"], sort=False)
            [["health_score", "module_name"]]
            .last()
            .reset_index()
        )
        all_reps.append(agg)
        del df, agg
        gc.collect()
        print(f"  [GOLD] {mod}: window-reps collected")

    if not all_reps:
        print("  [GOLD] No Silver data — skipped")
        _clr()
        return max_its

    valid_reps = [r for r in all_reps if not r.empty]
    del all_reps
    gc.collect()

    if not valid_reps:
        print("  [GOLD] All modules produced empty window-reps — skipped")
        _clr()
        return max_its

    try:
        combined = pd.concat(valid_reps, ignore_index=True)
    except Exception as exc:
        print(f"  [GOLD] pd.concat failed: {type(exc).__name__}: {exc}")
        _clr()
        return max_its
    del valid_reps
    gc.collect()
    combined.sort_values("window_ns", ascending=True, inplace=True)
    combined.reset_index(drop=True, inplace=True)
    print(f"  [GOLD] Processing {len(combined)} combined window-reps...")

    gold_recs: list = []
    for (sim, wns), grp in combined.groupby(["source_id", "window_ns"]):
        window_ts = str(pd.Timestamp(int(wns), unit="ns"))
        for _, row in grp.iterrows():
            state.update_module_state(
                sim_id=str(sim),
                module=str(row["module_name"]),
                health=float(row["health_score"]),
                features_json="{}",   # top_features not loaded; Gold feature
            )                         # attribution is empty in seed data only.
        gold_recs.append(aggregator.compute_gold_record(str(sim), window_ts))

    del combined
    gc.collect()

    if gold_recs:
        _delta_append(GOLD_ROOT, pd.DataFrame(gold_recs))
        print(f"  [GOLD] Written: {len(gold_recs)} health records")

    for mod, ts in max_its.items():
        state.checkpoints[mod] = ts
    state.save_state()
    print(f"  [GOLD] Checkpoints: {max_its}")
    _clr()
    return max_its


# ── Phase 3 — Alerts ──────────────────────────────────────────────────────────
#
# Memory budget (peak per module):
#   Silver load (4 slim cols, NO top_features, NO inference_ts)  ≈  35 MB
#   ALERT_BATCH dicts in flight                                  ≈  20 MB
#   ────────────────────────────────────────────────────────────────────────
#   Total peak                                                   ≈  55 MB
#
# Hang mitigations applied here:
#   • PyArrow column projection (4 cols, no top_features)  — avoids 490 MB crash
#   • sort_values("timestamp") on raw strings              — avoids pd.to_datetime(utc=True) hang
#   • astype(str) before to_dict()                         — avoids Categorical scalar
#                                                            keys in AlertEngine state dict
#   • ALERTS_ROOT.as_posix() for Delta write               — avoids backslash hang

def seed_alerts(modules: list, max_its: dict) -> None:

    _purge_service_paths()
    ad = str(ROOT / "alerts_service")
    sys.path.insert(0, ad)
    from src.alert_engine  import AlertEngine        # noqa: PLC0415
    from src.state_manager import AlertStateManager  # noqa: PLC0415
    sys.path.remove(ad)
    _clr()

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

    # Only 4 columns loaded — top_features excluded entirely.
    # AlertEngine.process_row() catches KeyError on missing top_features and
    # uses {} — alert firing is driven by severity/composite_score only.
    SLIM_COLS = ["source_id", "timestamp", "severity", "composite_score"]

    print("\n[ALERTS] Running leaky-bucket (column-projected Silver, string sort)...")

    all_alerts: dict = {}

    for mod in modules:
        sp = SILVER_ROOT / mod
        if not sp.exists():
            continue
        try:
            df = _silver_columns(sp, SLIM_COLS)
        except Exception as e:
            print(f"  [ALERTS] Cannot read Silver/{mod}: {e}")
            continue

        df["module_name"] = mod

        # Sort by raw ISO string — lexicographic order == chronological for ISO 8601.
        # Avoids pd.to_datetime(utc=True) which hangs on Windows for large arrays.
        df = df.sort_values("timestamp", ascending=True)

        # Convert all object/category cols to plain str before to_dict().
        # Pandas Categorical scalars in dicts cause key-mismatch bugs in
        # AlertEngine's state dict (keys are f"{sim_id}_{module}" strings).
        for col in df.select_dtypes(include=["category", "object"]).columns:
            df[col] = df[col].astype(str)

        n_before = len(all_alerts)
        t_a      = time.time()

        for b_start in range(0, len(df), ALERT_BATCH):
            batch_dicts = df.iloc[b_start : b_start + ALERT_BATCH].to_dict("records")
            for row_d in batch_dicts:
                payload = engine.process_row(row_d)
                if payload:
                    all_alerts[payload["alert_id"]] = payload
            del batch_dicts
            gc.collect()

        del df
        gc.collect()
        fired = len(all_alerts) - n_before
        print(f"  [ALERTS] {mod}: {fired} new records  "
              f"({round(time.time() - t_a, 1)}s)")

    if all_alerts:
        adf = pd.DataFrame(list(all_alerts.values()))
        # POSIX path — prevents backslash hang in delta-rs Rust write layer
        write_deltalake(
            ALERTS_ROOT.as_posix(),
            pa.Table.from_pandas(adf, schema=ALERT_SCHEMA),
            mode="append",
        )
        del adf
        gc.collect()
        print(f"  [ALERTS] Written: {len(all_alerts)} total alert records")
    else:
        print("  [ALERTS] No alerts fired — clean 15-day history")

    for mod, ts in max_its.items():
        state.checkpoints[mod] = ts
    state.save_state()
    print("  [ALERTS] State saved.")
    _clr()


# ── Seed baseline snapshot ───────────────────────────────────────────────────
# Called once at the end of every seeder run.  Saves:
#   1. Delta table version numbers at seed time  (seed_versions.json)
#   2. Copies of every checkpoint file           (subdirs per service)
#
# start_demo.py reads this on every run and:
#   • Calls DeltaTable.restore(seed_version) to roll back streaming rows
#   • Copies checkpoint files back so services resume from Day-15 end
#
# Net result: demo can be restarted as many times as needed from Day 16
# without re-running the full seeder (which takes 30+ minutes).

def _save_seed_baseline(modules: list, vehicles: list, days: int) -> None:
    bd = SEED_BASELINE_DIR
    bd.mkdir(parents=True, exist_ok=True)

    stream_start = BASE_DATE + pd.Timedelta(days=days)
    (bd / "seed_metadata.json").write_text(json.dumps({
        "days": days,
        "base_date": str(BASE_DATE.date()),
        "stream_start_date": str(stream_start.date()),
    }, indent=2))

    versions: dict = {}
    tables = (
        [(BRONZE_ROOT / m, f"bronze/{m}") for m in modules] +
        [(SILVER_ROOT / m, f"silver/{m}") for m in modules] +
        [(GOLD_ROOT,   "gold/vehicle_health"),
         (ALERTS_ROOT, "gold/alerts")]
    )
    for path, key in tables:
        if path.exists():
            try:
                versions[key] = DeltaTable(path.as_posix()).version()
            except Exception:
                pass

    (bd / "seed_versions.json").write_text(json.dumps(versions, indent=2))

    replay_bk = bd / "replay_checkpoints"
    replay_bk.mkdir(exist_ok=True)
    for mod in modules:
        for sim in vehicles:
            src = REPLAY_CKPT_DIR / f"{sim}_{mod}.json"
            if src.exists():
                shutil.copy2(src, replay_bk / src.name)

    inf_bk = bd / "inference_state"
    inf_bk.mkdir(exist_ok=True)
    for mod in modules:
        for fname in (f"checkpoints_{mod}.json", f"ml_state_{mod}.pkl"):
            src = INF_STATE_DIR / fname
            if src.exists():
                shutil.copy2(src, inf_bk / fname)

    gold_bk = bd / "gold_state"
    gold_bk.mkdir(exist_ok=True)
    for fname in ("checkpoints.json", "vehicle_cache.pkl"):
        src = GOLD_STATE_DIR / fname
        if src.exists():
            shutil.copy2(src, gold_bk / fname)

    alerts_bk = bd / "alerts_state"
    alerts_bk.mkdir(exist_ok=True)
    for fname in ("checkpoints.json", "alert_state_cache.pkl"):
        src = ALERTS_STATE_DIR / fname
        if src.exists():
            shutil.copy2(src, alerts_bk / fname)

    print(f"\n[BASELINE] Seed baseline saved → {bd}")
    print(f"           Delta versions recorded: {list(versions.keys())}")
    print("           Every start_demo.py run will restore this baseline.")


# ── Resume helpers ───────────────────────────────────────────────────────────

def _phase1_done(module: str, vehicles: list) -> bool:
    """True when Bronze, Silver, replay checkpoints and inference state all exist."""
    return all([
        (BRONZE_ROOT / module).exists(),
        (SILVER_ROOT / module).exists(),
        (INF_STATE_DIR / f"checkpoints_{module}.json").exists(),
        (INF_STATE_DIR / f"ml_state_{module}.pkl").exists(),
        all((REPLAY_CKPT_DIR / f"{sim}_{module}.json").exists() for sim in vehicles),
    ])


def _phase2_done() -> bool:
    """True when Gold table and both Gold state files exist."""
    return all([
        GOLD_ROOT.exists(),
        (GOLD_STATE_DIR / "checkpoints.json").exists(),
        (GOLD_STATE_DIR / "vehicle_cache.pkl").exists(),
    ])


def _max_its_from_inf_checkpoints(modules: list) -> dict:
    """Read max inference_ts per module from already-saved inference checkpoint files."""
    max_its: dict = {}
    for mod in modules:
        ckpt_file = INF_STATE_DIR / f"checkpoints_{mod}.json"
        if ckpt_file.exists():
            inf_ckpts = json.loads(ckpt_file.read_text())
            if inf_ckpts:
                max_its[mod] = max(inf_ckpts.values())
    return max_its


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-seed 15 days of data across all pipeline layers."
    )
    parser.add_argument("--days", type=int, default=15)
    parser.add_argument(
        "--resume",
        action="store_true",
        help=(
            "Skip phases whose outputs already exist on disk. "
            "Use after a partial run crashed mid-way to continue from where it stopped "
            "without re-running expensive inference."
        ),
    )
    args = parser.parse_args()

    pipeline_cfg = _j(PIPELINE_CFG)
    replay_cfg   = _j(REPLAY_CFG)
    contracts    = _j(CONTRACTS_FILE)
    modules      = pipeline_cfg["enabled_modules"]
    vehicles     = replay_cfg["enabled_sims"]
    cutoff_ts    = BASE_DATE + pd.Timedelta(days=args.days)

    print("=" * 60)
    print(f"DEMO SEEDER — {args.days}-day pre-seed"
          + ("  [RESUME MODE]" if args.resume else ""))
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

    # ── Phase 1: Bronze + Silver (one module at a time) ──────────────────────
    phase1_ran = False
    for mod in modules:
        if args.resume and _phase1_done(mod, vehicles):
            print(f"\n[{mod.upper()}] Phase 1 already complete — skipped (--resume)")
            continue
        print(f"\n{'─' * 50}\nMODULE: {mod.upper()}\n{'─' * 50}")
        tm = time.time()
        seed_bronze_silver(mod, vehicles, contracts, cutoff_ts)
        print(f"  [{mod.upper()}] Done in {round(time.time() - tm, 1)}s")
        phase1_ran = True

    # ── Phase 2: Gold aggregation ────────────────────────────────────────────
    if args.resume and _phase2_done() and not phase1_ran:
        print("\n[GOLD] Phase 2 already complete — skipped (--resume)")
        max_its = _max_its_from_inf_checkpoints(modules)
    else:
        max_its = seed_gold(modules)

    # ── Phase 3: Alerts state machine ────────────────────────────────────────
    # Phase 3 always runs: it's fast and is the most likely crash point,
    # so we always regenerate it to ensure a clean alerts state.
    gold_ckpt = GOLD_STATE_DIR / "checkpoints.json"
    seed_alerts(modules, _j(gold_ckpt) if gold_ckpt.exists() else max_its)

    if WRITER_CKPT_DIR.exists():
        shutil.rmtree(WRITER_CKPT_DIR)
    WRITER_CKPT_DIR.mkdir(parents=True, exist_ok=True)
    print("\n[WRITER] Spark checkpoints cleared.")

    _save_seed_baseline(modules, vehicles, args.days)

    elapsed = round(time.time() - t0, 1)
    print(f"\n{'=' * 60}")
    print(f"SEEDING COMPLETE in {elapsed}s  ({round(elapsed / 60, 1)} min)")
    print("Next:  python tools/start_demo.py")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
