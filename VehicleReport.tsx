import { useMemo, useState, useEffect } from 'react';
import {
  Box, Typography, Paper, Chip,
  FormControl, InputLabel, Select, MenuItem,
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store';
import EChart from '../components/EChart';
import TimeRangePicker from '../components/TimeRangePicker';
import type { EChartsOption } from 'echarts';

const API = 'http://127.0.0.1:8005';
const ALL_MODULES = ['engine', 'transmission', 'battery', 'body', 'tyre'];

const MODULE_COLORS: Record<string, string> = {
  engine: '#e57373', transmission: '#ffb74d', battery: '#81c784',
  body: '#ba68c8', tyre: '#4dd0e1',
};

const KEY_SENSORS: Record<string, string[]> = {
  engine:       ['engine_rpm_rpm', 'engine_oil_temperature', 'engine_load_absolute'],
  battery:      ['battery_state_of_charge_soc_pct', 'battery_state_of_health_soh_pct', 'battery_temperature_cell'],
  body:         ['fuel_level_pct', 'cabin_temperature', 'ac_compressor_load_pct'],
  transmission: ['transmission_oil_temperature', 'vehicle_speed_kmh', 'actual_engine_pct_torque'],
  tyre:         ['tyre_pressure_fl_psi', 'tyre_temp_fl_c', 'tyre_wear_fl_pct'],
};

const SENSOR_COLORS = ['#1976d2', '#e57373', '#66bb6a'];

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const factor = Math.ceil(arr.length / maxPoints);
  return arr.filter((_, i) => i % factor === 0);
}

