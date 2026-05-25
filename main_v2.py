import asyncio
import logging
import aiohttp
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# --- Logging Setup ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("API_Gateway")

# --- App Definition ---
app = FastAPI(
    title="Master Dashboard API Gateway",
    description="Routes React frontend requests to isolated backend microservices"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:5173"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Microservice Registry ---
SERVICES = {
    "writer":    "http://127.0.0.1:8001",
    "inference": "http://127.0.0.1:8002",
    "gold":      "http://127.0.0.1:8003",
    "alerts":    "http://127.0.0.1:8004",
    "observer":  "http://127.0.0.1:8006",
    "dtc":       "http://127.0.0.1:8007",
    "analytics": "http://127.0.0.1:8008",
}

# --- Generic Proxy Forwarder ---
async def proxy_request(service_key: str, endpoint: str, request: Request, fallback_data: dict, timeout: int = 10):
    """Forwards requests to the underlying microservice and handles offline states gracefully."""
    base_url = SERVICES.get(service_key)
    if not base_url:
        logger.error(f"Routing failed: Unknown service '{service_key}'")
        return JSONResponse(status_code=500, content={"error": "Service routing not configured"})

    target_url = f"{base_url}{endpoint}"
    query_params = dict(request.query_params)

    logger.info(f"Routing -> {target_url} | Params: {query_params}")

    try:
        client_timeout = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=client_timeout) as session:
            async with session.get(target_url, params=query_params) as resp:
                if resp.status == 200:
                    return await resp.json()
                else:
                    error_text = await resp.text()
                    logger.error(f"Microservice {service_key} returned {resp.status}: {error_text}")
                    raise HTTPException(status_code=resp.status, detail=error_text)
                    
    except aiohttp.ClientConnectorError:
        logger.warning(f"Microservice Offline: {service_key} at {base_url}")
        # Return fallback data so React UI doesn't crash, just shows empty/offline state
        return fallback_data
    except asyncio.TimeoutError:
        logger.error(f"Microservice Timeout: {service_key} took too long to respond.")
        return JSONResponse(status_code=504, content={"error": "Microservice timeout"})
    except Exception as e:
        logger.error(f"Proxy Error on {service_key}: {str(e)}")
        return JSONResponse(status_code=500, content={"error": str(e)})

# --- Gateway Routes ---

@app.get("/health")
def health_check():
    return {"status": "Master Gateway V2 is Online", "port": 8005}

# 1. Writer Ops
@app.get("/api/writer/metrics")
async def get_writer_metrics(request: Request):
    return await proxy_request("writer", "/api/writer/metrics", request, fallback_data={})

@app.get("/api/writer/inspector/{module}")
async def get_writer_inspector(module: str, request: Request):
    return await proxy_request("writer", f"/api/writer/inspector/{module}", request, fallback_data={"data": []}, timeout=60)

# 2. Inference Ops
@app.get("/api/inference/metrics")
async def get_inference_metrics(request: Request):
    fallback = {
        "active_sims": 0, "active_modules": 0, "global_e2e_ms": 0,
        "global_inf_ms": 0, "module_stats": {}, "recent_alerts": []
    }
    return await proxy_request("inference", "/api/inference/metrics", request, fallback_data=fallback)

@app.get("/api/inference/tail/{module}")
async def get_inference_tail(module: str, request: Request):
    return await proxy_request("inference", f"/api/inference/tail/{module}", request, fallback_data={"data": []}, timeout=60)

# 3. Gold Health
@app.get("/api/gold/metrics")
async def get_gold_metrics(request: Request):
    fallback = {"active_sims": [], "total_gold_rows": 0, "processing_lags": {}}
    return await proxy_request("gold", "/api/gold/metrics", request, fallback_data=fallback)

@app.get("/api/gold/config")
async def get_gold_config(request: Request):
    return await proxy_request("gold", "/api/gold/config", request, fallback_data={})

@app.get("/api/gold/history/{sim_id}")
async def get_gold_history(sim_id: str, request: Request):
    return await proxy_request("gold", f"/api/gold/history/{sim_id}", request, fallback_data={"data": []}, timeout=60)

# 4. Alerts & DTC
@app.get("/api/alerts/metrics")
async def get_alerts_metrics(request: Request):
    fallback = {"active_alerts_count": 0, "critical_vehicles": 0, "processing_lag": 0, "open_alerts": [], "closed_alerts": []}
    return await proxy_request("alerts", "/api/alerts/metrics", request, fallback_data=fallback)

@app.get("/api/dtc/analyze")
async def analyze_dtc(request: Request):
    return await proxy_request("dtc", "/api/dtc/analyze", request, fallback_data={"error": "DTC Service Offline"}, timeout=60)

