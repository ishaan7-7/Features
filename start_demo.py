"""
Demo Start Orchestrator.

Run this before EVERY demo presentation — first time or the tenth time.
It always restores the system to the exact post-seed state so the stream
reliably starts from Day 16, regardless of how much prior streaming occurred.

What it does on every run:
  1. Verifies seed data and baseline backup exist
  2. Restores Delta tables to seed version  (rolls back streaming rows)
  3. Restores checkpoint files              (replay + inference + gold + alerts)
  4. Resets Kafka topics to offset-0
  5. Clears Spark Writer checkpoint

After this, start services via run.py then run the replay notebook:
  service.start(reset=False)   ← reads Day-16 replay checkpoint automatically

Usage:  python tools/start_demo.py
"""

import sys
import json
import shutil
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

KAFKA_BIN         = Path(r"C:\kafka\bin\windows")
WRITER_CKPT_DIR   = ROOT / "data"              / "checkpoints" / "writer"
REPLAY_CFG_FILE   = ROOT / "replay"            / "config"      / "replay_config.json"
PIPELINE_CFG      = ROOT / "config"            / "pipeline_config.json"
SEED_BASELINE_DIR = ROOT / "tools"             / "_seed_baseline"
REPLAY_CKPT_DIR   = ROOT / "replay"            / "checkpoints"
INF_STATE_DIR     = ROOT / "inference_service" / "state"
GOLD_STATE_DIR    = ROOT / "gold_service"      / "state"
ALERTS_STATE_DIR  = ROOT / "alerts_service"    / "state"
BRONZE_ROOT       = ROOT / "data"              / "delta" / "bronze"
SILVER_ROOT       = ROOT / "data"              / "delta" / "silver"
GOLD_ROOT         = ROOT / "data"              / "delta" / "gold" / "vehicle_health"
ALERTS_ROOT       = ROOT / "data"              / "delta" / "gold" / "alerts"

KAFKA_TOPICS = [
    "telemetry.battery",
    "telemetry.body",
    "telemetry.engine",
    "telemetry.transmission",
    "telemetry.tyre",
]


def _verify_baseline() -> bool:
    if not (SEED_BASELINE_DIR / "seed_versions.json").exists():
        print("ERROR: No seed baseline found.")
        print("       Run  python tools/demo_seeder.py  once first.")
        return False

    pipeline_cfg    = json.loads(PIPELINE_CFG.read_text())
    enabled_modules = pipeline_cfg["enabled_modules"]

    for module in enabled_modules:
        if not (BRONZE_ROOT / module).exists():
            print(f"ERROR: Bronze/{module} missing — run demo_seeder.py")
            return False
        if not (SILVER_ROOT / module).exists():
            print(f"ERROR: Silver/{module} missing — run demo_seeder.py")
            return False

    return True


def _restore_delta_tables() -> None:
    """
    Roll back every Delta table to the version recorded at seed time.
    This removes streaming rows added during any previous demo run.
    Uses DeltaTable.restore() which is fast (updates the transaction log
    only — no data is physically deleted).
    """
    from deltalake import DeltaTable

    versions: dict = json.loads((SEED_BASELINE_DIR / "seed_versions.json").read_text())

    path_map = {
        "gold/vehicle_health": GOLD_ROOT,
        "gold/alerts":         ALERTS_ROOT,
    }
    for key, seed_ver in versions.items():
        parts = key.split("/")
        if parts[0] == "bronze":
            path = BRONZE_ROOT / parts[1]
        elif parts[0] == "silver":
            path = SILVER_ROOT / parts[1]
        else:
            path = path_map.get(key)

        if path is None or not path.exists():
            continue

        try:
            dt = DeltaTable(path.as_posix())
            current = dt.version()
            if current > seed_ver:
                dt.restore(seed_ver)
                print(f"  {key}: rolled back v{current} → v{seed_ver}")
            else:
                print(f"  {key}: already at seed version {seed_ver}")
        except Exception as exc:
            print(f"  WARNING {key}: restore failed ({exc})")
            print("           Continuing — streaming rows may still be present.")


