import React, { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import Plot from 'react-plotly.js';
import {
  Box, Typography, Paper, Select, MenuItem, FormControl, InputLabel,
  ToggleButton, ToggleButtonGroup, Chip,
} from '@mui/material';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { ClientSideRowModelModule, ModuleRegistry } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-balham.css';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store';
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  PieChart, Pie, Cell,
} from 'recharts';

ModuleRegistry.registerModules([ClientSideRowModelModule]);

const API = 'http://127.0.0.1:8005';
const ALL_MODULES = ['engine', 'transmission', 'battery', 'body', 'tyre'];

const MODULE_COLORS: Record<string, string> = {
  engine: '#e57373', transmission: '#ffb74d', battery: '#81c784',
  body: '#ba68c8', tyre: '#4dd0e1',
};

type XAxisMode = 'timestamp' | 'mileage';
type PageTab = 'fleet' | 'vehicle' | 'module';

const MODULE_CHART_GROUPS: Record<string, { title: string; sensors: { key: string; color: string; label: string }[] }[]> = {
  engine: [
    { title: 'ENGINE RPM', sensors: [{ key: 'engine_rpm_rpm', color: '#e57373', label: 'RPM' }] },
    { title: 'TEMPERATURES', sensors: [
      { key: 'ecu_7ea_engine_coolant_temperature', color: '#ff7043', label: 'Coolant °C' },
      { key: 'engine_oil_temperature', color: '#ffa726', label: 'Oil °C' },
    ]},
    { title: 'ENGINE LOAD %', sensors: [{ key: 'engine_load_absolute', color: '#ab47bc', label: 'Load %' }] },
    { title: 'FUEL FLOW (L/h)', sensors: [{ key: 'fuel_flow_rate_hour_l_hr', color: '#42a5f5', label: 'L/h' }] },
    { title: 'TURBO BOOST (psi)', sensors: [{ key: 'turbo_boost_vacuum_gauge_psi', color: '#26c6da', label: 'psi' }] },
    { title: 'MODULE VOLTAGE (V)', sensors: [{ key: 'voltage_control_module_v', color: '#66bb6a', label: 'V' }] },
  ],
  battery: [
    { title: 'STATE OF CHARGE (%)', sensors: [{ key: 'battery_state_of_charge_soc_pct', color: '#66bb6a', label: 'SoC %' }] },
    { title: 'STATE OF HEALTH (%)', sensors: [{ key: 'battery_state_of_health_soh_pct', color: '#26a69a', label: 'SoH %' }] },
    { title: 'VOLTAGE', sensors: [
      { key: 'battery_voltage_ecu_7ee', color: '#42a5f5', label: '12V (V)' },
      { key: 'hv_battery_pack_voltage', color: '#1565c0', label: 'HV Pack (V)' },
    ]},
    { title: 'CELL TEMPERATURE (°C)', sensors: [{ key: 'battery_temperature_cell', color: '#ef5350', label: '°C' }] },
    { title: 'INTERNAL RESISTANCE (Ω)', sensors: [{ key: 'internal_resistance_impedance', color: '#ab47bc', label: 'Ω' }] },
    { title: 'CHARGING POWER (kW)', sensors: [{ key: 'charging_power_kw', color: '#ec407a', label: 'kW' }] },
  ],
  body: [
    { title: 'FUEL LEVEL (%)', sensors: [{ key: 'fuel_level_pct', color: '#42a5f5', label: '%' }] },
    { title: 'CABIN TEMPERATURE (°C)', sensors: [{ key: 'cabin_temperature', color: '#66bb6a', label: '°C' }] },
    { title: 'CABIN HUMIDITY (%)', sensors: [{ key: 'cabin_humidity_pct', color: '#7e57c2', label: '%' }] },
    { title: 'HVAC & AC', sensors: [
      { key: 'hvac_blower_speed', color: '#26c6da', label: 'Blower Speed' },
      { key: 'ac_compressor_load_pct', color: '#0097a7', label: 'AC Load %' },
    ]},
    { title: 'ODOMETER (km)', sensors: [{ key: 'odometer_reading', color: '#78909c', label: 'km' }] },
  ],
  transmission: [
    { title: 'OIL TEMPERATURE (°C)', sensors: [{ key: 'transmission_oil_temperature', color: '#ffb74d', label: '°C' }] },
    { title: 'VEHICLE SPEED (km/h)', sensors: [{ key: 'vehicle_speed_kmh', color: '#42a5f5', label: 'km/h' }] },
    { title: 'ENGINE TORQUE (%)', sensors: [{ key: 'actual_engine_pct_torque', color: '#ab47bc', label: '%' }] },
    { title: 'GEAR POSITION', sensors: [{ key: 'gear_position_actual', color: '#66bb6a', label: 'Gear' }] },
    { title: 'CLUTCH SLIP', sensors: [{ key: 'clutch_engagement_per_slip', color: '#ef5350', label: 'slip' }] },
    { title: 'TC SLIP SPEED (rpm)', sensors: [{ key: 'torque_converter_slip_speed', color: '#ffa726', label: 'rpm' }] },
  ],
  tyre: [
    { title: 'PRESSURE — FRONT (psi)', sensors: [
      { key: 'tyre_pressure_fl_psi', color: '#4dd0e1', label: 'FL' },
      { key: 'tyre_pressure_fr_psi', color: '#42a5f5', label: 'FR' },
    ]},
    { title: 'PRESSURE — REAR (psi)', sensors: [
      { key: 'tyre_pressure_rl_psi', color: '#26a69a', label: 'RL' },
      { key: 'tyre_pressure_rr_psi', color: '#66bb6a', label: 'RR' },
    ]},
    { title: 'TEMP — FRONT (°C)', sensors: [
      { key: 'tyre_temp_fl_c', color: '#ef5350', label: 'FL' },
      { key: 'tyre_temp_fr_c', color: '#ff7043', label: 'FR' },
    ]},
    { title: 'WEAR — FRONT (%)', sensors: [
      { key: 'tyre_wear_fl_pct', color: '#ffa726', label: 'FL' },
      { key: 'tyre_wear_fr_pct', color: '#ffca28', label: 'FR' },
    ]},
    { title: 'WEAR — REAR (%)', sensors: [
      { key: 'tyre_wear_rl_pct', color: '#a5d6a7', label: 'RL' },
      { key: 'tyre_wear_rr_pct', color: '#80cbc4', label: 'RR' },
    ]},
  ],
};

