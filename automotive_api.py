"""
Automotive Deep Dive + Presentation Mode — FastAPI APIRouter.

Included by both main.py (standalone dev) and main_v2.py (run.py production).
No existing code in either file was modified to add this router.
"""

import os
import json
from fastapi import APIRouter, HTTPException

router = APIRouter()

_PROJECT_ROOT   = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_DELTA_ROOT     = os.path.join(_PROJECT_ROOT, "data", "delta", "bronze")
_SILVER_ROOT    = os.path.join(_PROJECT_ROOT, "data", "delta", "silver")
_GOLD_ROOT      = os.path.join(_PROJECT_ROOT, "data", "delta", "gold", "vehicle_health")
_VEHICLE_MODULES = ["battery", "body", "engine", "transmission", "tyre"]

# ── Demo / Presentation Mode state ──────────────────────────────────────────

_PRESENTATION_MODE_ACTIVE: bool = False
_DEMO_SEED_CACHE: dict = {}
_DEMO_SILVER_CACHE: dict = {}
_DEMO_VEHICLE_HEALTH_CACHE: dict = {}

_DEMO_VEHICLES: list = [
    "sim001", "sim002", "sim003", "sim004",
    "sim005", "sim006", "sim007",
]

_KEY_SENSOR_SPECS: dict = {
    "engine": {
        "engine_rpm_rpm":                     (800.0,   3500.0,  150.0),
        "engine_oil_temperature":             (75.0,    115.0,   2.0),
        "ecu_7ea_engine_coolant_temperature": (78.0,    102.0,   1.5),
        "engine_load_absolute":               (10.0,    80.0,    4.0),
        "fuel_flow_rate_hour_l_hr":           (2.5,     14.0,    0.8),
        "turbo_boost_vacuum_gauge_psi":       (-3.0,    14.0,    0.8),
        "voltage_control_module_v":           (13.0,    14.5,    0.05),
    },
    "battery": {
        "battery_state_of_charge_soc_pct":    (20.0,    96.0,    2.0),
        "battery_state_of_health_soh_pct":    (88.0,    100.0,   0.1),
        "battery_voltage_ecu_7ee":            (12.0,    14.6,    0.15),
        "battery_temperature_cell":           (18.0,    45.0,    1.5),
        "internal_resistance_impedance":      (0.005,   0.018,   0.001),
        "charging_power_kw":                  (0.0,     7.2,     0.3),
        "hv_battery_pack_voltage":            (360.0,   420.0,   4.0),
    },
    "body": {
        "cabin_temperature":                  (18.0,    28.0,    0.8),
        "fuel_level_pct":                     (8.0,     100.0,   2.0),
        "cabin_humidity_pct":                 (30.0,    70.0,    2.0),
        "hvac_blower_speed":                  (0.0,     100.0,   5.0),
        "ac_compressor_load_pct":             (0.0,     80.0,    4.0),
        "distance_since_codes_cleared":       (0.0,     15000.0, 10.0),
        "odometer_reading":                   (38000.0, 80000.0, 0.0),
    },
    "transmission": {
        "transmission_oil_temperature":       (50.0,    100.0,   2.0),
        "gear_position_actual":               (1.0,     6.0,     0.5),
        "torque_converter_slip_speed":        (0.0,     100.0,   4.0),
        "vehicle_speed_kmh":                  (0.0,     120.0,   6.0),
        "actual_engine_pct_torque":           (5.0,     90.0,    4.0),
        "clutch_engagement_per_slip":         (0.2,     9.0,     0.4),
        "engine_rpm":                         (800.0,   3500.0,  150.0),
    },
    "tyre": {
        "tyre_pressure_fl_psi":               (30.0,    37.0,    0.2),
        "tyre_pressure_fr_psi":               (30.0,    37.0,    0.2),
        "tyre_pressure_rl_psi":               (30.0,    37.0,    0.2),
        "tyre_pressure_rr_psi":               (30.0,    37.0,    0.2),
        "tyre_temp_fl_c":                     (28.0,    80.0,    3.0),
        "tyre_temp_fr_c":                     (28.0,    80.0,    3.0),
        "tyre_wear_fl_pct":                   (60.0,    100.0,   0.05),
        "tyre_wear_fr_pct":                   (60.0,    100.0,   0.05),
        "tyre_wear_rl_pct":                   (60.0,    100.0,   0.05),
        "tyre_wear_rr_pct":                   (60.0,    100.0,   0.05),
    },
}