def _restore_checkpoints() -> None:
    """Copy all checkpoint files from the seed baseline backup."""
    bd = SEED_BASELINE_DIR

    replay_bk = bd / "replay_checkpoints"
    if replay_bk.exists():
        REPLAY_CKPT_DIR.mkdir(parents=True, exist_ok=True)
        for src in replay_bk.glob("*.json"):
            shutil.copy2(src, REPLAY_CKPT_DIR / src.name)

    inf_bk = bd / "inference_state"
    if inf_bk.exists():
        INF_STATE_DIR.mkdir(parents=True, exist_ok=True)
        for src in inf_bk.iterdir():
            shutil.copy2(src, INF_STATE_DIR / src.name)

    gold_bk = bd / "gold_state"
    if gold_bk.exists():
        GOLD_STATE_DIR.mkdir(parents=True, exist_ok=True)
        for src in gold_bk.iterdir():
            shutil.copy2(src, GOLD_STATE_DIR / src.name)

    alerts_bk = bd / "alerts_state"
    if alerts_bk.exists():
        ALERTS_STATE_DIR.mkdir(parents=True, exist_ok=True)
        for src in alerts_bk.iterdir():
            shutil.copy2(src, ALERTS_STATE_DIR / src.name)


def _reset_kafka() -> None:
    print("Resetting Kafka topics (clean offset-0 for Writer)...")
    for topic in KAFKA_TOPICS:
        cmd = (
            f'"{KAFKA_BIN / "kafka-topics.bat"}" --delete '
            f"--topic {topic} --bootstrap-server localhost:9092"
        )
        subprocess.run(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    print("  Waiting 5s for Kafka to settle...")
    time.sleep(5)

    for topic in KAFKA_TOPICS:
        cmd = (
            f'"{KAFKA_BIN / "kafka-topics.bat"}" --create '
            f"--topic {topic} --bootstrap-server localhost:9092 "
            f"--partitions 6 --replication-factor 1"
        )
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        if result.returncode != 0:
            print(f"  WARNING: {topic}: {result.stderr.strip()}")
        else:
            print(f"  Created: {topic}")


def _clear_writer_checkpoints() -> None:
    if WRITER_CKPT_DIR.exists():
        shutil.rmtree(WRITER_CKPT_DIR)
    WRITER_CKPT_DIR.mkdir(parents=True, exist_ok=True)
    print("Spark Writer checkpoints cleared.")


def _print_summary() -> None:
    pipeline_cfg  = json.loads(PIPELINE_CFG.read_text())
    replay_cfg    = json.loads(REPLAY_CFG_FILE.read_text())
    gold_ckpt     = GOLD_STATE_DIR / "checkpoints.json"
    gold_ts       = json.loads(gold_ckpt.read_text()) if gold_ckpt.exists() else {}
    meta_file     = SEED_BASELINE_DIR / "seed_metadata.json"
    meta          = json.loads(meta_file.read_text()) if meta_file.exists() else {}
    days          = meta.get("days", 15)
    stream_start  = meta.get("stream_start_date", "Day N+1")

    print()
    print("=" * 60)
    print(f"DEMO READY — baseline restored, stream starts from {stream_start}")
    print("=" * 60)
    print(f"  Seeded history : {days} days")
    print(f"  Vehicles       : {replay_cfg['enabled_sims']}")
    print(f"  Modules        : {pipeline_cfg['enabled_modules']}")
    print(f"  Service checkpoints restored to:")
    for mod, ts in gold_ts.items():
        print(f"    {mod:<15}: {ts}")
    print()
    print("  Next steps:")
    print("  1. python run.py  →  answer 'y' to DEMO MODE, 'n' to hard-reset")
    print("  2. Open replay notebook")
    print("  3. service.start(reset=False)")
    print(f"  4. Dashboard shows {days} days immediately; stream extends from {stream_start}")
    print("=" * 60)


def main() -> None:
    print("=" * 60)
    print("DEMO START — restoring seed baseline")
    print("=" * 60)

    if not _verify_baseline():
        sys.exit(1)

    print("\nRestoring Delta tables to seed version...")
    _restore_delta_tables()

    print("\nRestoring checkpoint files...")
    _restore_checkpoints()
    print("  Done.")

    print()
    _reset_kafka()
    _clear_writer_checkpoints()

    _print_summary()


if __name__ == "__main__":
    main()