const MODULE_KPI_FIELDS: Record<string, { key: string; label: string; unit: string; warnFn?: (v: number) => boolean }[]> = {
  engine: [
    { key: 'engine_rpm_rpm', label: 'RPM', unit: 'rpm' },
    { key: 'ecu_7ea_engine_coolant_temperature', label: 'Coolant', unit: '°C', warnFn: (v) => v > 100 },
    { key: 'engine_oil_temperature', label: 'Oil Temp', unit: '°C', warnFn: (v) => v > 110 },
    { key: 'engine_load_absolute', label: 'Load', unit: '%', warnFn: (v) => v > 75 },
    { key: 'fuel_flow_rate_hour_l_hr', label: 'Fuel Flow', unit: 'L/h' },
  ],
  battery: [
    { key: 'battery_state_of_charge_soc_pct', label: 'SoC', unit: '%', warnFn: (v) => v < 25 },
    { key: 'battery_state_of_health_soh_pct', label: 'SoH', unit: '%', warnFn: (v) => v < 85 },
    { key: 'battery_voltage_ecu_7ee', label: '12V Battery', unit: 'V', warnFn: (v) => v < 12.2 },
    { key: 'battery_temperature_cell', label: 'Cell Temp', unit: '°C', warnFn: (v) => v > 45 },
    { key: 'internal_resistance_impedance', label: 'Int. Resistance', unit: 'Ω', warnFn: (v) => v > 0.015 },
  ],
  body: [
    { key: 'fuel_level_pct', label: 'Fuel Level', unit: '%', warnFn: (v) => v < 15 },
    { key: 'cabin_temperature', label: 'Cabin Temp', unit: '°C' },
    { key: 'cabin_humidity_pct', label: 'Humidity', unit: '%' },
    { key: 'ac_compressor_load_pct', label: 'AC Load', unit: '%' },
    { key: 'odometer_reading', label: 'Odometer', unit: 'km' },
  ],
  transmission: [
    { key: 'transmission_oil_temperature', label: 'Oil Temp', unit: '°C', warnFn: (v) => v > 95 },
    { key: 'vehicle_speed_kmh', label: 'Speed', unit: 'km/h' },
    { key: 'gear_position_actual', label: 'Gear', unit: '' },
    { key: 'actual_engine_pct_torque', label: 'Torque', unit: '%' },
    { key: 'torque_converter_slip_speed', label: 'TC Slip', unit: 'rpm', warnFn: (v) => v > 80 },
  ],
  tyre: [
    { key: 'tyre_pressure_fl_psi', label: 'FL Pressure', unit: 'psi', warnFn: (v) => v < 30 || v > 38 },
    { key: 'tyre_pressure_fr_psi', label: 'FR Pressure', unit: 'psi', warnFn: (v) => v < 30 || v > 38 },
    { key: 'tyre_wear_fl_pct', label: 'FL Wear', unit: '%', warnFn: (v) => v < 70 },
    { key: 'tyre_wear_fr_pct', label: 'FR Wear', unit: '%', warnFn: (v) => v < 70 },
    { key: 'tyre_temp_fl_c', label: 'FL Temp', unit: '°C', warnFn: (v) => v > 80 },
  ],
};

const axisStyle = { fontSize: '10px', fill: '#616161', fontWeight: 600 };
const SHAP_COLORS = ['#e53935', '#fb8c00', '#8e24aa', '#1e88e5', '#43a047', '#6d4c41'];

function formatXTick(val: string | number, mode: XAxisMode): string {
  if (mode === 'mileage') return `${Math.round(Number(val)).toLocaleString()}`;
  const s = String(val);
  if (s.includes('T')) return s.slice(5, 16).replace('T', ' ');
  if (s.length >= 16) return s.slice(5, 16);
  return s;
}