_IDLE_SENSORS = {
    "vehicle_speed_kmh", "engine_rpm_rpm", "engine_rpm",
    "engine_load_absolute", "actual_engine_pct_torque",
    "fuel_flow_rate_hour_l_hr", "torque_converter_slip_speed",
}

_SILVER_TOP_FEATURES: dict = {
    "engine":       ["engine_rpm_rpm", "engine_oil_temperature", "ecu_7ea_engine_coolant_temperature", "engine_load_absolute", "fuel_flow_rate_hour_l_hr"],
    "battery":      ["battery_state_of_charge_soc_pct", "battery_temperature_cell", "internal_resistance_impedance", "battery_state_of_health_soh_pct", "hv_battery_pack_voltage"],
    "body":         ["fuel_level_pct", "cabin_temperature", "ac_compressor_load_pct", "cabin_humidity_pct"],
    "transmission": ["transmission_oil_temperature", "torque_converter_slip_speed", "clutch_engagement_per_slip", "vehicle_speed_kmh"],
    "tyre":         ["tyre_pressure_fl_psi", "tyre_pressure_fr_psi", "tyre_wear_fl_pct", "tyre_temp_fl_c"],
}

# ── Demo data generators ─────────────────────────────────────────────────────

def _generate_sensor_history(vehicle_id: str, module: str, n_points: int = 960) -> list:
    import pandas as pd
    try:
        import numpy as np
    except ImportError:
        return []
    specs = _KEY_SENSOR_SPECS.get(module, {})
    if not specs:
        return []
    rng = np.random.default_rng(seed=abs(hash(vehicle_id + module)) % (2 ** 31))
    end_ts = pd.Timestamp.now(tz="UTC") - pd.Timedelta(minutes=5)
    start_ts = end_ts - pd.Timedelta(days=10)
    timestamps = pd.date_range(start=start_ts, end=end_ts, periods=n_points)
    base_odo = float(rng.uniform(38000, 65000))
    km_per_step = float(rng.uniform(0.9, 2.1))
    states = {k: (lo + hi) / 2.0 for k, (lo, hi, _) in specs.items()}
    if "odometer_reading" in states:
        states["odometer_reading"] = base_odo
    rows = []
    for i, ts in enumerate(timestamps):
        is_driving = bool(rng.random() > 0.35)
        row: dict = {
            "timestamp": ts.strftime("%Y-%m-%d %H:%M"),
            "source_id": vehicle_id,
            "mileage": round(base_odo + i * km_per_step, 1),
        }
        for col, (lo, hi, noise) in specs.items():
            if col == "odometer_reading":
                states[col] = base_odo + i * km_per_step
                row[col] = round(states[col], 1)
                continue
            if not is_driving and col in _IDLE_SENSORS:
                states[col] = max(lo, states[col] * 0.15)
            states[col] = float(np.clip(states[col] + float(rng.normal(0, noise)), lo, hi))
            row[col] = round(states[col], 3)
        rows.append(row)
    return rows


def _generate_silver_history(vehicle_id: str, module: str, bronze_rows: list) -> list:
    try:
        import numpy as np
    except ImportError:
        return []
    if not bronze_rows:
        return []
    rng = np.random.default_rng(seed=abs(hash(vehicle_id + module + "silver")) % (2 ** 31))
    features = _SILVER_TOP_FEATURES.get(module, [])
    health_state = float(rng.uniform(82, 96))
    rows = []
    for bronze_row in bronze_rows:
        health_state += float(rng.normal(0, 1.8))
        if health_state < 65:
            health_state += float(rng.uniform(3, 7))
        health_state = float(np.clip(health_state, 40, 100))
        severity = "NORMAL" if health_state >= 80 else ("WARNING" if health_state >= 60 else "CRITICAL")
        top_f = {f: round(float(rng.uniform(0.05, 0.45)), 2) for f in features[:3]}
        rows.append({
            "timestamp": bronze_row["timestamp"],
            "source_id": vehicle_id,
            "mileage": bronze_row["mileage"],
            "health_score": round(health_state, 2),
            "severity": severity,
            "top_features": json.dumps(top_f),
        })
    return rows