export default function VehicleReport() {
  const { autoRefresh } = useStore();

  const [selectedVehicle, setSelectedVehicle] = useState('');
  const [selectedModule, setSelectedModule] = useState('engine');
  const [timeRangeHours, setTimeRangeHours] = useState(24);

  const fleetQuery = useQuery({
    queryKey: ['autoFleetSummary'],
    queryFn: () => axios.get(`${API}/api/automotive/fleet-summary`).then(r => r.data),
    refetchInterval: false,
  });

  const vehicleHealthQuery = useQuery({
    queryKey: ['vehicleReportHealth', selectedVehicle],
    queryFn: () => axios.get(`${API}/api/automotive/vehicle-health-history/${selectedVehicle}`).then(r => r.data),
    enabled: !!selectedVehicle,
    refetchInterval: autoRefresh ? 10000 : false,
  });

  const moduleHealthQuery = useQuery({
    queryKey: ['vehicleReportModule', selectedVehicle, selectedModule],
    queryFn: () => axios.get(`${API}/api/automotive/module-health/${selectedVehicle}/${selectedModule}`).then(r => r.data),
    enabled: !!selectedVehicle,
    refetchInterval: false,
  });

  const sensorQuery = useQuery({
    queryKey: ['vehicleReportSensor', selectedVehicle, selectedModule],
    queryFn: () => axios.get(`${API}/api/automotive/sensor-history/${selectedVehicle}/${selectedModule}`).then(r => r.data),
    enabled: !!selectedVehicle,
    refetchInterval: false,
  });

  const vehicles: any[] = fleetQuery.data?.vehicles || [];

  useEffect(() => {
    const vList = fleetQuery.data?.vehicles;
    if (vList?.length > 0 && !selectedVehicle) setSelectedVehicle(vList[0].vehicle_id);
  }, [fleetQuery.data]);

  const selectedVehicleData = useMemo(
    () => vehicles.find((v: any) => v.vehicle_id === selectedVehicle),
    [vehicles, selectedVehicle],
  );

  const cutoffMs = Date.now() - timeRangeHours * 3600 * 1000;

  const healthHistory = useMemo(() => {
    const raw: any[] = vehicleHealthQuery.data?.data || [];
    if (!raw.length) return [];
    const filtered = raw.filter((r: any) => {
      const ts = new Date(r.timestamp || r.ts || '');
      return isNaN(ts.getTime()) || ts.getTime() >= cutoffMs;
    });
    return downsample(filtered, 400).map((r: any) => ({
      ts: r.ts || String(r.timestamp || '').slice(5, 16),
      health: r.health ?? r.vehicle_health_score ?? null,
    }));
  }, [vehicleHealthQuery.data, cutoffMs]);

  const moduleHealthHistory = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    if (!raw.length) return [];
    const filtered = raw.filter((r: any) => {
      const ts = new Date(r.timestamp || '');
      return isNaN(ts.getTime()) || ts.getTime() >= cutoffMs;
    });
    return downsample(filtered, 400).map((r: any) => ({
      ts: String(r.timestamp || '').slice(5, 16),
      health_score: r.health_score ?? null,
      severity: r.severity,
    }));
  }, [moduleHealthQuery.data, cutoffMs]);

  const sensorHistory = useMemo(() => {
    const raw: any[] = sensorQuery.data?.data || [];
    return downsample(raw, 300);
  }, [sensorQuery.data]);

  const latestSilverRow: any = useMemo(() => {
    const raw: any[] = moduleHealthQuery.data?.data || [];
    return raw.length > 0 ? raw[raw.length - 1] : null;
  }, [moduleHealthQuery.data]);

  const latestSeverity = latestSilverRow?.severity || 'NORMAL';
  const severityColor = latestSeverity === 'CRITICAL' ? '#d32f2f'
    : latestSeverity === 'WARNING' ? '#ed6c02' : '#2e7d32';

  const modColor = MODULE_COLORS[selectedModule];

  const healthTrendOption: EChartsOption = useMemo(() => ({
    animation: false,
    tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0]?.axisValue}<br/>Health: ${Number(p[0]?.value).toFixed(1)}%` },
    grid: { top: 15, right: 15, bottom: 45, left: 50 },
    xAxis: { type: 'category', data: healthHistory.map(r => r.ts), axisLabel: { fontSize: 9, rotate: 30 }, axisLine: { lineStyle: { color: '#bdbdbd' } }, splitLine: { show: false } },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 10, formatter: '{value}%' }, splitLine: { lineStyle: { type: 'dashed', color: '#eeeeee' } } },
    series: [{
      type: 'line',
      data: healthHistory.map(r => r.health),
      smooth: false,
      symbol: 'none',
      lineStyle: { color: '#1976d2', width: 2 },
      areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(25,118,210,0.15)' }, { offset: 1, color: 'rgba(25,118,210,0)' }] } },
      markLine: { silent: true, symbol: 'none', data: [
        { yAxis: 60, lineStyle: { color: '#d32f2f', type: 'dashed', width: 1 }, label: { formatter: 'CRIT', fontSize: 9, color: '#d32f2f' } },
        { yAxis: 80, lineStyle: { color: '#ffa000', type: 'dashed', width: 1 }, label: { formatter: 'WARN', fontSize: 9, color: '#ffa000' } },
      ]},
    }],
  }), [healthHistory]);

  const moduleHealthOption: EChartsOption = useMemo(() => ({
    animation: false,
    tooltip: { trigger: 'axis', formatter: (p: any) => `${p[0]?.axisValue}<br/>Health: ${Number(p[0]?.value).toFixed(1)}%` },
    grid: { top: 15, right: 15, bottom: 45, left: 50 },
    xAxis: { type: 'category', data: moduleHealthHistory.map(r => r.ts), axisLabel: { fontSize: 9, rotate: 30 }, axisLine: { lineStyle: { color: '#bdbdbd' } }, splitLine: { show: false } },
    yAxis: { type: 'value', min: 0, max: 100, axisLabel: { fontSize: 10, formatter: '{value}%' }, splitLine: { lineStyle: { type: 'dashed', color: '#eeeeee' } } },
    series: [{
      type: 'line',
      name: `${selectedModule.toUpperCase()} Health`,
      data: moduleHealthHistory.map(r => r.health_score),
      smooth: false,
      symbol: 'none',
      lineStyle: { color: modColor, width: 2 },
      markLine: { silent: true, symbol: 'none', data: [
        { yAxis: 60, lineStyle: { color: '#d32f2f', type: 'dashed', width: 1 } },
        { yAxis: 80, lineStyle: { color: '#ffa000', type: 'dashed', width: 1 } },
      ]},
    }],
  }), [moduleHealthHistory, selectedModule, modColor]);

  const sensors = KEY_SENSORS[selectedModule] || [];
  const sensorOption: EChartsOption = useMemo(() => ({
    animation: false,
    tooltip: { trigger: 'axis' },
    legend: { bottom: 0, textStyle: { fontSize: 10, fontWeight: 'bold' } },
    grid: { top: 15, right: 15, bottom: 45, left: 60 },
    xAxis: { type: 'category', data: sensorHistory.map(r => String(r.timestamp || '').slice(5, 16)), axisLabel: { fontSize: 9, rotate: 30 }, axisLine: { lineStyle: { color: '#bdbdbd' } }, splitLine: { show: false } },
    yAxis: { type: 'value', axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { type: 'dashed', color: '#eeeeee' } } },
    series: sensors.map((sensor, i) => ({
      type: 'line' as const,
      name: sensor.replace(/_/g, ' ').toUpperCase().slice(0, 22),
      data: sensorHistory.map(r => r[sensor] ?? null),
      smooth: false,
      symbol: 'none',
      lineStyle: { color: SENSOR_COLORS[i] || '#9e9e9e', width: 1.5 },
    })),
  }), [sensorHistory, sensors]);

  return (
    <Box sx={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', gap: 2, p: 2, bgcolor: '#f5f5f5' }}>

      {/* HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #bdbdbd', pb: 1, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#212121', letterSpacing: '-0.5px' }}>
          VEHICLE INTELLIGENCE REPORT
        </Typography>

        <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
          <TimeRangePicker value={timeRangeHours} onChange={setTimeRangeHours} />

          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Vehicle</InputLabel>
            <Select value={selectedVehicle} onChange={e => setSelectedVehicle(e.target.value)} label="Vehicle" sx={{ borderRadius: 0 }}>
              {vehicles.map((v: any) => <MenuItem key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_id}</MenuItem>)}
            </Select>
          </FormControl>

          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Module</InputLabel>
            <Select value={selectedModule} onChange={e => setSelectedModule(e.target.value)} label="Module" sx={{ borderRadius: 0 }}>
              {ALL_MODULES.map(m => <MenuItem key={m} value={m}>{m.toUpperCase()}</MenuItem>)}
            </Select>
          </FormControl>
        </Box>
      </Box>

      {/* KPI STRIP */}
      <Box sx={{ display: 'flex', gap: 2 }}>
        {[
          {
            label: 'OVERALL HEALTH',
            value: selectedVehicleData ? `${selectedVehicleData.health_score}%` : '—',
            color: !selectedVehicleData ? '#212121'
              : selectedVehicleData.health_score < 60 ? '#d32f2f'
              : selectedVehicleData.health_score < 80 ? '#ed6c02' : '#2e7d32',
          },
          {
            label: `${selectedModule.toUpperCase()} CONTRIBUTION`,
            value: selectedVehicleData ? (selectedVehicleData[`${selectedModule}_contrib`] || 0).toFixed(3) : '—',
            color: '#212121',
          },
          {
            label: 'MODULE SEVERITY',
            value: latestSeverity,
            color: severityColor,
          },
          {
            label: 'SILVER DATA POINTS',
            value: moduleHealthQuery.data?.count != null ? Number(moduleHealthQuery.data.count).toLocaleString() : '—',
            color: '#212121',
          },
        ].map((kpi, i) => (
          <Paper key={i} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: `4px solid ${modColor}` }}>
            <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold' }}>{kpi.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color, mt: 0.5 }}>{kpi.value}</Typography>
          </Paper>
        ))}
      </Box>

      {/* CHARTS */}
      <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>

        {/* Left column: health trend + module health */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minHeight: 0 }}>
          <Paper sx={{ flex: 1, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
            <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
              FUSED VEHICLE HEALTH TREND — {selectedVehicle || '—'} &nbsp;
              <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(GOLD)</span>
            </Typography>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <EChart
                option={healthTrendOption}
                notMerge={true}
                loading={vehicleHealthQuery.isLoading}
                empty={!vehicleHealthQuery.isLoading && healthHistory.length === 0}
                emptyText={selectedVehicle ? 'No gold health data in selected time range' : 'Select a vehicle'}
              />
            </Box>
          </Paper>

          <Paper sx={{ flex: 1, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                {selectedModule.toUpperCase()} ML HEALTH SCORE &nbsp;
                <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(SILVER)</span>
              </Typography>
              <Chip size="small" label={latestSeverity}
                sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', height: 18, bgcolor: severityColor, color: 'white' }} />
            </Box>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <EChart
                option={moduleHealthOption}
                notMerge={true}
                loading={moduleHealthQuery.isLoading}
                empty={!moduleHealthQuery.isLoading && moduleHealthHistory.length === 0}
                emptyText={selectedVehicle ? 'No silver data in selected time range' : 'Select a vehicle'}
              />
            </Box>
          </Paper>
        </Box>

        {/* Right column: sensor deep dive */}
        <Paper sx={{ flex: 1, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
            KEY SENSOR READINGS — {selectedModule.toUpperCase()} &nbsp;
            <span style={{ color: '#9e9e9e', fontWeight: 'normal' }}>(BRONZE)</span>
            <span style={{ color: '#9e9e9e', fontWeight: 'normal', marginLeft: 8 }}>
              {sensorHistory.length > 0 ? `${sensorHistory.length} pts` : ''}
            </span>
          </Typography>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <EChart
              option={sensorOption}
              notMerge={true}
              loading={sensorQuery.isLoading}
              empty={!sensorQuery.isLoading && sensorHistory.length === 0}
              emptyText={selectedVehicle ? 'No sensor data available' : 'Select a vehicle'}
            />
          </Box>
        </Paper>
      </Box>
    </Box>
  );
}