function parseTopFeatures(raw: string): { feature: string; score: number }[] {
  if (!raw) return [];
  try {
    const obj = JSON.parse(String(raw));
    return Object.entries(obj)
      .map(([k, v]) => ({ feature: k, score: Number(v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  } catch {
    return String(raw)
      .split(',')
      .map((part) => {
        const [f, s] = part.trim().split(':');
        return { feature: (f || '').trim(), score: Number((s || '0').trim()) };
      })
      .filter((x) => x.feature && !isNaN(x.score))
      .slice(0, 5);
  }
}

function SensorChart({
  data,
  group,
  xAxisMode,
  height = 210,
}: {
  data: any[];
  group: { title: string; sensors: { key: string; color: string; label: string }[] };
  xAxisMode: XAxisMode;
  height?: number | string;
}) {
  const xKey = xAxisMode === 'timestamp' ? 'timestamp' : 'mileage';
  return (
    <Paper sx={{ p: 1.5, borderRadius: 0, height, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', letterSpacing: '0.5px', mb: 0.5 }}>
        {group.title}
      </Typography>
      <Box sx={{ flex: 1 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
            <XAxis
              dataKey={xKey}
              tick={axisStyle}
              axisLine={{ stroke: '#bdbdbd' }}
              tickLine={false}
              minTickGap={40}
              tickFormatter={(v) => formatXTick(v, xAxisMode)}
            />
            <YAxis tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
            <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px', padding: '6px 10px' }} formatter={(v: number) => v.toFixed(2)} />
            {group.sensors.length > 1 && <Legend wrapperStyle={{ fontSize: '10px', fontWeight: 'bold', paddingTop: 2 }} />}
            {group.sensors.map((s) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Box>
    </Paper>
  );
}

export default function AutomotiveDive() {
  const { autoRefresh } = useStore();
  const [searchParams] = useSearchParams();

  const _initVehicle = searchParams.get('vehicle') || '';
  const _initModule = searchParams.get('module') || 'engine';
  const _initTab = searchParams.get('tab') as PageTab | null;

  const [activeTab, setActiveTab] = useState<PageTab>(_initTab === 'vehicle' || _initTab === 'module' ? _initTab : 'fleet');
  const [xAxisMode, setXAxisMode] = useState<XAxisMode>('timestamp');
  const [selectedVehicle, setSelectedVehicle] = useState<string>(_initVehicle);
  const [selectedModule, setSelectedModule] = useState<string>(ALL_MODULES.includes(_initModule) ? _initModule : 'engine');
  const [analysisModule, setAnalysisModule] = useState<string>('engine');
  const [analysisKey, setAnalysisKey] = useState<string>('');
  const [dtcResult, setDtcResult] = useState<any>(null);
  const [dtcRunning, setDtcRunning] = useState(false);

  const fleetQuery = useQuery({
    queryKey: ['autoFleetSummary'],
    queryFn: () => axios.get(`${API}/api/automotive/fleet-summary`).then((r) => r.data),
    refetchInterval: autoRefresh ? 3000 : false,
  });

  // BRONZE — raw sensor time series
  const sensorQuery = useQuery({
    queryKey: ['autoSensorHistory', selectedVehicle, selectedModule],
    queryFn: () =>
      axios.get(`${API}/api/automotive/sensor-history/${selectedVehicle}/${selectedModule}`).then((r) => r.data),
    enabled: !!selectedVehicle && activeTab === 'vehicle',
    refetchInterval: autoRefresh ? 5000 : false,
  });

  // SILVER — ML health scores + severity + top features
  const moduleHealthQuery = useQuery({
    queryKey: ['autoModuleHealth', selectedVehicle, selectedModule],
    queryFn: () =>
      axios.get(`${API}/api/automotive/module-health/${selectedVehicle}/${selectedModule}`).then((r) => r.data),
    enabled: !!selectedVehicle && activeTab === 'vehicle',
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const vehicleHealthQuery = useQuery({
    queryKey: ['autoVehicleHealth', selectedVehicle],
    queryFn: () =>
      axios.get(`${API}/api/automotive/vehicle-health-history/${selectedVehicle}`).then((r) => r.data),
    enabled: !!selectedVehicle && activeTab === 'vehicle',
    refetchInterval: autoRefresh ? 3000 : false,
  });

  // Module analysis cross-fleet (Bronze stats per vehicle per module)
  const crossfleetQuery = useQuery({
    queryKey: ['autoCrossfleet', analysisModule],
    queryFn: () =>
      axios.get(`${API}/api/automotive/module-crossfleet/${analysisModule}`).then((r) => r.data),
    enabled: activeTab === 'module',
    refetchInterval: false,
  });

  const vehicleAlertsQuery = useQuery({
    queryKey: ['autoVehicleAlerts', selectedVehicle],
    queryFn: () => axios.get(`${API}/api/automotive/alerts/${selectedVehicle}`).then((r) => r.data),
    enabled: !!selectedVehicle && activeTab === 'vehicle',
    refetchInterval: autoRefresh ? 10000 : false,
  });

  const dtcHistoryQuery = useQuery({
    queryKey: ['autoDtcHistory', selectedVehicle],
    queryFn: () => axios.get(`${API}/api/automotive/dtc-history/${selectedVehicle}`).then((r) => r.data),
    enabled: !!selectedVehicle && activeTab === 'vehicle',
    refetchInterval: false,
  });

  // Module tab sensor timeline — separate from vehicle tab's sensorQuery
  const moduleTimelineQuery = useQuery({
    queryKey: ['autoModuleTimeline', selectedVehicle, analysisModule],
    queryFn: () =>
      axios.get(`${API}/api/automotive/sensor-history/${selectedVehicle}/${analysisModule}`).then((r) => r.data),
    enabled: !!selectedVehicle && activeTab === 'module',
    refetchInterval: false,
  });

  useEffect(() => {
    const vehicles = fleetQuery.data?.vehicles;
    if (vehicles?.length > 0 && !selectedVehicle) setSelectedVehicle(vehicles[0].vehicle_id);
  }, [fleetQuery.data]);

  useEffect(() => {
    const keys = crossfleetQuery.data?.sensor_keys;
    if (keys?.length > 0 && !analysisKey) setAnalysisKey(keys[0]);
  }, [crossfleetQuery.data]);

  const vehicles: any[] = fleetQuery.data?.vehicles || [];
  const fleetStats = fleetQuery.data?.fleet_stats || {};

  // BRONZE derived
  const sensorData: any[] = sensorQuery.data?.data || [];
  const latestBronzeRow: any = sensorData.length > 0 ? sensorData[sensorData.length - 1] : null;
  const downsampledBronze = useMemo(() => {
    const factor = Math.max(1, Math.floor(sensorData.length / 400));
    return factor === 1 ? sensorData : sensorData.filter((_: any, i: number) => i % factor === 0);
  }, [sensorData]);

  // SILVER derived
  const moduleHealthData: any[] = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    const factor = Math.max(1, Math.floor(raw.length / 400));
    return factor === 1 ? raw : raw.filter((_: any, i: number) => i % factor === 0);
  }, [moduleHealthQuery.data]);

  const latestSilverRow: any = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    return raw.length > 0 ? raw[raw.length - 1] : null;
  }, [moduleHealthQuery.data]);

  const topFeatures = useMemo(
    () => parseTopFeatures(latestSilverRow?.top_features || ''),
    [latestSilverRow],
  );

  const latestSeverity: string = latestSilverRow?.severity || 'NORMAL';
  const severityColor = latestSeverity === 'CRITICAL' ? '#d32f2f' : latestSeverity === 'WARNING' ? '#ed6c02' : '#2e7d32';

  // GOLD derived
  const healthHistory = useMemo(() => {
    const raw: any[] = vehicleHealthQuery.data?.data || [];
    const factor = Math.max(1, Math.floor(raw.length / 400));
    const sampled = factor === 1 ? raw : raw.filter((_: any, i: number) => i % factor === 0);
    return sampled.map((r: any) => ({
      ts: r.ts || String(r.timestamp || '').slice(5, 16),
      health: r.health,
      mileage: r.mileage ?? 0,
    }));
  }, [vehicleHealthQuery.data]);

  // Fleet/module analysis derived
  const fleetChartData = useMemo(
    () => vehicles.map((v: any) => ({ vehicle_id: v.vehicle_id, health_score: v.health_score })),
    [vehicles],
  );

  const crossfleetVehicles: any[] = crossfleetQuery.data?.vehicles || [];
  const sensorKeys: string[] = crossfleetQuery.data?.sensor_keys || [];
  const currentAnalysisKey = analysisKey || sensorKeys[0] || '';

  const crossfleetChartData = useMemo(
    () =>
      crossfleetVehicles.map((v: any) => ({
        vehicle_id: v.vehicle_id,
        avg: v[`${currentAnalysisKey}_avg`] ?? 0,
        min: v[`${currentAnalysisKey}_min`] ?? 0,
        max: v[`${currentAnalysisKey}_max`] ?? 0,
      })),
    [crossfleetVehicles, currentAnalysisKey],
  );

  const moduleTimelineData: any[] = useMemo(() => {
    const raw: any[] = moduleTimelineQuery.data?.data || [];
    const factor = Math.max(1, Math.floor(raw.length / 300));
    return factor === 1 ? raw : raw.filter((_: any, i: number) => i % factor === 0);
  }, [moduleTimelineQuery.data]);

  const fleetColDefs = useMemo<ColDef[]>(
    () => [
      { field: 'vehicle_id', headerName: 'VEHICLE ID', width: 120, pinned: 'left', sortable: true, filter: true },
      {
        field: 'health_score', headerName: 'HEALTH SCORE', width: 130, sortable: true,
        cellStyle: (params: any) => ({
          fontWeight: 'bold',
          color: params.value < 60 ? '#d32f2f' : params.value < 80 ? '#f57c00' : '#388e3c',
        }),
      },
      ...ALL_MODULES.map((mod) => ({
        field: `${mod}_contrib`, headerName: mod.toUpperCase(), width: 100, sortable: true,
        valueFormatter: (params: any) => params.value != null ? params.value.toFixed(3) : '—',
      })),
      {
        field: 'data_source', headerName: 'SOURCE', width: 90,
        cellRenderer: (params: any) => (
          <Chip size="small" label={params.value} color={params.value === 'live' ? 'success' : 'default'}
            sx={{ borderRadius: 0, height: 18, fontSize: '10px' }} />
        ),
      },
    ],
    [],
  );

  const chartGroups = MODULE_CHART_GROUPS[selectedModule] || [];
  const kpiFields = MODULE_KPI_FIELDS[selectedModule] || [];

  const runDtcAnalysis = async () => {
    if (!selectedVehicle) return;
    const peakTs = vehicleAlertsQuery.data?.open?.[0]?.peak_anomaly_ts
      || vehicleAlertsQuery.data?.closed?.[0]?.peak_anomaly_ts
      || latestBronzeRow?.timestamp
      || new Date().toISOString();
    setDtcRunning(true);
    setDtcResult(null);
    try {
      const res = await axios.get('http://127.0.0.1:8007/api/dtc/analyze', {
        params: { module: selectedModule, source_id: selectedVehicle, peak_ts: peakTs },
        timeout: 60000,
      });
      setDtcResult(res.data);
    } catch {
      setDtcResult({ error: 'DTC service offline or unreachable (port 8007). Start dtc_service/api.py to enable analysis.' });
    } finally {
      setDtcRunning(false);
    }
  };

  const decompositionHistory = useMemo(() => {
    const raw: any[] = vehicleHealthQuery.data?.data || [];
    const factor = Math.max(1, Math.floor(raw.length / 400));
    const sampled = factor === 1 ? raw : raw.filter((_: any, i: number) => i % factor === 0);
    return sampled.map((r: any) => ({
      ts: r.ts || String(r.timestamp || '').slice(5, 16),
      mileage: r.mileage ?? 0,
      ...Object.fromEntries(ALL_MODULES.map((mod) => [mod, Math.round(r[`${mod}_contrib`] ?? 0)])),
    }));
  }, [vehicleHealthQuery.data]);

  const radarData = useMemo(() => {
    const v = vehicles.find((v: any) => v.vehicle_id === selectedVehicle);
    if (!v) return ALL_MODULES.map((mod) => ({ module: mod.toUpperCase(), score: 0, fullMark: 100 }));
    return ALL_MODULES.map((mod) => ({
      module: mod.toUpperCase(),
      score: Math.round(v[`${mod}_contrib`] ?? 0),
      fullMark: 100,
    }));
  }, [vehicles, selectedVehicle]);

  const { anomalyTrendSeries, anomalyTrendData } = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    if (!raw.length) return { anomalyTrendSeries: [] as string[], anomalyTrendData: [] as any[] };
    const featureSet = new Set<string>();
    raw.forEach((r: any) => parseTopFeatures(r.top_features || '').forEach((f) => featureSet.add(f.feature)));
    const series = Array.from(featureSet).slice(0, 6);
    const factor = Math.max(1, Math.floor(raw.length / 300));
    const sampled = factor === 1 ? raw : raw.filter((_: any, i: number) => i % factor === 0);
    const data: any[] = sampled.map((r: any) => {
      const fm: Record<string, number> = {};
      parseTopFeatures(r.top_features || '').forEach((f) => { fm[f.feature] = f.score; });
      const row: Record<string, any> = { ts: String(r.timestamp || '').slice(5, 16), mileage: r.mileage ?? 0 };
      series.forEach((s) => { row[s] = fm[s] ?? 0; });
      return row;
    });
    return { anomalyTrendSeries: series, anomalyTrendData: data };
  }, [moduleHealthQuery.data]);

  const severityDistribution = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    const counts: Record<string, number> = { NORMAL: 0, WARNING: 0, CRITICAL: 0 };
    raw.forEach((r: any) => { const s = r.severity || 'NORMAL'; counts[s] = (counts[s] || 0) + 1; });
    const total = raw.length || 1;
    return [
      { name: 'NORMAL',   value: counts.NORMAL,   pct: Math.round(counts.NORMAL   / total * 100), color: '#2e7d32' },
      { name: 'WARNING',  value: counts.WARNING,  pct: Math.round(counts.WARNING  / total * 100), color: '#ed6c02' },
      { name: 'CRITICAL', value: counts.CRITICAL, pct: Math.round(counts.CRITICAL / total * 100), color: '#d32f2f' },
    ];
  }, [moduleHealthQuery.data]);

  const severityRuns = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    if (!raw.length) return [] as { severity: string; count: number; startTs: string; endTs: string }[];
    type Run = { severity: string; count: number; startTs: string; endTs: string };
    const runs: Run[] = [];
    let cur: Run = { severity: raw[0].severity || 'NORMAL', count: 1, startTs: String(raw[0].timestamp || '').slice(5, 16), endTs: '' };
    for (let i = 1; i < raw.length; i++) {
      const s = raw[i].severity || 'NORMAL';
      if (s === cur.severity) {
        cur.count++;
      } else {
        cur.endTs = String(raw[i - 1].timestamp || '').slice(5, 16);
        runs.push({ ...cur });
        cur = { severity: s, count: 1, startTs: String(raw[i].timestamp || '').slice(5, 16), endTs: '' };
      }
    }
    cur.endTs = String(raw[raw.length - 1].timestamp || '').slice(5, 16);
    runs.push(cur);
    return runs;
  }, [moduleHealthQuery.data]);

  const sensorStats = useMemo(() => {
    if (!sensorData.length) return [] as any[];
    return kpiFields.map((f) => {
      const vals = sensorData.map((r: any) => Number(r[f.key])).filter((v) => !isNaN(v) && isFinite(v));
      if (!vals.length) return { ...f, min: null, max: null, mean: null, std: null, latest: null };
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
      return {
        ...f,
        min: Math.min(...vals),
        max: Math.max(...vals),
        mean,
        std,
        latest: latestBronzeRow ? Number(latestBronzeRow[f.key]) : null,
      };
    });
  }, [sensorData, kpiFields, latestBronzeRow]);

  return (
    <Box sx={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', gap: 2, p: 2, bgcolor: '#f5f5f5' }}>

      {/* ── HEADER ── */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #bdbdbd', pb: 1, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#212121', letterSpacing: '-0.5px' }}>
          AUTOMOTIVE DEEP DIVE
        </Typography>
        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <ToggleButtonGroup value={activeTab} exclusive onChange={(_e, val) => val && setActiveTab(val)} size="small" sx={{ bgcolor: 'white' }}>
            <ToggleButton value="fleet" sx={{ fontWeight: 'bold', px: 2, borderRadius: 0, fontSize: '12px' }}>FLEET OVERVIEW</ToggleButton>
            <ToggleButton value="vehicle" sx={{ fontWeight: 'bold', px: 2, borderRadius: 0, fontSize: '12px' }}>VEHICLE DEEP DIVE</ToggleButton>
            <ToggleButton value="module" sx={{ fontWeight: 'bold', px: 2, borderRadius: 0, fontSize: '12px' }}>MODULE ANALYSIS</ToggleButton>
          </ToggleButtonGroup>

          <ToggleButtonGroup value={xAxisMode} exclusive onChange={(_e, val) => val && setXAxisMode(val)} size="small" sx={{ bgcolor: 'white' }}>
            <ToggleButton value="timestamp" sx={{ fontWeight: 'bold', px: 1.5, borderRadius: 0, fontSize: '11px' }}>TIMESTAMP</ToggleButton>
            <ToggleButton value="mileage" sx={{ fontWeight: 'bold', px: 1.5, borderRadius: 0, fontSize: '11px' }}>MILEAGE</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      {/* ── FLEET OVERVIEW ── */}
      {activeTab === 'fleet' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minHeight: 0 }}>
          {!fleetQuery.isLoading && vehicles.length === 0 && (
            <Box sx={{ p: 2, bgcolor: '#fff8e1', border: '1px solid #ffe082' }}>
              <Typography variant="body2" sx={{ color: '#e65100', fontWeight: 'bold' }}>
                No vehicle data. Start the streaming pipeline to populate fleet data.
              </Typography>
            </Box>
          )}
          <Box sx={{ display: 'flex', gap: 2 }}>
            {[
              { label: 'TOTAL VEHICLES', value: fleetStats.total_vehicles ?? 0, color: '#212121' },
              { label: 'AVG FLEET HEALTH', value: `${fleetStats.avg_health ?? 0}%`, color: (fleetStats.avg_health ?? 100) < 60 ? '#d32f2f' : '#2e7d32' },
              { label: 'CRITICAL ( < 60% )', value: fleetStats.critical_count ?? 0, color: (fleetStats.critical_count ?? 0) > 0 ? '#d32f2f' : '#212121' },
              { label: 'WARNING ( 60–80% )', value: fleetStats.warning_count ?? 0, color: (fleetStats.warning_count ?? 0) > 0 ? '#ed6c02' : '#212121' },
            ].map((kpi, i) => (
              <Paper key={i} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: '4px solid #2c3e50' }}>
                <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold' }}>{kpi.label}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color, mt: 0.5 }}>{kpi.value}</Typography>
              </Paper>
            ))}
          </Box>

          <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
            <Paper sx={{ width: 320, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1 }}>VEHICLE HEALTH COMPARISON</Typography>
              <Box sx={{ flex: 1 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fleetChartData} layout="vertical" margin={{ top: 0, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eeeeee" />
                    <XAxis type="number" domain={[0, 100]} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <YAxis type="category" dataKey="vehicle_id" tick={{ fontSize: 11, fontWeight: 600, fill: '#424242' }} axisLine={false} tickLine={false} width={65} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px' }} formatter={(v: number) => `${v}%`} />
                    <ReferenceLine x={60} stroke="#d32f2f" strokeDasharray="4 4" />
                    <ReferenceLine x={80} stroke="#ed6c02" strokeDasharray="4 4" />
                    <Bar dataKey="health_score" name="Health" fill="#2c3e50" isAnimationActive={false}
                      label={{ position: 'right', fontSize: 10, fontWeight: 'bold', fill: '#424242' }} />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            </Paper>

            <Paper sx={{ flex: 1, borderRadius: 0, display: 'flex', flexDirection: 'column', p: 0 }}>
              <Box sx={{ p: 1.5, borderBottom: '1px solid #e0e0e0' }}>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                  FLEET HEALTH TABLE — MODULE CONTRIBUTIONS (GOLD)
                </Typography>
              </Box>
              <Box className="ag-theme-balham" sx={{ flexGrow: 1 }}>
                <AgGridReact rowData={vehicles} columnDefs={fleetColDefs} defaultColDef={{ resizable: true, sortable: true }} />
              </Box>
            </Paper>
          </Box>
        </Box>
      )}

      {/* ── VEHICLE DEEP DIVE ── */}
      {activeTab === 'vehicle' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minHeight: 0, overflow: 'auto' }}>

          {/* Controls */}
          <Paper sx={{ p: 1.5, borderRadius: 0, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold' }}>CONTEXT:</Typography>
            <FormControl size="small" sx={{ minWidth: 180 }}>
              <InputLabel>Vehicle</InputLabel>
              <Select value={selectedVehicle} onChange={(e) => setSelectedVehicle(e.target.value)} label="Vehicle" sx={{ borderRadius: 0 }}>
                {vehicles.map((v: any) => <MenuItem key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_id}</MenuItem>)}
              </Select>
            </FormControl>
            <ToggleButtonGroup value={selectedModule} exclusive onChange={(_e, val) => val && setSelectedModule(val)} size="small" sx={{ bgcolor: 'white' }}>
              {ALL_MODULES.map((mod) => (
                <ToggleButton key={mod} value={mod} sx={{ fontWeight: 'bold', px: 1.5, borderRadius: 0, fontSize: '11px',
                  '&.Mui-selected': { bgcolor: MODULE_COLORS[mod], color: 'white', '&:hover': { bgcolor: MODULE_COLORS[mod] } } }}>
                  {mod.toUpperCase()}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Chip size="small" label={`${sensorData.length} Bronze pts`} sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '11px' }} />
            <Chip size="small" label={`${moduleHealthQuery.data?.count ?? 0} Silver pts`}
              sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '11px', bgcolor: '#e3f2fd' }} />
          </Paper>

          {/* GOLD + SILVER health charts side by side */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            {/* GOLD: Fused vehicle health */}
            <Paper sx={{ flex: 1, p: 1.5, borderRadius: 0, height: 260, display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                  FUSED VEHICLE HEALTH — {selectedVehicle} &nbsp;
                  <span style={{ color: '#9e9e9e' }}>(GOLD)</span>
                </Typography>
                <Chip size="small" label={vehicleHealthQuery.data?.data_source || '—'}
                  sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', height: 18 }} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={healthHistory} margin={{ top: 4, right: 15, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                    <XAxis dataKey={xAxisMode === 'mileage' ? 'mileage' : 'ts'} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} minTickGap={40} tickFormatter={(v) => formatXTick(v, xAxisMode)} />
                    <YAxis domain={[0, 100]} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px' }} formatter={(v: number) => `${v.toFixed(1)}%`} />
                    <ReferenceLine y={60} stroke="#d32f2f" strokeDasharray="4 4" />
                    <ReferenceLine y={80} stroke="#ed6c02" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="health" name="Health %" stroke="#1976d2" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            </Paper>

            {/* SILVER: Per-module ML health */}
            <Paper sx={{ flex: 1, p: 1.5, borderRadius: 0, height: 260, display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                  {selectedModule.toUpperCase()} ML HEALTH SCORE &nbsp;
                  <span style={{ color: '#9e9e9e' }}>(SILVER)</span>
                </Typography>
                <Chip size="small" label={latestSeverity}
                  sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', height: 18, bgcolor: severityColor, color: 'white' }} />
              </Box>
              <Box sx={{ flex: 1 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={moduleHealthData} margin={{ top: 4, right: 15, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                    <XAxis
                      dataKey={xAxisMode === 'timestamp' ? 'timestamp' : 'mileage'}
                      tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} minTickGap={40}
                      tickFormatter={(v) => formatXTick(v, xAxisMode)}
                    />
                    <YAxis domain={[0, 100]} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px' }} formatter={(v: number) => `${v.toFixed(1)}%`} />
                    <ReferenceLine y={60} stroke="#d32f2f" strokeDasharray="4 4" label={{ value: 'CRIT', fontSize: 9, fill: '#d32f2f' }} />
                    <ReferenceLine y={80} stroke="#ed6c02" strokeDasharray="4 4" label={{ value: 'WARN', fontSize: 9, fill: '#ed6c02' }} />
                    <Line type="monotone" dataKey="health_score" name="ML Health"
                      stroke={MODULE_COLORS[selectedModule]} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </Box>
            </Paper>

            {/* Top anomaly drivers (Silver top_features) */}
            <Paper sx={{ width: 240, p: 1.5, borderRadius: 0, height: 260, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1 }}>
                TOP ANOMALY DRIVERS
              </Typography>
              {topFeatures.length > 0 ? (
                topFeatures.map((f) => (
                  <Box key={f.feature} sx={{ mb: 1 }}>
                    <Typography variant="caption" sx={{ fontSize: '10px', fontWeight: 600 }}>
                      {f.feature.replace(/_/g, ' ')}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Box sx={{ flex: 1, height: 5, bgcolor: '#eeeeee', borderRadius: '2px', overflow: 'hidden' }}>
                        <Box sx={{ width: `${Math.min(100, f.score * 200)}%`, height: '100%', bgcolor: '#d32f2f' }} />
                      </Box>
                      <Typography variant="caption" sx={{ fontSize: '10px', fontWeight: 'bold', minWidth: 28 }}>
                        {f.score.toFixed(2)}
                      </Typography>
                    </Box>
                  </Box>
                ))
              ) : (
                <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No Silver data yet</Typography>
              )}
            </Paper>
          </Box>

          {/* KPI cards — Bronze latest values */}
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
            {kpiFields.map((f) => {
              const val = latestBronzeRow ? Number(latestBronzeRow[f.key] ?? 0) : null;
              const isWarn = val !== null && f.warnFn ? f.warnFn(val) : false;
              return (
                <Paper key={f.key} sx={{ p: 1.5, borderRadius: 0, minWidth: 110, borderLeft: `4px solid ${isWarn ? '#d32f2f' : MODULE_COLORS[selectedModule]}` }}>
                  <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold', fontSize: '10px' }}>{f.label}</Typography>
                  <Typography variant="h6" sx={{ fontWeight: 'bold', color: isWarn ? '#d32f2f' : '#212121', fontSize: '1.1rem', mt: 0.25 }}>
                    {val !== null ? `${val.toFixed(2)} ${f.unit}` : '—'}
                  </Typography>
                </Paper>
              );
            })}
          </Box>

          {/* Bronze sensor charts grid */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5 }}>
            {chartGroups.map((group) => (
              <SensorChart key={group.title} data={downsampledBronze} group={group} xAxisMode={xAxisMode} />
            ))}
          </Box>

          {/* ── SECTION DIVIDER ── */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 0.5 }}>
            <Box sx={{ flex: 1, height: '1px', bgcolor: '#e0e0e0' }} />
            <Typography variant="caption" sx={{ color: '#9e9e9e', fontWeight: 'bold', fontFamily: 'monospace', letterSpacing: 1, whiteSpace: 'nowrap' }}>
              HEALTH ANALYTICS
            </Typography>
            <Box sx={{ flex: 1, height: '1px', bgcolor: '#e0e0e0' }} />
          </Box>

          {/* ── ROW A: Health decomposition stacked area ── */}
          <Paper sx={{ p: 1.5, borderRadius: 0, height: 260, display: 'flex', flexDirection: 'column' }}>
            <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
              HEALTH DECOMPOSITION — ALL MODULE CONTRIBUTIONS OVER TIME &nbsp;
              <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(GOLD)</span>
            </Typography>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              {decompositionHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={decompositionHistory} margin={{ top: 4, right: 15, left: -25, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                    <XAxis dataKey={xAxisMode === 'mileage' ? 'mileage' : 'ts'} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} minTickGap={40} tickFormatter={(v) => formatXTick(v, xAxisMode)} />
                    <YAxis domain={[0, 100]} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px', padding: '6px 10px' }} formatter={(v: any) => [`${v}%`]} />
                    <Legend wrapperStyle={{ fontSize: '10px', fontWeight: 'bold', paddingTop: 2 }} />
                    {ALL_MODULES.map((mod) => (
                      <Area key={mod} type="monotone" dataKey={mod} name={mod.toUpperCase()} stroke={MODULE_COLORS[mod]} fill={MODULE_COLORS[mod]} fillOpacity={0.15} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No gold history — select a vehicle and load data</Typography>
                </Box>
              )}
            </Box>
          </Paper>

          {/* ── ROW B: Module health radar + Severity transition strip ── */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Paper sx={{ width: 290, p: 1.5, borderRadius: 0, height: 280, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
                MODULE HEALTH RADAR — {selectedVehicle || '—'}
              </Typography>
              <Box sx={{ flex: 1, minHeight: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData} margin={{ top: 10, right: 20, bottom: 10, left: 20 }}>
                    <PolarGrid stroke="#e0e0e0" />
                    <PolarAngleAxis dataKey="module" tick={{ fontSize: 10, fontWeight: 700, fill: '#424242', fontFamily: 'monospace' } as any} />
                    <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} axisLine={false} />
                    <Radar name="Health %" dataKey="score" stroke="#1976d2" fill="#1976d2" fillOpacity={0.2} isAnimationActive={false} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px' }} formatter={(v: any) => [`${v}%`, 'Health']} />
                  </RadarChart>
                </ResponsiveContainer>
              </Box>
            </Paper>

            <Paper sx={{ flex: 1, p: 1.5, borderRadius: 0, height: 280, display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                  SEVERITY TRANSITION HISTORY — {selectedModule.toUpperCase()} &nbsp;
                  <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(SILVER)</span>
                </Typography>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  {[{ label: 'NORMAL', color: '#2e7d32' }, { label: 'WARNING', color: '#ed6c02' }, { label: 'CRITICAL', color: '#d32f2f' }].map((s) => (
                    <Box key={s.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <Box sx={{ width: 10, height: 10, bgcolor: s.color, borderRadius: '2px' }} />
                      <Typography variant="caption" sx={{ fontSize: '10px', color: '#616161', fontFamily: 'monospace' }}>{s.label}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
              {severityRuns.length > 0 ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, flex: 1 }}>
                  <Box sx={{ display: 'flex', height: 44, width: '100%', overflow: 'hidden', borderRadius: '2px', border: '1px solid #e0e0e0' }}>
                    {severityRuns.map((run, i) => (
                      <Box
                        key={i}
                        title={`${run.severity}: ${run.startTs} → ${run.endTs} (${run.count} pts)`}
                        sx={{
                          flex: run.count,
                          bgcolor: run.severity === 'CRITICAL' ? '#d32f2f' : run.severity === 'WARNING' ? '#ed6c02' : '#2e7d32',
                          '&:hover': { opacity: 0.75, cursor: 'default' },
                        }}
                      />
                    ))}
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" sx={{ fontSize: '10px', color: '#9e9e9e', fontFamily: 'monospace' }}>
                      {severityRuns[0]?.startTs}
                    </Typography>
                    <Typography variant="caption" sx={{ fontSize: '10px', color: '#9e9e9e', fontFamily: 'monospace' }}>
                      {severityRuns[severityRuns.length - 1]?.endTs}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 3, mt: 0.5 }}>
                    {severityDistribution.map((d) => (
                      <Box key={d.name} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                        <Typography variant="h6" sx={{ fontWeight: 'bold', color: d.color, fontFamily: 'monospace', lineHeight: 1.1 }}>
                          {d.pct}%
                        </Typography>
                        <Typography variant="caption" sx={{ fontSize: '10px', color: '#757575', fontFamily: 'monospace' }}>{d.name}</Typography>
                        <Typography variant="caption" sx={{ fontSize: '9px', color: '#9e9e9e', fontFamily: 'monospace' }}>{d.value} pts</Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              ) : (
                <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No silver data for this module</Typography>
                </Box>
              )}
            </Paper>
          </Box>

          {/* ── ROW C: Anomaly driver trends + Severity distribution donut ── */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Paper sx={{ flex: 2, p: 1.5, borderRadius: 0, height: 280, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
                ANOMALY DRIVER TRENDS — SHAP FEATURE IMPORTANCE OVER TIME &nbsp;
                <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>({selectedModule.toUpperCase()} SILVER)</span>
              </Typography>
              <Box sx={{ flex: 1, minHeight: 0 }}>
                {anomalyTrendData.length > 0 && anomalyTrendSeries.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={anomalyTrendData} margin={{ top: 4, right: 15, left: -25, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                      <XAxis dataKey={xAxisMode === 'mileage' ? 'mileage' : 'ts'} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} minTickGap={50} tickFormatter={(v) => formatXTick(v, xAxisMode)} />
                      <YAxis domain={[0, 1]} tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} tickFormatter={(v: number) => v.toFixed(1)} />
                      <Tooltip contentStyle={{ borderRadius: 0, fontSize: '10px', padding: '4px 8px' }} formatter={(v: any, name: any) => [Number(v).toFixed(3), String(name).replace(/_/g, ' ')]} />
                      <Legend wrapperStyle={{ fontSize: '9px', fontWeight: 'bold' }} formatter={(value: any) => String(value).replace(/_/g, ' ').slice(0, 22)} />
                      {anomalyTrendSeries.map((feature, i) => (
                        <Line key={feature} type="monotone" dataKey={feature} name={feature} stroke={SHAP_COLORS[i] || '#9e9e9e'} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No SHAP data in silver history</Typography>
                  </Box>
                )}
              </Box>
            </Paper>

            <Paper sx={{ flex: 1, p: 1.5, borderRadius: 0, height: 280, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
                SEVERITY DISTRIBUTION — {selectedModule.toUpperCase()}
              </Typography>
              <Box sx={{ flex: 1, minHeight: 0 }}>
                {moduleHealthData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={severityDistribution}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="45%"
                        innerRadius={52}
                        outerRadius={78}
                        isAnimationActive={false}
                      >
                        {severityDistribution.map((entry, i) => (
                          <Cell key={i} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ borderRadius: 0, fontSize: '11px' }}
                        formatter={(v: any, name: any) => {
                          const d = severityDistribution.find((x) => x.name === name);
                          return [`${v} pts (${d?.pct ?? 0}%)`, name];
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: '10px', fontWeight: 'bold' }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                    <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No severity data</Typography>
                  </Box>
                )}
              </Box>
            </Paper>
          </Box>

          {/* ── ROW D: Bronze sensor statistics table ── */}
          <Paper sx={{ p: 1.5, borderRadius: 0 }}>
            <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1, display: 'block' }}>
              BRONZE SENSOR STATISTICS — {selectedModule.toUpperCase()} &nbsp;
              <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>({sensorData.length.toLocaleString()} data points)</span>
            </Typography>
            {sensorStats.length > 0 ? (
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #bdbdbd' }}>
                      {['SENSOR', 'UNIT', 'MIN', 'MAX', 'MEAN', 'STD DEV', 'LATEST'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 12px', color: '#616161', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sensorStats.map((s: any, i: number) => {
                      const isWarn = s.latest !== null && !isNaN(s.latest) && s.warnFn ? s.warnFn(s.latest) : false;
                      return (
                        <tr key={s.key} style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fafafa' : 'white' }}>
                          <td style={{ padding: '5px 12px', fontWeight: 600 }}>{s.label}</td>
                          <td style={{ padding: '5px 12px', color: '#9e9e9e' }}>{s.unit || '—'}</td>
                          <td style={{ padding: '5px 12px' }}>{s.min !== null ? s.min.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 12px' }}>{s.max !== null ? s.max.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 12px' }}>{s.mean !== null ? s.mean.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 12px' }}>{s.std !== null ? s.std.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 12px', fontWeight: 'bold', color: isWarn ? '#d32f2f' : '#212121' }}>
                            {s.latest !== null && !isNaN(s.latest) ? s.latest.toFixed(2) : '—'}
                            {isWarn && <span style={{ marginLeft: 4, fontSize: '9px', color: '#d32f2f' }}>▲</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Box>
            ) : (
              <Typography variant="caption" sx={{ color: '#9e9e9e' }}>
                Select a vehicle and module to load sensor statistics
              </Typography>
            )}
          </Paper>

          {/* ── SECTION DIVIDER ── */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 0.5 }}>
            <Box sx={{ flex: 1, height: '1px', bgcolor: '#e0e0e0' }} />
            <Typography variant="caption" sx={{ color: '#9e9e9e', fontWeight: 'bold', fontFamily: 'monospace', letterSpacing: 1, whiteSpace: 'nowrap' }}>
              FAULT & ALERT HISTORY
            </Typography>
            <Box sx={{ flex: 1, height: '1px', bgcolor: '#e0e0e0' }} />
          </Box>

          {/* ── ROW E: Vehicle alerts table ── */}
          <Paper sx={{ p: 1.5, borderRadius: 0 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                VEHICLE ALERTS — {selectedVehicle} &nbsp;
                <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(GOLD ALERTS DELTA)</span>
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                {vehicleAlertsQuery.data?.open?.length > 0 && (
                  <Chip size="small" label={`${vehicleAlertsQuery.data.open.length} OPEN`}
                    sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', height: 18, bgcolor: '#d32f2f', color: 'white' }} />
                )}
                {vehicleAlertsQuery.data?.closed?.length > 0 && (
                  <Chip size="small" label={`${vehicleAlertsQuery.data.closed.length} CLOSED`}
                    sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', height: 18, bgcolor: '#e0e0e0', color: '#424242' }} />
                )}
              </Box>
            </Box>
            {vehicleAlertsQuery.isLoading ? (
              <Typography variant="caption" sx={{ color: '#9e9e9e' }}>Loading…</Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #bdbdbd' }}>
                      {['STATUS', 'MODULE', 'STARTED', 'PEAK TS', 'ENDED', 'MAX SCORE', 'TOP FEATURES'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 12px', color: '#616161', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...(vehicleAlertsQuery.data?.open || []), ...(vehicleAlertsQuery.data?.closed || [])].map((a: any, i: number) => (
                      <tr key={a.alert_id || i} style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fafafa' : 'white' }}>
                        <td style={{ padding: '5px 12px' }}>
                          <span style={{
                            display: 'inline-block', padding: '1px 6px', fontSize: '10px', fontWeight: 700,
                            background: a.status === 'OPEN' ? '#d32f2f' : '#e0e0e0',
                            color: a.status === 'OPEN' ? 'white' : '#424242',
                          }}>{a.status}</span>
                        </td>
                        <td style={{ padding: '5px 12px', fontWeight: 600 }}>{(a.module || '—').toUpperCase()}</td>
                        <td style={{ padding: '5px 12px', color: '#616161' }}>{String(a.alert_start_ts || '—').slice(0, 16)}</td>
                        <td style={{ padding: '5px 12px', color: '#616161' }}>{String(a.peak_anomaly_ts || '—').slice(0, 16)}</td>
                        <td style={{ padding: '5px 12px', color: '#616161' }}>{a.status === 'CLOSED' ? String(a.alert_end_ts || '—').slice(0, 16) : '—'}</td>
                        <td style={{ padding: '5px 12px', fontWeight: 'bold', color: Number(a.max_composite_score) > 80 ? '#d32f2f' : '#212121' }}>
                          {a.max_composite_score != null ? Number(a.max_composite_score).toFixed(1) : '—'}
                        </td>
                        <td style={{ padding: '5px 12px', color: '#757575', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {a.top_10_features || '—'}
                        </td>
                      </tr>
                    ))}
                    {(!vehicleAlertsQuery.data?.open?.length && !vehicleAlertsQuery.data?.closed?.length) && (
                      <tr><td colSpan={7} style={{ padding: '10px 12px', color: '#9e9e9e', textAlign: 'center' }}>No alerts recorded for this vehicle</td></tr>
                    )}
                  </tbody>
                </table>
              </Box>
            )}
          </Paper>

          {/* ── ROW F: DTC run history ── */}
          <Paper sx={{ p: 1.5, borderRadius: 0 }}>
            <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1, display: 'block' }}>
              DTC ANALYSIS RUN HISTORY — {selectedVehicle} &nbsp;
              <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(last 50 runs)</span>
            </Typography>
            {dtcHistoryQuery.isLoading ? (
              <Typography variant="caption" sx={{ color: '#9e9e9e' }}>Loading…</Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #bdbdbd' }}>
                      {['RUN TIME', 'MODULE', 'PEAK TS', 'TRIGGERED CODES'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 12px', color: '#616161', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(dtcHistoryQuery.data?.runs || []).map((run: any, i: number) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fafafa' : 'white' }}>
                        <td style={{ padding: '5px 12px', color: '#616161' }}>{String(run.run_ts || '—').slice(0, 16)}</td>
                        <td style={{ padding: '5px 12px', fontWeight: 600 }}>{(run.module || '—').toUpperCase()}</td>
                        <td style={{ padding: '5px 12px', color: '#616161' }}>{String(run.peak_ts || '—').slice(0, 16)}</td>
                        <td style={{ padding: '5px 12px' }}>
                          {(run.triggers || []).length === 0 ? (
                            <span style={{ color: '#2e7d32', fontWeight: 600 }}>NO FAULTS</span>
                          ) : (
                            (run.triggers as any[]).map((t: any, j: number) => (
                              <span key={j} style={{
                                display: 'inline-block', marginRight: 6, padding: '1px 6px', fontSize: '10px', fontWeight: 700,
                                background: t.severity === 'CRITICAL' ? '#d32f2f' : '#ed6c02', color: 'white',
                              }}>{t.code}</span>
                            ))
                          )}
                        </td>
                      </tr>
                    ))}
                    {!(dtcHistoryQuery.data?.runs?.length) && (
                      <tr><td colSpan={4} style={{ padding: '10px 12px', color: '#9e9e9e', textAlign: 'center' }}>No DTC analysis runs recorded for this vehicle</td></tr>
                    )}
                  </tbody>
                </table>
              </Box>
            )}
          </Paper>

          {/* ── SECTION DIVIDER ── */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, my: 0.5 }}>
            <Box sx={{ flex: 1, height: '1px', bgcolor: '#e0e0e0' }} />
            <Typography variant="caption" sx={{ color: '#9e9e9e', fontWeight: 'bold', fontFamily: 'monospace', letterSpacing: 1, whiteSpace: 'nowrap' }}>
              DTC DEEP DIVE
            </Typography>
            <Box sx={{ flex: 1, height: '1px', bgcolor: '#e0e0e0' }} />
          </Box>

          {/* ── ROW G: On-demand DTC analysis ── */}
          <Paper sx={{ p: 1.5, borderRadius: 0 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5, flexWrap: 'wrap' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                DTC DEEP DIVE — {selectedVehicle} / {selectedModule.toUpperCase()}
              </Typography>
              <button
                onClick={runDtcAnalysis}
                disabled={dtcRunning || !selectedVehicle}
                style={{
                  padding: '4px 14px', fontFamily: 'monospace', fontSize: '11px', fontWeight: 700,
                  background: dtcRunning ? '#e0e0e0' : '#1976d2', color: dtcRunning ? '#9e9e9e' : 'white',
                  border: 'none', borderRadius: 0, cursor: dtcRunning ? 'not-allowed' : 'pointer',
                  letterSpacing: '0.5px',
                }}
              >
                {dtcRunning ? 'RUNNING INFERENCE…' : 'RUN DTC ANALYSIS'}
              </button>
              <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace', fontSize: '10px' }}>
                Runs PyTorch fault models on 600-row bronze traceback at peak anomaly timestamp
              </Typography>
            </Box>

            {dtcResult?.error && (
              <Box sx={{ p: 1.5, bgcolor: '#fff8e1', border: '1px solid #ffe082' }}>
                <Typography variant="caption" sx={{ color: '#e65100', fontFamily: 'monospace' }}>{dtcResult.error}</Typography>
              </Box>
            )}

            {dtcResult?.success && (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                  <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mr: 0.5 }}>TRIGGERED CODES:</Typography>
                  {dtcResult.triggers?.length === 0 ? (
                    <Chip size="small" label="NO FAULTS TRIGGERED" sx={{ borderRadius: 0, fontWeight: 'bold', bgcolor: '#e8f5e9', color: '#2e7d32', fontSize: '11px' }} />
                  ) : (
                    (dtcResult.triggers as any[]).map((t: any, i: number) => (
                      <Box key={i} sx={{ display: 'flex', flexDirection: 'column', p: 1, border: `1px solid ${t.severity === 'CRITICAL' ? '#d32f2f' : '#ed6c02'}`, minWidth: 200, maxWidth: 320 }}>
                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.5 }}>
                          <span style={{
                            padding: '1px 6px', fontSize: '10px', fontWeight: 700,
                            background: t.severity === 'CRITICAL' ? '#d32f2f' : '#ed6c02', color: 'white',
                          }}>{t.severity}</span>
                          <Typography variant="caption" sx={{ fontWeight: 'bold', fontFamily: 'monospace' }}>{t.code}</Typography>
                        </Box>
                        <Typography variant="caption" sx={{ fontSize: '10px', color: '#616161', lineHeight: 1.4 }}>{t.message}</Typography>
                      </Box>
                    ))
                  )}
                </Box>

                <Box sx={{ display: 'flex', gap: 2, height: 380 }}>
                  <Paper sx={{ flex: 1, borderRadius: 0, border: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {dtcResult.critical_plot ? (
                      <Plot
                        data={dtcResult.critical_plot.data}
                        layout={{ ...dtcResult.critical_plot.layout, autosize: true }}
                        useResizeHandler={true}
                        style={{ width: '100%', height: '100%' }}
                        config={{ displayModeBar: false }}
                      />
                    ) : (
                      <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No critical DTCs monitored for this module</Typography>
                    )}
                  </Paper>
                  <Paper sx={{ flex: 1, borderRadius: 0, border: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {dtcResult.non_critical_plot ? (
                      <Plot
                        data={dtcResult.non_critical_plot.data}
                        layout={{ ...dtcResult.non_critical_plot.layout, autosize: true }}
                        useResizeHandler={true}
                        style={{ width: '100%', height: '100%' }}
                        config={{ displayModeBar: false }}
                      />
                    ) : (
                      <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No non-critical DTCs monitored for this module</Typography>
                    )}
                  </Paper>
                </Box>

                {dtcResult.diagnostics?.skipped_dtcs && Object.keys(dtcResult.diagnostics.skipped_dtcs).length > 0 && (
                  <Box sx={{ p: 1, bgcolor: '#fafafa', border: '1px solid #e0e0e0' }}>
                    <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace', fontSize: '10px' }}>
                      SKIPPED: {Object.keys(dtcResult.diagnostics.skipped_dtcs).join(', ')} — missing bronze features
                    </Typography>
                  </Box>
                )}
              </Box>
            )}

            {!dtcResult && !dtcRunning && (
              <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace' }}>
                Click RUN DTC ANALYSIS to run fault inference. Requires dtc_service/api.py running on port 8007.
              </Typography>
            )}
          </Paper>
        </Box>
      )}

      {/* ── MODULE ANALYSIS ── */}
      {activeTab === 'module' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minHeight: 0 }}>
          <Paper sx={{ p: 1.5, borderRadius: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold' }}>MODULE:</Typography>
            <ToggleButtonGroup value={analysisModule} exclusive
              onChange={(_e, val) => { if (val) { setAnalysisModule(val); setAnalysisKey(''); } }}
              size="small" sx={{ bgcolor: 'white' }}>
              {ALL_MODULES.map((mod) => (
                <ToggleButton key={mod} value={mod} sx={{ fontWeight: 'bold', px: 1.5, borderRadius: 0, fontSize: '11px',
                  '&.Mui-selected': { bgcolor: MODULE_COLORS[mod], color: 'white', '&:hover': { bgcolor: MODULE_COLORS[mod] } } }}>
                  {mod.toUpperCase()}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            {sensorKeys.length > 0 && (
              <FormControl size="small" sx={{ minWidth: 280 }}>
                <InputLabel>Sensor</InputLabel>
                <Select value={currentAnalysisKey} onChange={(e) => setAnalysisKey(e.target.value)} label="Sensor" sx={{ borderRadius: 0 }}>
                  {sensorKeys.map((k) => <MenuItem key={k} value={k}>{k.replace(/_/g, ' ').toUpperCase()}</MenuItem>)}
                </Select>
              </FormControl>
            )}
          </Paper>

          <Box sx={{ display: 'flex', gap: 2, height: 300, minHeight: 0 }}>
            <Paper sx={{ flex: 1, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1 }}>
                FLEET AVERAGE — {currentAnalysisKey.replace(/_/g, ' ').toUpperCase()} (BRONZE)
              </Typography>
              <Box sx={{ flex: 1 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={crossfleetChartData} margin={{ top: 5, right: 20, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                    <XAxis dataKey="vehicle_id" tick={{ fontSize: 11, fontWeight: 600, fill: '#424242' }} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <YAxis tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', fontWeight: 'bold' }} />
                    <Bar dataKey="avg" name="Average" fill={MODULE_COLORS[analysisModule]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            </Paper>

            <Paper sx={{ flex: 1, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1 }}>
                FLEET RANGE — {currentAnalysisKey.replace(/_/g, ' ').toUpperCase()} (MIN / MAX)
              </Typography>
              <Box sx={{ flex: 1 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={crossfleetChartData} margin={{ top: 5, right: 20, left: -10, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                    <XAxis dataKey="vehicle_id" tick={{ fontSize: 11, fontWeight: 600, fill: '#424242' }} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <YAxis tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                    <Tooltip contentStyle={{ borderRadius: 0, fontSize: '11px' }} />
                    <Legend wrapperStyle={{ fontSize: '11px', fontWeight: 'bold' }} />
                    <Bar dataKey="min" name="Min" fill="#81c784" isAnimationActive={false} />
                    <Bar dataKey="max" name="Max" fill="#e57373" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </Box>
            </Paper>
          </Box>

          {/* Inline timeline for selected vehicle+module */}
          <Paper sx={{ p: 1.5, borderRadius: 0, height: 260, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                SENSOR TIMELINE — {analysisModule.toUpperCase()} — switch to VEHICLE DEEP DIVE for full drill-down
              </Typography>
              <FormControl size="small" sx={{ minWidth: 160 }}>
                <Select value={selectedVehicle}
                  onChange={(e) => setSelectedVehicle(e.target.value)}
                  displayEmpty sx={{ borderRadius: 0 }}>
                  {vehicles.map((v: any) => <MenuItem key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_id}</MenuItem>)}
                </Select>
              </FormControl>
              {moduleTimelineData.length > 0 && (
                <Typography variant="caption" sx={{ color: '#9e9e9e' }}>{moduleTimelineData.length} pts</Typography>
              )}
            </Box>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              {currentAnalysisKey && moduleTimelineData.length > 0 ? (
                <SensorChart
                  data={moduleTimelineData}
                  group={{ title: `${currentAnalysisKey.replace(/_/g, ' ').toUpperCase()} — ${selectedVehicle}`,
                    sensors: [{ key: currentAnalysisKey, color: MODULE_COLORS[analysisModule], label: currentAnalysisKey }] }}
                  xAxisMode={xAxisMode}
                  height="100%"
                />
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <Typography variant="caption" sx={{ color: '#9e9e9e' }}>
                    {!selectedVehicle ? 'Select a vehicle above' : moduleTimelineQuery.isLoading ? 'Loading…' : 'No sensor data for this vehicle/module'}
                  </Typography>
                </Box>
              )}
            </Box>
          </Paper>
        </Box>
      )}
    </Box>
  );
}