def _generate_vehicle_health_history(silver_by_module: dict) -> list:
    if not silver_by_module:
        return []
    mod_lists = [v for v in silver_by_module.values() if v]
    if not mod_lists:
        return []
    n = min(len(lst) for lst in mod_lists)
    WEIGHTS = {"engine": 0.35, "transmission": 0.25, "battery": 0.20, "body": 0.10, "tyre": 0.10}
    ref_list = mod_lists[0]
    rows = []
    for i in range(n):
        scores = [lst[i]["health_score"] * WEIGHTS.get(mod, 0.2) for mod, lst in silver_by_module.items() if i < len(lst)]
        fused = sum(scores) if scores else 0
        ts = ref_list[i]["timestamp"]
        rows.append({
            "ts": ts[5:16],
            "timestamp": ts,
            "mileage": ref_list[i]["mileage"],
            "health": round(fused, 2),
        })
    return rows


def _seed_all_demo_data() -> None:
    global _DEMO_SEED_CACHE, _DEMO_SILVER_CACHE, _DEMO_VEHICLE_HEALTH_CACHE
    _DEMO_SEED_CACHE = {}
    _DEMO_SILVER_CACHE = {}
    _DEMO_VEHICLE_HEALTH_CACHE = {}
    for vid in _DEMO_VEHICLES:
        _DEMO_SEED_CACHE[vid] = {}
        _DEMO_SILVER_CACHE[vid] = {}
        for mod in _VEHICLE_MODULES:
            bronze = _generate_sensor_history(vid, mod)
            _DEMO_SEED_CACHE[vid][mod] = bronze
            _DEMO_SILVER_CACHE[vid][mod] = _generate_silver_history(vid, mod, bronze)
        _DEMO_VEHICLE_HEALTH_CACHE[vid] = _generate_vehicle_health_history(_DEMO_SILVER_CACHE[vid])


# ── Mileage join helper ───────────────────────────────────────────────────────

def _attach_mileage(combined, vehicle_id: str):
    import pandas as pd
    body_partition = os.path.join(_DELTA_ROOT, "body", f"source_id={vehicle_id}")
    if not os.path.exists(body_partition):
        combined["mileage"] = range(len(combined))
        return combined
    bfiles = sorted(
        [os.path.join(r, f) for r, _d, ff in os.walk(body_partition) for f in ff if f.endswith(".parquet")],
        key=os.path.getmtime, reverse=True,
    )
    bdfs = []
    for fp in bfiles[:20]:
        try:
            bdf = pd.read_parquet(fp)
            if not bdf.empty and "odometer_reading" in bdf.columns:
                btc = next((c for c in ("timestamp", "ingest_ts") if c in bdf.columns), None)
                if btc:
                    bdf["timestamp"] = pd.to_datetime(bdf[btc]).dt.strftime("%Y-%m-%d %H:%M")
                    bdfs.append(bdf[["timestamp", "odometer_reading"]])
        except Exception:
            pass
    if bdfs:
        body_merged = pd.concat(bdfs, ignore_index=True).drop_duplicates("timestamp")
        combined = combined.merge(body_merged, on="timestamp", how="left")
        combined["mileage"] = combined["odometer_reading"].fillna(0)
    else:
        combined["mileage"] = range(len(combined))
    return combined


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/api/automotive/demo/activate")
def activate_presentation_mode():
    global _PRESENTATION_MODE_ACTIVE
    _PRESENTATION_MODE_ACTIVE = True
    _seed_all_demo_data()
    bronze_rows = sum(len(rows) for vd in _DEMO_SEED_CACHE.values() for rows in vd.values())
    silver_rows = sum(len(rows) for vd in _DEMO_SILVER_CACHE.values() for rows in vd.values())
    return {
        "status": "activated",
        "vehicles": _DEMO_VEHICLES,
        "bronze_rows_seeded": bronze_rows,
        "silver_rows_seeded": silver_rows,
        "days_of_history": 10,
    }


