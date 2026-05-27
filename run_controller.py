from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import psutil

ROOT_DIR    = Path(__file__).parent.resolve()
VENV_PYTHON = ROOT_DIR / ".venv" / "Scripts" / "python.exe"
if not VENV_PYTHON.exists():
    VENV_PYTHON = Path(sys.executable)

CONFIG_PATH = ROOT_DIR / "replay" / "config" / "replay_config.json"
PID_FILE    = ROOT_DIR / ".replay.pid"


def _load_config() -> dict:
    with CONFIG_PATH.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _save_config(cfg: dict) -> None:
    with CONFIG_PATH.open("w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)


def _apply_overrides(cfg: dict, args: argparse.Namespace) -> dict:
    if args.rate is not None:
        cfg["rows_per_second"] = args.rate
    if args.sims is not None:
        cfg["enabled_sims"] = [s.strip() for s in args.sims.split(",")]
    if args.mode is not None:
        cfg["replay_mode"] = args.mode
    if args.batch_size is not None:
        cfg["batch_size"] = args.batch_size
    if args.batch_interval is not None:
        cfg["batch_interval_seconds"] = args.batch_interval
    if args.with_reset:
        cfg.setdefault("reset", {})["enabled"] = True
    if args.no_archive_dlq:
        cfg.setdefault("reset", {})["archive_dlq"] = False
    return cfg


def _probe() -> tuple[bool, Optional[int]]:
    if not PID_FILE.exists():
        return False, None
    try:
        pid = int(PID_FILE.read_text().strip())
        if psutil.pid_exists(pid):
            return True, pid
    except Exception:
        pass
    PID_FILE.unlink(missing_ok=True)
    return False, None


def cmd_start(args: argparse.Namespace) -> None:
    running, pid = _probe()
    if running:
        print(f"Replay is already running (PID {pid}). Run --stop first.")
        sys.exit(1)

    cfg = _load_config()
    cfg = _apply_overrides(cfg, args)
    _save_config(cfg)

    (ROOT_DIR / "logs").mkdir(exist_ok=True)
    log_fh = open(ROOT_DIR / "logs" / "replay_controller.log", "a", encoding="utf-8")

    env = os.environ.copy()
    env["PYTHONPATH"] = str(ROOT_DIR)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    flags = subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        [str(VENV_PYTHON), __file__, "--worker"],
        cwd=str(ROOT_DIR),
        stdout=log_fh,
        stderr=subprocess.STDOUT,
        env=env,
        creationflags=flags,
    )
    PID_FILE.write_text(str(proc.pid))

    print(f"Replay started  PID={proc.pid}  logs/replay_controller.log")
    print(f"  rate={cfg.get('rows_per_second')} rps  mode={cfg.get('replay_mode')}  sims={cfg.get('enabled_sims')}")


def cmd_stop(_args: argparse.Namespace) -> None:
    running, pid = _probe()
    if not running:
        print("Replay is not running.")
        return

    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        for child in children:
            try:
                child.terminate()
            except psutil.NoSuchProcess:
                pass
        _, alive = psutil.wait_procs(children, timeout=3)
        for child in alive:
            try:
                child.kill()
            except psutil.NoSuchProcess:
                pass
        parent.terminate()
        try:
            parent.wait(timeout=5)
        except psutil.TimeoutExpired:
            parent.kill()
        print(f"Replay stopped (PID {pid}).")
    except psutil.NoSuchProcess:
        print(f"Process {pid} was already gone.")
    finally:
        PID_FILE.unlink(missing_ok=True)


def cmd_reset(args: argparse.Namespace) -> None:
    running, pid = _probe()
    if running:
        print(f"Replay is running (PID {pid}). Stop it first with --stop.")
        sys.exit(1)

    sys.path.insert(0, str(ROOT_DIR))
    from replay.service.replay_service import ReplayService

    cfg = _load_config()
    archive_dlq = not args.no_archive_dlq

    service = ReplayService(
        pipeline_root=ROOT_DIR,
        enabled_sims=cfg.get("enabled_sims"),
        replay_mode=cfg["replay_mode"],
        rows_per_second=cfg.get("rows_per_second"),
        batch_interval_seconds=cfg.get("batch_interval_seconds"),
        http_endpoint=cfg["http_endpoint"],
    )
    service.reset(archive_dlq=archive_dlq)
    print(f"Replay state reset  archive_dlq={archive_dlq}")


