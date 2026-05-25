import React, { useMemo, useState, useEffect } from 'react';
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
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
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

  const [activeTab, setActiveTab] = useState<PageTab>('fleet');
  const [xAxisMode, setXAxisMode] = useState<XAxisMode>('timestamp');
  const [selectedVehicle, setSelectedVehicle] = useState<string>('');
  const [selectedModule, setSelectedModule] = useState<string>('engine');
  const [analysisModule, setAnalysisModule] = useState<string>('engine');
  const [analysisKey, setAnalysisKey] = useState<string>('');

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
                    <XAxis dataKey="ts" tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} minTickGap={40} tickFormatter={(v) => formatXTick(v, 'timestamp')} />
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