@router.get("/api/automotive/demo/status")
def get_presentation_mode_status():
    return {
        "active": _PRESENTATION_MODE_ACTIVE,
        "vehicles": list(_DEMO_SEED_CACHE.keys()) if _PRESENTATION_MODE_ACTIVE else [],
    }


@router.get("/api/automotive/fleet-summary")
def get_automotive_fleet_summary():
    import pandas as pd
    vehicles_out: list = []
    gold_vehicle_map: dict = {}

    if os.path.exists(_GOLD_ROOT):
        gfiles = [os.path.join(r, f) for r, _d, ff in os.walk(_GOLD_ROOT) for f in ff if f.endswith(".parquet")]
        dfs = []
        for fp in gfiles:
            try:
                df = pd.read_parquet(fp)
                if not df.empty:
                    dfs.append(df)
            except Exception:
                pass
        if dfs:
            gdf = pd.concat(dfs, ignore_index=True)
            if "gold_window_ts" in gdf.columns and "source_id" in gdf.columns:
                gdf["gold_window_ts"] = pd.to_datetime(gdf["gold_window_ts"])
                latest = gdf.sort_values("gold_window_ts").groupby("source_id").last().reset_index()
                for _, row in latest.iterrows():
                    entry: dict = {
                        "vehicle_id": str(row.get("source_id", "")),
                        "health_score": round(float(row.get("vehicle_health_score", 0)), 1),
                        "data_source": "live",
                    }
                    for mod in _VEHICLE_MODULES:
                        entry[f"{mod}_contrib"] = round(float(row.get(f"{mod}_contrib", 0)), 2)
                    gold_vehicle_map[entry["vehicle_id"]] = entry

    if gold_vehicle_map:
        vehicles_out = list(gold_vehicle_map.values())
    elif _PRESENTATION_MODE_ACTIVE and _DEMO_SEED_CACHE:
        try:
            import numpy as np
            _np_ok = True
        except ImportError:
            _np_ok = False
        for vid in _DEMO_VEHICLES:
            if _np_ok:
                import numpy as np
                rng = np.random.default_rng(seed=abs(hash(vid)) % (2 ** 31))
                health = round(float(rng.uniform(65, 95)), 1)
                entry = {"vehicle_id": vid, "health_score": health, "data_source": "demo"}
                remaining = 1.0
                for idx, mod in enumerate(_VEHICLE_MODULES):
                    if idx == len(_VEHICLE_MODULES) - 1:
                        entry[f"{mod}_contrib"] = round(max(0, remaining), 3)
                    else:
                        share = round(float(rng.uniform(0.10, 0.28)), 3)
                        share = min(share, remaining)
                        entry[f"{mod}_contrib"] = share
                        remaining -= share
            else:
                entry = {
                    "vehicle_id": vid,
                    "health_score": 80.0,
                    "data_source": "demo",
                    **{f"{mod}_contrib": 0.2 for mod in _VEHICLE_MODULES},
                }
            vehicles_out.append(entry)

    health_scores = [v["health_score"] for v in vehicles_out if v.get("health_score") is not None]
    return {
        "vehicles": vehicles_out,
        "fleet_stats": {
            "total_vehicles": len(vehicles_out),
            "avg_health": round(sum(health_scores) / len(health_scores), 1) if health_scores else 0,
            "critical_count": sum(1 for h in health_scores if h < 60),
            "warning_count": sum(1 for h in health_scores if 60 <= h < 80),
            "demo_active": _PRESENTATION_MODE_ACTIVE,
        },
    }