def cmd_status(_args: argparse.Namespace) -> None:
    running, pid = _probe()
    port_up = any(
        c.laddr.port == 9001 and c.status == "LISTEN"
        for c in psutil.net_connections(kind="inet")
    )
    cfg = _load_config()

    print(f"Process : {'RUNNING  PID=' + str(pid) if running else 'STOPPED'}")
    print(f"Port 9001: {'LISTENING' if port_up else 'CLOSED'}")
    print(f"Rate    : {cfg.get('rows_per_second')} rows/sec")
    print(f"Mode    : {cfg.get('replay_mode')}")
    print(f"Sims    : {', '.join(cfg.get('enabled_sims', []))}")


def cmd_config(_args: argparse.Namespace) -> None:
    print(json.dumps(_load_config(), indent=2))


def _worker_main() -> None:
    sys.path.insert(0, str(ROOT_DIR))
    from replay.service.replay_service import ReplayService

    cfg = _load_config()
    service = ReplayService(
        pipeline_root=ROOT_DIR,
        enabled_sims=cfg.get("enabled_sims"),
        replay_mode=cfg["replay_mode"],
        rows_per_second=cfg.get("rows_per_second"),
        batch_interval_seconds=cfg.get("batch_interval_seconds"),
        http_endpoint=cfg["http_endpoint"],
    )
    service.start(
        reset=cfg.get("reset", {}).get("enabled", False),
        archive_dlq=cfg.get("reset", {}).get("archive_dlq", True),
    )

    _stop = False

    def _on_signal(*_: object) -> None:
        nonlocal _stop
        _stop = True

    signal.signal(signal.SIGTERM, _on_signal)

    try:
        while not _stop:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        service.stop_workers()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="run_controller",
        description="Replay service controller",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python run_controller.py --start\n"
            "  python run_controller.py --start --rate 5 --sims sim001,sim002\n"
            "  python run_controller.py --start --with-reset\n"
            "  python run_controller.py --start --with-reset --no-archive-dlq\n"
            "  python run_controller.py --stop\n"
            "  python run_controller.py --reset\n"
            "  python run_controller.py --status\n"
            "  python run_controller.py --config\n"
        ),
    )

    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--start",  action="store_true", help="Start replay in background")
    action.add_argument("--stop",   action="store_true", help="Stop running replay")
    action.add_argument("--reset",  action="store_true", help="Reset replay state (must be stopped first)")
    action.add_argument("--status", action="store_true", help="Show replay status and current config")
    action.add_argument("--config", action="store_true", help="Print current replay_config.json")
    action.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)

    parser.add_argument("--rate",           type=int, metavar="N",           help="rows_per_second override")
    parser.add_argument("--sims",           type=str, metavar="sim001,...",   help="Comma-separated enabled_sims override")
    parser.add_argument("--mode",           type=str, choices=["fixed_rate", "throughput"], help="replay_mode override")
    parser.add_argument("--batch-size",     type=int, metavar="N",           dest="batch_size",     help="batch_size override")
    parser.add_argument("--batch-interval", type=int, metavar="N",           dest="batch_interval", help="batch_interval_seconds override")
    parser.add_argument("--with-reset",     action="store_true",             dest="with_reset",     help="Set reset.enabled=True on start")
    parser.add_argument("--no-archive-dlq", action="store_true",             dest="no_archive_dlq", help="Set reset.archive_dlq=False")

    return parser


def main() -> None:
    args = _build_parser().parse_args()

    if args.worker:
        _worker_main()
    elif args.start:
        cmd_start(args)
    elif args.stop:
        cmd_stop(args)
    elif args.reset:
        cmd_reset(args)
    elif args.status:
        cmd_status(args)
    elif args.config:
        cmd_config(args)


if __name__ == "__main__":
    main()