# 5. Telemetry Observer
@app.get("/api/observer/snapshot")
async def get_observer_snapshot(request: Request):
    fallback = {
        "system_health": {}, 
        "global_stats": {"total_rows": 0, "active_vehicles": 0, "avg_latency": 0.0, "dlq_backlog": 0}, 
        "vehicles": []
    }
    return await proxy_request("observer", "/api/observer/snapshot", request, fallback_data=fallback)

# 6. Analytics
@app.get("/api/heartbeat")
async def get_heartbeat(request: Request):
    return await proxy_request("analytics", "/api/heartbeat", request, fallback_data={"seq": 0, "layers": {}})

@app.get("/api/fleet/current-status")
async def get_fleet_current_status(request: Request):
    return await proxy_request("analytics", "/api/fleet/current-status", request, fallback_data={"vehicles": [], "count": 0})

@app.get("/api/fleet/health-trend")
async def get_fleet_health_trend(request: Request):
    return await proxy_request("analytics", "/api/fleet/health-trend", request, fallback_data={"vehicles": []})

@app.get("/api/fleet/alerts-summary")
async def get_fleet_alerts_summary(request: Request):
    return await proxy_request("analytics", "/api/fleet/alerts-summary", request,
                               fallback_data={"open_count": 0, "closed_count": 0, "open": [], "closed": []})

@app.get("/api/vehicle/{sim_id}/profile")
async def get_vehicle_profile(sim_id: str, request: Request):
    return await proxy_request("analytics", f"/api/vehicle/{sim_id}/profile", request,
                               fallback_data={"sim_id": sim_id, "vehicle_health": 0, "modules": {}, "top_features": {}})

@app.get("/api/vehicle/{sim_id}/gold-history")
async def get_vehicle_gold_history(sim_id: str, request: Request):
    return await proxy_request("analytics", f"/api/vehicle/{sim_id}/gold-history", request,
                               fallback_data={"sim_id": sim_id, "data": []})

@app.get("/api/vehicle/{sim_id}/silver-history/{module}")
async def get_vehicle_silver_history(sim_id: str, module: str, request: Request):
    return await proxy_request("analytics", f"/api/vehicle/{sim_id}/silver-history/{module}", request,
                               fallback_data={"sim_id": sim_id, "module": module, "data": []})

@app.get("/api/vehicle/{sim_id}/alerts")
async def get_vehicle_alerts(sim_id: str, request: Request):
    return await proxy_request("analytics", f"/api/vehicle/{sim_id}/alerts", request,
                               fallback_data={"sim_id": sim_id, "total": 0, "data": []})

@app.get("/api/module/{module}/fleet-health")
async def get_module_fleet_health(module: str, request: Request):
    return await proxy_request("analytics", f"/api/module/{module}/fleet-health", request,
                               fallback_data={"module": module, "vehicles": []})

@app.get("/api/module/{module}/sensor-history/{sim_id}")
async def get_module_sensor_history(module: str, sim_id: str, request: Request):
    return await proxy_request("analytics", f"/api/module/{module}/sensor-history/{sim_id}", request,
                               fallback_data={"ts": [], "values": []}, timeout=30)

@app.get("/api/module/{module}/sensor-fleet-history")
async def get_module_sensor_fleet_history(module: str, request: Request):
    return await proxy_request("analytics", f"/api/module/{module}/sensor-fleet-history", request,
                               fallback_data={"data": []}, timeout=30)

@app.get("/api/module/{module}/sensor-stats/{sim_id}")
async def get_module_sensor_stats(module: str, sim_id: str, request: Request):
    return await proxy_request("analytics", f"/api/module/{module}/sensor-stats/{sim_id}", request,
                               fallback_data={"stats": {}}, timeout=30)

@app.get("/api/module/{module}/feature-importance")
async def get_module_feature_importance(module: str, request: Request):
    return await proxy_request("analytics", f"/api/module/{module}/feature-importance", request,
                               fallback_data={"features": []})

@app.get("/api/dtc/history")
async def get_dtc_history(request: Request):
    return await proxy_request("analytics", "/api/dtc/history", request, fallback_data={"total": 0, "data": []})

@app.get("/api/dtc/latest")
async def get_dtc_latest(request: Request):
    return await proxy_request("analytics", "/api/dtc/latest", request, fallback_data={"entry": None})

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
try:
    from automotive_api import router as automotive_router
    app.include_router(automotive_router)
except Exception as _import_err:
    import logging as _log
    _log.getLogger(__name__).warning(f"Automotive endpoints not loaded: {_import_err}")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main_v2:app", host="127.0.0.1", port=8005, reload=True)