@router.get("/api/automotive/sensor-history/{vehicle_id}/{module}")
def get_automotive_sensor_history(vehicle_id: str, module: str):
    import pandas as pd
    if module not in _VEHICLE_MODULES:
        raise HTTPException(status_code=400, detail="Invalid module")

    rows: list = []
    data_source = "none"

    partition_path = os.path.join(_DELTA_ROOT, module, f"source_id={vehicle_id}")
    if os.path.exists(partition_path):
        pfiles = sorted(
            [os.path.join(r, f) for r, _d, ff in os.walk(partition_path) for f in ff if f.endswith(".parquet")],
            key=os.path.getmtime, reverse=True,
        )
        dfs = []
        for fp in pfiles[:20]:
            try:
                df = pd.read_parquet(fp)
                if not df.empty:
                    dfs.append(df)
            except Exception:
                pass

        if dfs:
            combined = pd.concat(dfs, ignore_index=True)
            combined["source_id"] = vehicle_id
            ts_col = next((c for c in ("timestamp", "ingest_ts") if c in combined.columns), None)
            if ts_col:
                combined["timestamp"] = pd.to_datetime(combined[ts_col]).dt.strftime("%Y-%m-%d %H:%M")
            else:
                combined["timestamp"] = combined.index.astype(str)
            combined = combined.fillna(0)
            if module != "body":
                combined = _attach_mileage(combined, vehicle_id)
            if "mileage" not in combined.columns:
                combined["mileage"] = range(len(combined))
            numeric_cols = [c for c in combined.columns if combined[c].dtype.kind in ("f", "i") and c != "mileage"]
            keep = ["timestamp", "source_id", "mileage"] + numeric_cols
            combined = combined[[c for c in keep if c in combined.columns]].sort_values("timestamp")
            for col in combined.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
                combined[col] = combined[col].astype(str)
            rows = combined.tail(2000).to_dict(orient="records")
            data_source = "live"

    if not rows and _PRESENTATION_MODE_ACTIVE and vehicle_id in _DEMO_SEED_CACHE:
        rows = _DEMO_SEED_CACHE[vehicle_id].get(module, [])
        data_source = "demo"

    return {"data": rows, "data_source": data_source, "vehicle_id": vehicle_id, "module": module, "count": len(rows)}


@router.get("/api/automotive/module-health/{vehicle_id}/{module}")
def get_automotive_module_health(vehicle_id: str, module: str):
    import pandas as pd
    if module not in _VEHICLE_MODULES:
        raise HTTPException(status_code=400, detail="Invalid module")

    rows: list = []
    data_source = "none"

    silver_path = os.path.join(_SILVER_ROOT, module)
    if os.path.exists(silver_path):
        pfiles = sorted(
            [os.path.join(r, f) for r, _d, ff in os.walk(silver_path) for f in ff if f.endswith(".parquet")],
            key=os.path.getmtime, reverse=True,
        )
        dfs = []
        for fp in pfiles[:20]:
            try:
                df = pd.read_parquet(fp)
                if not df.empty and "source_id" in df.columns:
                    vdf = df[df["source_id"] == vehicle_id]
                    if not vdf.empty:
                        dfs.append(vdf)
            except Exception:
                pass

        if dfs:
            combined = pd.concat(dfs, ignore_index=True)
            ts_col = next((c for c in ("inference_ts", "ingest_ts", "timestamp") if c in combined.columns), None)
            if ts_col:
                combined["timestamp"] = pd.to_datetime(combined[ts_col]).dt.strftime("%Y-%m-%d %H:%M")
            else:
                combined["timestamp"] = combined.index.astype(str)
            combined = combined.fillna(0)
            combined = _attach_mileage(combined, vehicle_id)
            combined = combined.sort_values("timestamp")
            keep = ["timestamp", "source_id", "mileage"]
            for col in ("health_score", "severity", "top_features"):
                if col in combined.columns:
                    keep.append(col)
            for col in combined.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
                combined[col] = combined[col].astype(str)
            rows = combined[[c for c in keep if c in combined.columns]].tail(2000).to_dict(orient="records")
            data_source = "live"

    if not rows and _PRESENTATION_MODE_ACTIVE and vehicle_id in _DEMO_SILVER_CACHE:
        rows = _DEMO_SILVER_CACHE[vehicle_id].get(module, [])
        data_source = "demo"

    return {"data": rows, "data_source": data_source, "vehicle_id": vehicle_id, "module": module, "count": len(rows)}


@router.get("/api/automotive/vehicle-health-history/{vehicle_id}")
def get_automotive_vehicle_health_history(vehicle_id: str):
    import pandas as pd
    rows: list = []
    data_source = "none"

    if os.path.exists(_GOLD_ROOT):
        gfiles = sorted(
            [os.path.join(r, f) for r, _d, ff in os.walk(_GOLD_ROOT) for f in ff if f.endswith(".parquet")],
            key=os.path.getmtime, reverse=True,
        )
        dfs = []
        for fp in gfiles[:100]:
            try:
                df = pd.read_parquet(fp)
                if not df.empty and "source_id" in df.columns:
                    vdf = df[df["source_id"] == vehicle_id]
                    if not vdf.empty:
                        dfs.append(vdf)
            except Exception:
                pass
        if dfs:
            combined = pd.concat(dfs, ignore_index=True)
            if "gold_window_ts" in combined.columns:
                combined["gold_window_ts"] = pd.to_datetime(combined["gold_window_ts"])
                combined = combined.sort_values("gold_window_ts")
                combined["ts"] = combined["gold_window_ts"].dt.strftime("%Y-%m-%d %H:%M")
            combined = combined.fillna(0)
            for col in combined.select_dtypes(include=["datetime64[ns]", "datetime64[ns, UTC]"]).columns:
                combined[col] = combined[col].astype(str)
            keep = [c for c in ("ts", "vehicle_health_score") if c in combined.columns]
            keep += [c for c in combined.columns if c.endswith("_contrib")]
            out = combined[keep].tail(2000).rename(columns={"vehicle_health_score": "health"})
            rows = out.to_dict(orient="records")
            data_source = "live"

    if not rows and _PRESENTATION_MODE_ACTIVE and vehicle_id in _DEMO_VEHICLE_HEALTH_CACHE:
        rows = _DEMO_VEHICLE_HEALTH_CACHE[vehicle_id]
        data_source = "demo"

    return {"data": rows, "data_source": data_source, "vehicle_id": vehicle_id, "count": len(rows)}


@router.get("/api/automotive/module-crossfleet/{module}")
def get_automotive_module_crossfleet(module: str):
    import pandas as pd
    if module not in _VEHICLE_MODULES:
        raise HTTPException(status_code=400, detail="Invalid module")

    specs = _KEY_SENSOR_SPECS.get(module, {})
    sensor_keys = list(specs.keys())
    vehicle_stats: list = []

    bronze_path = os.path.join(_DELTA_ROOT, module)
    if os.path.exists(bronze_path):
        try:
            part_dirs = sorted([
                d for d in os.listdir(bronze_path)
                if d.startswith("source_id=") and os.path.isdir(os.path.join(bronze_path, d))
            ])
        except Exception:
            part_dirs = []
        for part_dir in part_dirs:
            vid = part_dir[len("source_id="):]
            part_path = os.path.join(bronze_path, part_dir)
            pfiles = sorted(
                [os.path.join(r, f) for r, _d, ff in os.walk(part_path) for f in ff if f.endswith(".parquet")],
                key=os.path.getmtime, reverse=True,
            )
            vdfs = []
            for fp in pfiles[:5]:
                try:
                    df = pd.read_parquet(fp)
                    if not df.empty:
                        vdfs.append(df)
                except Exception:
                    pass
            if vdfs:
                grp = pd.concat(vdfs, ignore_index=True)
                stat: dict = {"vehicle_id": vid}
                for sk in sensor_keys:
                    if sk in grp.columns:
                        stat[f"{sk}_avg"] = round(float(grp[sk].mean()), 3)
                        stat[f"{sk}_min"] = round(float(grp[sk].min()), 3)
                        stat[f"{sk}_max"] = round(float(grp[sk].max()), 3)
                vehicle_stats.append(stat)

    if not vehicle_stats and _PRESENTATION_MODE_ACTIVE and _DEMO_SEED_CACHE:
        for vid in _DEMO_VEHICLES:
            if vid not in _DEMO_SEED_CACHE or module not in _DEMO_SEED_CACHE[vid]:
                continue
            seed_rows = _DEMO_SEED_CACHE[vid][module]
            if not seed_rows:
                continue
            stat = {"vehicle_id": vid}
            for sk in sensor_keys:
                vals = [r[sk] for r in seed_rows if sk in r and r[sk] is not None]
                if vals:
                    stat[f"{sk}_avg"] = round(sum(vals) / len(vals), 3)
                    stat[f"{sk}_min"] = round(min(vals), 3)
                    stat[f"{sk}_max"] = round(max(vals), 3)
            vehicle_stats.append(stat)

    return {"module": module, "vehicles": vehicle_stats, "sensor_keys": sensor_keys}
