import React, { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box, Typography, Paper, Chip, Select, MenuItem, FormControl, InputLabel,
  ToggleButton, ToggleButtonGroup, Button, TextField, CircularProgress, Tabs, Tab,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import Plot from 'react-plotly.js';
import { useStore } from '../store';
import EChart from '../components/EChart';
import type { EChartsOption } from 'echarts';
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const API = 'http://127.0.0.1:8005';
const ALL_MODULES = ['engine', 'transmission', 'battery', 'body', 'tyre'];
const MODULE_COLORS: Record<string, string> = {
  engine: '#e57373', transmission: '#ffb74d', battery: '#81c784',
  body: '#ba68c8', tyre: '#4dd0e1',
};
const MODULE_SENSOR_KEYS: Record<string, string[]> = {
  engine: ['engine_rpm_rpm', 'engine_oil_temperature', 'ecu_7ea_engine_coolant_temperature', 'engine_load_absolute', 'fuel_flow_rate_hour_l_hr', 'turbo_boost_vacuum_gauge_psi', 'voltage_control_module_v'],
  battery: ['battery_state_of_charge_soc_pct', 'battery_state_of_health_soh_pct', 'battery_voltage_ecu_7ee', 'battery_temperature_cell', 'internal_resistance_impedance', 'charging_power_kw', 'hv_battery_pack_voltage'],
  body: ['cabin_temperature', 'fuel_level_pct', 'cabin_humidity_pct', 'hvac_blower_speed', 'ac_compressor_load_pct', 'distance_since_codes_cleared', 'odometer_reading'],
  transmission: ['transmission_oil_temperature', 'gear_position_actual', 'torque_converter_slip_speed', 'vehicle_speed_kmh', 'actual_engine_pct_torque', 'clutch_engagement_per_slip', 'engine_rpm'],
  tyre: ['tyre_pressure_fl_psi', 'tyre_pressure_fr_psi', 'tyre_pressure_rl_psi', 'tyre_pressure_rr_psi', 'tyre_temp_fl_c', 'tyre_temp_fr_c', 'tyre_wear_fl_pct', 'tyre_wear_fr_pct', 'tyre_wear_rl_pct', 'tyre_wear_rr_pct'],
};

const axisStyle = { fontSize: '10px', fill: '#616161', fontWeight: 600 };

function sevColor(sev: string): string {
  return sev === 'critical' || sev === 'CRITICAL' ? '#d32f2f' : '#ed6c02';
}

const PLOT_LAYOUT_OVERRIDES = {
  autosize: true,
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  font: { family: 'monospace', size: 10 },
  margin: { t: 28, r: 12, b: 60, l: 50 },
  legend: { orientation: 'h' as const, y: -0.3, font: { size: 9 } },
};

export default function DtcInvestigation() {
  const { autoRefresh } = useStore();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initVehicle = searchParams.get('vehicle') || '';
  const initModule  = searchParams.get('module')  || 'engine';
  const initPeakTs  = searchParams.get('peak_ts') || '';
  const initTabStr  = searchParams.get('tab')     || (initVehicle ? '1' : '0');

  const [activeTab,       setActiveTab]       = useState<number>(parseInt(initTabStr, 10));
  const [selectedVehicle, setSelectedVehicle] = useState<string>(initVehicle);
  const [selectedModule,  setSelectedModule]  = useState<string>(ALL_MODULES.includes(initModule) ? initModule : 'engine');
  const [peakTs,          setPeakTs]          = useState<string>(initPeakTs);
  const [evidenceWindow,  setEvidenceWindow]  = useState<number>(60);
  const [selectedSensor,  setSelectedSensor]  = useState<string>('');
  const [selectedDtcCode, setSelectedDtcCode] = useState<string>('');
  const [loadEvidence,    setLoadEvidence]    = useState<boolean>(!!initPeakTs && !!initVehicle);

  const sensorKeys = MODULE_SENSOR_KEYS[selectedModule] || [];

  useEffect(() => {
    if (sensorKeys.length > 0 && !selectedSensor) setSelectedSensor(sensorKeys[0]);
  }, [selectedModule]);

  const fleetQuery = useQuery({
    queryKey: ['dtcFleetSummary'],
    queryFn: () => axios.get(`${API}/api/automotive/fleet-summary`).then((r) => r.data),
    refetchInterval: autoRefresh ? 10000 : false,
  });

  const dtcMasterQuery = useQuery({
    queryKey: ['dtcMaster'],
    queryFn: () => axios.get(`${API}/api/automotive/dtc-master`).then((r) => r.data),
    staleTime: Infinity,
  });

  const vehicleHistoryQuery = useQuery({
    queryKey: ['dtcVehicleHistory', selectedVehicle, selectedModule],
    queryFn: () => axios.get(`${API}/api/automotive/dtc-history/${selectedVehicle}`).then((r) => r.data),
    enabled: !!selectedVehicle,
    refetchInterval: false,
  });

  const fleetDistributionQuery = useQuery({
    queryKey: ['dtcFleetDistribution'],
    queryFn: () => axios.get(`${API}/api/automotive/dtc/fleet-distribution`).then((r) => r.data),
    staleTime: 30000,
  });

  const allHistoryQuery = useQuery({
    queryKey: ['dtcAllHistory'],
    queryFn: () => axios.get(`${API}/api/automotive/dtc/history`).then((r) => r.data),
    staleTime: 30000,
  });

  const dtcAnalysisQuery = useQuery({
    queryKey: ['dtcAnalysis', selectedVehicle, selectedModule, peakTs],
    queryFn: () =>
      axios.get(`${API}/api/dtc/analyze`, {
        params: { source_id: selectedVehicle, module: selectedModule, peak_ts: peakTs },
        timeout: 70000,
      }).then((r) => r.data),
    enabled: false,
    staleTime: Infinity,
    retry: false,
  });

  const sensorEvidenceQuery = useQuery({
    queryKey: ['dtcSensorEvidence', selectedVehicle, selectedModule, selectedSensor, peakTs, evidenceWindow],
    queryFn: () =>
      axios.get(`${API}/api/automotive/dtc-sensor-evidence/${selectedVehicle}/${selectedModule}/${selectedSensor}`, {
        params: { around_ts: peakTs, window: evidenceWindow },
      }).then((r) => r.data),
    enabled: loadEvidence && !!selectedVehicle && !!selectedModule && !!selectedSensor,
    refetchInterval: false,
  });

  useEffect(() => {
    if (initVehicle && initPeakTs) dtcAnalysisQuery.refetch();
  }, []);

  useEffect(() => {
    if (dtcAnalysisQuery.isSuccess && (dtcAnalysisQuery.data as any)?.success) {
      queryClient.invalidateQueries({ queryKey: ['dtcVehicleHistory', selectedVehicle, selectedModule] });
      queryClient.invalidateQueries({ queryKey: ['dtcFleetDistribution'] });
      queryClient.invalidateQueries({ queryKey: ['dtcAllHistory'] });
    }
  }, [dtcAnalysisQuery.isSuccess, dtcAnalysisQuery.dataUpdatedAt]);

  const vehicles: any[] = fleetQuery.data?.vehicles || [];
  useEffect(() => {
    if (vehicles.length > 0 && !selectedVehicle) setSelectedVehicle(vehicles[0].vehicle_id);
  }, [fleetQuery.data]);

  const dtcMasterFlat = useMemo((): Record<string, any> => {
    const modules = dtcMasterQuery.data?.modules || {};
    const flat: Record<string, any> = {};
    Object.values(modules).forEach((codes: any) => {
      if (Array.isArray(codes)) codes.forEach((c: any) => { flat[c.dtc_code] = c; });
    });
    return flat;
  }, [dtcMasterQuery.data]);

  const selectedDtcDetail: any = selectedDtcCode ? dtcMasterFlat[selectedDtcCode] : null;

  const candidateRuns = useMemo((): any[] => {
    const allRuns: any[] = vehicleHistoryQuery.data?.runs || [];
    return allRuns.filter((r: any) => !selectedModule || r.module === selectedModule).slice(0, 30);
  }, [vehicleHistoryQuery.data, selectedModule]);

  const allTriggeredCodes = useMemo((): string[] => {
    const codes = new Set<string>();
    candidateRuns.forEach((r: any) => r.triggers?.forEach((t: any) => codes.add(t.code)));
    return Array.from(codes);
  }, [candidateRuns]);

  const distributionData = useMemo(
    () => (fleetDistributionQuery.data?.distribution || []).slice(0, 15) as any[],
    [fleetDistributionQuery.data],
  );

  const fleetKpis = useMemo(() => {
    const runs: any[] = allHistoryQuery.data?.runs || [];
    const allCodes = new Set<string>();
    let criticalCount = 0;
    runs.forEach((r: any) => {
      (r.triggers || []).forEach((t: any) => {
        allCodes.add(t.code);
        if (t.severity === 'critical' || t.severity === 'CRITICAL') criticalCount++;
      });
    });
    const topCode = distributionData[0]?.code || '—';
    return { totalRuns: runs.length, uniqueFaults: allCodes.size, criticalCount, topCode };
  }, [allHistoryQuery.data, distributionData]);

  const evidenceData: any[] = sensorEvidenceQuery.data?.data || [];

  const peakTsMs = useMemo((): number | null => {
    if (!peakTs) return null;
    const d = new Date(peakTs);
    return isNaN(d.getTime()) ? null : d.getTime();
  }, [peakTs]);

  const analysisData: any    = dtcAnalysisQuery.data;
  const analysisTriggered    = (analysisData?.triggers  || []) as any[];
  const criticalPlot: any    = analysisData?.critical_plot    ?? null;
  const nonCriticalPlot: any = analysisData?.non_critical_plot ?? null;

  const canRun = !!selectedVehicle && !!selectedModule && !!peakTs;

  const navigateToDeepDive = (vehicle: string, module: string, peak_ts: string, dtcCode?: string) => {
    setSelectedVehicle(vehicle);
    setSelectedModule(ALL_MODULES.includes(module) ? module : 'engine');
    setPeakTs(peak_ts);
    if (dtcCode) setSelectedDtcCode(dtcCode);
    setActiveTab(1);
  };

  const evidenceOption = useMemo((): EChartsOption => {
    const xData = evidenceData.map((r: any) => r.ts);
    const yData = evidenceData.map((r: any) => r.value);
    const peakIdx = xData.findIndex((ts: string) => ts === (peakTs || '').slice(0, 16));
    const markAreaData: any[] = [];
    const markPointData: any[] = [];
    if (peakTsMs && xData.length > 0) {
      const half = Math.floor(evidenceWindow * 0.25);
      const center = peakIdx >= 0 ? peakIdx : Math.floor(xData.length / 2);
      const s = Math.max(0, center - half);
      const e = Math.min(xData.length - 1, center + half);
      if (s < e) markAreaData.push([{ xAxis: xData[s], itemStyle: { color: 'rgba(211,47,47,0.08)' } }, { xAxis: xData[e] }]);
      if (peakIdx >= 0) markPointData.push({ xAxis: xData[peakIdx], yAxis: yData[peakIdx], symbol: 'pin', symbolSize: 20, itemStyle: { color: '#d32f2f' }, label: { show: false } });
    }
    return {
      tooltip: { trigger: 'axis', backgroundColor: '#fff', borderColor: '#e0e0e0', borderWidth: 1, padding: [8, 12], textStyle: { fontFamily: 'monospace', fontSize: 11 }, axisPointer: { type: 'cross' } },
      dataZoom: [{ type: 'inside', xAxisIndex: 0 }, { type: 'slider', xAxisIndex: 0, bottom: 4, height: 18 }],
      grid: { top: 20, right: 16, bottom: 52, left: 50 },
      xAxis: { type: 'category', data: xData, axisLabel: { fontFamily: 'monospace', fontSize: 10, color: '#616161' }, axisLine: { lineStyle: { color: '#bdbdbd' } }, axisTick: { show: false } },
      yAxis: { type: 'value', axisLabel: { fontFamily: 'monospace', fontSize: 10, color: '#616161' }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { lineStyle: { type: 'dashed', color: '#eeeeee' } } },
      series: [{
        type: 'line', data: yData, symbol: 'none',
        lineStyle: { color: MODULE_COLORS[selectedModule] || '#1976d2', width: 2 },
        itemStyle: { color: MODULE_COLORS[selectedModule] || '#1976d2' },
        markArea: markAreaData.length > 0 ? { data: [markAreaData[0]] } : undefined,
        markPoint: markPointData.length > 0 ? { data: markPointData, label: { show: false } } : undefined,
        markLine: peakIdx >= 0 ? { silent: true, symbol: 'none', data: [{ xAxis: xData[peakIdx], lineStyle: { color: '#d32f2f', type: 'dashed', width: 2 }, label: { formatter: 'PEAK', color: '#d32f2f', fontSize: 9, fontFamily: 'monospace' } }] } : undefined,
      }],
    } as EChartsOption;
  }, [evidenceData, peakTs, peakTsMs, evidenceWindow, selectedModule]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2, bgcolor: '#f5f5f5' }}>

      {/* HEADER */}
      <Box sx={{ borderBottom: '2px solid #bdbdbd', pb: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 1 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700, color: '#212121', letterSpacing: '-0.5px' }}>
            DTC INVESTIGATION CENTER
          </Typography>
          {activeTab === 1 && initPeakTs && (
            <Typography variant="caption" sx={{ color: '#757575', fontFamily: 'monospace' }}>
              Pre-populated from alert — Peak: {initPeakTs.slice(0, 16)} · Vehicle: {initVehicle} · Module: {initModule.toUpperCase()}
            </Typography>
          )}
        </Box>
        <Tabs
          value={activeTab}
          onChange={(_e, val: number) => setActiveTab(val)}
          sx={{
            minHeight: 36,
            '& .MuiTab-root': { fontWeight: 'bold', fontSize: '11px', fontFamily: 'monospace', minHeight: 36, borderRadius: 0 },
            '& .MuiTabs-indicator': { bgcolor: '#d32f2f', height: 3 },
          }}
        >
          <Tab label="FLEET OVERVIEW" />
          <Tab label="DEEP DIVE — VEHICLE / DTC" />
        </Tabs>
      </Box>

      {/* TAB 0: FLEET OVERVIEW */}
      {activeTab === 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>

          <Box sx={{ display: 'flex', gap: 2 }}>
            {([
              { label: 'TOTAL ANALYSIS RUNS',     value: fleetKpis.totalRuns,    color: '#1976d2' },
              { label: 'UNIQUE FAULT CODES SEEN',  value: fleetKpis.uniqueFaults, color: '#7b1fa2' },
              { label: 'CRITICAL FAULT TRIGGERS',  value: fleetKpis.criticalCount, color: '#d32f2f' },
              { label: 'TOP TRIGGERED CODE',       value: fleetKpis.topCode,      color: '#f57c00' },
            ] as { label: string; value: string | number; color: string }[]).map((kpi, i) => (
              <Paper key={i} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: `4px solid ${kpi.color}` }}>
                <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold', display: 'block' }}>{kpi.label}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color, mt: 0.5, fontFamily: 'monospace' }}>{kpi.value}</Typography>
              </Paper>
            ))}
          </Box>

          <Box sx={{ display: 'flex', gap: 2, height: 440 }}>
            <Paper sx={{ flex: 1, p: 1.5, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 0.5 }}>
                HISTORICAL FAULT FREQUENCY — most triggered codes across all analysis runs
              </Typography>
              <Box sx={{ flex: 1, minHeight: 0 }}>
                {distributionData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={distributionData} layout="vertical" margin={{ top: 0, right: 48, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#eeeeee" />
                      <XAxis type="number" tick={axisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                      <YAxis type="category" dataKey="code" tick={{ fontSize: 10, fontWeight: 700, fill: '#424242', fontFamily: 'monospace' }} axisLine={false} tickLine={false} width={70} />
                      <Tooltip
                        contentStyle={{ borderRadius: 0, fontSize: '11px', fontFamily: 'monospace' }}
                        formatter={(v: number, _name: string, props: any) => [`${v} runs · ${props.payload.vehicle_count} vehicle(s)`, props.payload.severity?.toUpperCase()]}
                      />
                      <Bar
                        dataKey="count"
                        name="Occurrences"
                        isAnimationActive={false}
                        label={{ position: 'right', fontSize: 9, fontWeight: 'bold', fill: '#616161', fontFamily: 'monospace' }}
                        onClick={(data: any) => { setSelectedDtcCode(data.code); setActiveTab(1); }}
                        cursor="pointer"
                      >
                        {distributionData.map((d: any, i: number) => (
                          <Cell key={i} fill={d.severity === 'critical' || d.severity === 'CRITICAL' ? '#ef9a9a' : '#ffcc80'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 1 }}>
                    <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No data yet</Typography>
                    <Typography variant="caption" sx={{ color: '#bdbdbd', fontSize: '10px', textAlign: 'center' }}>
                      Populated each time DTC analysis is triggered in the Deep Dive tab
                    </Typography>
                  </Box>
                )}
              </Box>
            </Paper>

            <Paper sx={{ flex: 1.2, p: 1.5, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                  ANALYSIS RUN LOG — all DTC analyses across fleet
                </Typography>
                <Typography variant="caption" sx={{ color: '#9e9e9e', fontSize: '10px', fontFamily: 'monospace' }}>
                  click row to open in Deep Dive
                </Typography>
              </Box>
              <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid #e0e0e0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #bdbdbd' }}>
                      {['RUN TIME', 'VEHICLE', 'MODULE', 'CODES'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 10px', color: '#616161', fontWeight: 700, position: 'sticky', top: 0, background: 'white', boxShadow: '0 1px 0 #bdbdbd', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(allHistoryQuery.data?.runs || []).map((run: any, i: number) => (
                      <tr
                        key={i}
                        onClick={() => navigateToDeepDive(run.source_id || '', run.module || 'engine', run.peak_ts || '')}
                        style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fafafa' : 'white', cursor: 'pointer' }}
                        title="Click to open Deep Dive for this run"
                      >
                        <td style={{ padding: '4px 10px', color: '#616161' }}>{String(run.run_ts || '—').slice(0, 16)}</td>
                        <td style={{ padding: '4px 10px', fontWeight: 600 }}>{run.source_id || '—'}</td>
                        <td style={{ padding: '4px 10px' }}>{(run.module || '—').toUpperCase()}</td>
                        <td style={{ padding: '4px 10px' }}>
                          {(run.triggers || []).length === 0 ? (
                            <span style={{ color: '#2e7d32', fontWeight: 600, fontSize: '10px' }}>CLEAR</span>
                          ) : (
                            (run.triggers as any[]).map((t: any, j: number) => (
                              <span
                                key={j}
                                onClick={(e) => { e.stopPropagation(); navigateToDeepDive(run.source_id || '', run.module || 'engine', run.peak_ts || '', t.code); }}
                                style={{ display: 'inline-block', marginRight: 4, padding: '1px 5px', fontSize: '9px', fontWeight: 700, cursor: 'pointer',
                                  background: sevColor(t.severity) === '#d32f2f' ? '#d32f2f' : '#ed6c02', color: 'white' }}
                              >
                                {t.code}
                              </span>
                            ))
                          )}
                        </td>
                      </tr>
                    ))}
                    {!(allHistoryQuery.data?.runs?.length) && (
                      <tr>
                        <td colSpan={4} style={{ padding: '10px', color: '#9e9e9e', textAlign: 'center' }}>
                          {allHistoryQuery.isLoading ? 'Loading…' : 'No analysis runs yet — go to Deep Dive and run DTC analysis'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>
            </Paper>
          </Box>
        </Box>
      )}

      {/* TAB 1: DEEP DIVE */}
      {activeTab === 1 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>

          {/* Controls */}
          <Paper sx={{ p: 1.5, borderRadius: 0, display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
            <FormControl size="small" sx={{ minWidth: 160 }}>
              <InputLabel>Vehicle</InputLabel>
              <Select value={selectedVehicle} onChange={(e) => setSelectedVehicle(e.target.value)} label="Vehicle" sx={{ borderRadius: 0 }}>
                {vehicles.map((v: any) => <MenuItem key={v.vehicle_id} value={v.vehicle_id}>{v.vehicle_id}</MenuItem>)}
              </Select>
            </FormControl>

            <ToggleButtonGroup
              value={selectedModule}
              exclusive
              size="small"
              sx={{ bgcolor: 'white' }}
              onChange={(_e, val) => { if (val) { setSelectedModule(val); setSelectedSensor(MODULE_SENSOR_KEYS[val]?.[0] || ''); } }}
            >
              {ALL_MODULES.map((mod) => (
                <ToggleButton
                  key={mod}
                  value={mod}
                  sx={{ fontWeight: 'bold', px: 1.5, borderRadius: 0, fontSize: '11px',
                    '&.Mui-selected': { bgcolor: MODULE_COLORS[mod], color: 'white', '&:hover': { bgcolor: MODULE_COLORS[mod] } } }}
                >
                  {mod.toUpperCase()}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            <TextField
              size="small"
              label="Peak Timestamp"
              value={peakTs}
              onChange={(e) => setPeakTs(e.target.value)}
              placeholder="YYYY-MM-DD HH:MM:SS"
              sx={{ minWidth: 220, '& .MuiOutlinedInput-root': { borderRadius: 0, fontFamily: 'monospace', fontSize: '12px' } }}
            />

            <Button
              variant="contained"
              color="error"
              size="small"
              startIcon={dtcAnalysisQuery.isFetching ? <CircularProgress size={12} color="inherit" /> : <PlayArrowIcon />}
              disabled={!canRun || dtcAnalysisQuery.isFetching}
              onClick={() => dtcAnalysisQuery.refetch()}
              sx={{ borderRadius: 0, boxShadow: 'none', fontWeight: 'bold', fontSize: '11px', minWidth: 170 }}
            >
              {dtcAnalysisQuery.isFetching ? 'RUNNING ANALYSIS...' : 'RUN DTC ANALYSIS'}
            </Button>

            {!canRun && (
              <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace', fontSize: '10px' }}>
                vehicle + peak timestamp required
              </Typography>
            )}
          </Paper>

          {/* DTC Prediction Engine */}
          <Paper sx={{ p: 1.5, borderRadius: 0 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1, flexWrap: 'wrap', gap: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                DTC PREDICTION ENGINE — FAULT MATURATION ANALYSIS
              </Typography>
              <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center' }}>
                {analysisData?.success === true && analysisTriggered.length === 0 && (
                  <Chip size="small" label="NO FAULTS TRIGGERED" sx={{ borderRadius: 0, bgcolor: '#e8f5e9', color: '#2e7d32', fontWeight: 'bold', fontSize: '10px', height: 20 }} />
                )}
                {analysisTriggered.length > 0 && (
                  <>
                    <Typography variant="caption" sx={{ color: '#9e9e9e', fontSize: '10px', mr: 0.5 }}>TRIGGERED:</Typography>
                    {analysisTriggered.map((t: any, i: number) => (
                      <Chip
                        key={i}
                        size="small"
                        label={`${t.code} · ${t.severity}`}
                        onClick={() => setSelectedDtcCode(t.code)}
                        sx={{ borderRadius: 0, fontFamily: 'monospace', fontWeight: 'bold', fontSize: '10px', height: 20, cursor: 'pointer',
                          bgcolor: sevColor(t.severity) === '#d32f2f' ? '#ffebee' : '#fff8e1',
                          color: sevColor(t.severity), border: `1px solid ${sevColor(t.severity)}` }}
                      />
                    ))}
                  </>
                )}
              </Box>
            </Box>

            {dtcAnalysisQuery.isFetching ? (
              <Box sx={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 2 }}>
                <CircularProgress color="error" size={32} />
                <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace' }}>
                  Running PyTorch DTC inference · {selectedVehicle} / {selectedModule.toUpperCase()} · this may take up to 60 s
                </Typography>
              </Box>
            ) : analysisData?.error ? (
              <Box sx={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Typography variant="caption" sx={{ color: '#d32f2f', fontFamily: 'monospace', textAlign: 'center' }}>
                  {analysisData.error}
                </Typography>
              </Box>
            ) : (criticalPlot || nonCriticalPlot) ? (
              <Box sx={{ display: 'flex', gap: 2 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#d32f2f', display: 'block', mb: 0.5 }}>
                    CRITICAL FAULT MATURATION
                  </Typography>
                  {criticalPlot ? (
                    <Plot
                      data={criticalPlot.data}
                      layout={{ ...(criticalPlot.layout || {}), ...PLOT_LAYOUT_OVERRIDES }}
                      style={{ width: '100%', height: 300 }}
                      useResizeHandler
                      config={{ displayModeBar: false, responsive: true }}
                    />
                  ) : (
                    <Box sx={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #e0e0e0' }}>
                      <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No critical fault activity detected</Typography>
                    </Box>
                  )}
                </Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#ed6c02', display: 'block', mb: 0.5 }}>
                    NON-CRITICAL FAULT MATURATION
                  </Typography>
                  {nonCriticalPlot ? (
                    <Plot
                      data={nonCriticalPlot.data}
                      layout={{ ...(nonCriticalPlot.layout || {}), ...PLOT_LAYOUT_OVERRIDES }}
                      style={{ width: '100%', height: 300 }}
                      useResizeHandler
                      config={{ displayModeBar: false, responsive: true }}
                    />
                  ) : (
                    <Box sx={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed #e0e0e0' }}>
                      <Typography variant="caption" sx={{ color: '#9e9e9e' }}>No non-critical fault activity detected</Typography>
                    </Box>
                  )}
                </Box>
              </Box>
            ) : (
              <Box sx={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 1 }}>
                <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace' }}>
                  Select vehicle + module + peak timestamp, then click RUN DTC ANALYSIS
                </Typography>
                <Typography variant="caption" sx={{ color: '#bdbdbd', fontFamily: 'monospace', fontSize: '10px' }}>
                  Runs PyTorch ML models · produces critical and non-critical fault maturation curves
                </Typography>
              </Box>
            )}
          </Paper>

          {/* Vehicle History + DTC Detail */}
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Paper sx={{ flex: 2, borderRadius: 0, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                  VEHICLE ANALYSIS HISTORY — {selectedVehicle || '—'} / {selectedModule.toUpperCase()}
                </Typography>
                <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace', fontSize: '10px' }}>
                  click row to load peak_ts · click code to inspect
                </Typography>
              </Box>
              <Box sx={{ maxHeight: 220, overflowY: 'auto', border: '1px solid #e0e0e0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #bdbdbd' }}>
                      {['RUN TIME', 'PEAK TS', 'TRIGGERED CODES'].map((h) => (
                        <th key={h} style={{ textAlign: 'left', padding: '4px 12px', color: '#616161', fontWeight: 700, position: 'sticky', top: 0, background: 'white', boxShadow: '0 1px 0 #bdbdbd' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {candidateRuns.length > 0 ? candidateRuns.map((run: any, i: number) => (
                      <tr
                        key={i}
                        onClick={() => setPeakTs(run.peak_ts || '')}
                        title="Click to load peak timestamp"
                        style={{ borderBottom: '1px solid #f0f0f0', background: i % 2 === 0 ? '#fafafa' : 'white', cursor: 'pointer' }}
                      >
                        <td style={{ padding: '5px 12px', color: '#616161' }}>{String(run.run_ts || '—').slice(0, 16)}</td>
                        <td style={{ padding: '5px 12px', fontWeight: peakTs === run.peak_ts ? 700 : 400, color: peakTs === run.peak_ts ? '#1976d2' : '#616161' }}>
                          {String(run.peak_ts || '—').slice(0, 16)}
                        </td>
                        <td style={{ padding: '5px 12px' }}>
                          {(run.triggers || []).length === 0 ? (
                            <span style={{ color: '#2e7d32', fontWeight: 600 }}>NO FAULTS</span>
                          ) : (
                            (run.triggers as any[]).map((t: any, j: number) => (
                              <span
                                key={j}
                                onClick={(e) => { e.stopPropagation(); setSelectedDtcCode(t.code); }}
                                title="Click to inspect DTC detail"
                                style={{ display: 'inline-block', marginRight: 6, padding: '2px 7px', fontSize: '10px', fontWeight: 700, cursor: 'pointer', borderRadius: 1,
                                  background: t.code === selectedDtcCode ? '#1976d2' : (sevColor(t.severity) === '#d32f2f' ? '#d32f2f' : '#ed6c02'), color: 'white' }}
                              >
                                {t.code}
                              </span>
                            ))
                          )}
                        </td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={3} style={{ padding: '10px 12px', color: '#9e9e9e', textAlign: 'center' }}>
                          {vehicleHistoryQuery.isLoading ? 'Loading…' : 'No analysis runs yet — click RUN DTC ANALYSIS above to start'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </Box>
            </Paper>

            <Paper sx={{ flex: 1, borderRadius: 0, p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>DTC DETAIL PANEL</Typography>
              {selectedDtcDetail ? (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography variant="h6" sx={{ fontWeight: 800, fontFamily: 'monospace', color: '#212121' }}>{selectedDtcDetail.dtc_code}</Typography>
                    <Chip size="small" label={selectedDtcDetail.severity?.toUpperCase() || '?'}
                      sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', bgcolor: sevColor(selectedDtcDetail.severity), color: 'white', height: 18 }} />
                    <Chip size="small" label={selectedDtcDetail.category}
                      sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', bgcolor: '#e3f2fd', color: '#1976d2', height: 18 }} />
                  </Box>
                  <Box sx={{ p: 1, bgcolor: '#f5f5f5', border: '1px solid #e0e0e0' }}>
                    <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold', fontFamily: 'monospace', display: 'block', mb: 0.5 }}>DESCRIPTION</Typography>
                    <Typography variant="body2" sx={{ fontSize: '12px', fontFamily: 'monospace', color: '#212121' }}>{selectedDtcDetail.description}</Typography>
                  </Box>
                  <Box sx={{ p: 1, bgcolor: sevColor(selectedDtcDetail.severity) === '#d32f2f' ? '#fff5f5' : '#fff8e1', border: `1px solid ${sevColor(selectedDtcDetail.severity)}` }}>
                    <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold', fontFamily: 'monospace', display: 'block', mb: 0.5 }}>DASHBOARD MESSAGE</Typography>
                    <Typography variant="body2" sx={{ fontSize: '11px', fontFamily: 'monospace', color: sevColor(selectedDtcDetail.severity) }}>{selectedDtcDetail.dashboard_message}</Typography>
                  </Box>
                  {selectedDtcDetail.features?.length > 0 && (
                    <Box>
                      <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold', fontFamily: 'monospace', display: 'block', mb: 0.5 }}>MONITORED FEATURES</Typography>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                        {(selectedDtcDetail.features as string[]).map((f: string) => (
                          <Chip
                            key={f}
                            size="small"
                            label={f.replace(/_/g, ' ')}
                            onClick={() => { setSelectedSensor(f); setLoadEvidence(true); }}
                            sx={{ borderRadius: 0, fontFamily: 'monospace', fontSize: '10px', height: 18, cursor: 'pointer', bgcolor: '#e8f5e9' }}
                          />
                        ))}
                      </Box>
                      <Typography variant="caption" sx={{ color: '#9e9e9e', fontSize: '9px', mt: 0.5, display: 'block' }}>click feature chip to load sensor evidence</Typography>
                    </Box>
                  )}
                </Box>
              ) : (
                <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 1 }}>
                  <Typography variant="caption" sx={{ color: '#9e9e9e', textAlign: 'center' }}>
                    Click a DTC code from the triggered chips or history table
                  </Typography>
                  {allTriggeredCodes.length > 0 && (
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', justifyContent: 'center' }}>
                      {allTriggeredCodes.map((code) => (
                        <Chip
                          key={code}
                          size="small"
                          label={code}
                          onClick={() => setSelectedDtcCode(code)}
                          sx={{ borderRadius: 0, fontFamily: 'monospace', fontWeight: 'bold', fontSize: '10px', cursor: 'pointer', bgcolor: '#ffebee', color: '#d32f2f' }}
                        />
                      ))}
                    </Box>
                  )}
                </Box>
              )}
            </Paper>
          </Box>

          {/* Sensor Evidence */}
          <Paper sx={{ p: 1.5, borderRadius: 0, height: 320, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1, flexWrap: 'wrap' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161' }}>
                SENSOR EVIDENCE — {selectedVehicle} / {selectedModule.toUpperCase()}
                {peakTs && <span style={{ color: '#d32f2f', marginLeft: 6 }}>▲ PEAK {peakTs.slice(0, 16)}</span>}
              </Typography>
              <FormControl size="small" sx={{ minWidth: 240 }}>
                <InputLabel>Sensor</InputLabel>
                <Select value={selectedSensor} onChange={(e) => setSelectedSensor(e.target.value)} label="Sensor" sx={{ borderRadius: 0 }}>
                  {sensorKeys.map((k) => <MenuItem key={k} value={k}>{k.replace(/_/g, ' ').toUpperCase()}</MenuItem>)}
                </Select>
              </FormControl>
              <FormControl size="small" sx={{ minWidth: 140 }}>
                <InputLabel>Window (min)</InputLabel>
                <Select value={evidenceWindow} onChange={(e) => setEvidenceWindow(Number(e.target.value))} label="Window (min)" sx={{ borderRadius: 0 }}>
                  {[30, 60, 120, 240, 480].map((w) => <MenuItem key={w} value={w}>{w} min</MenuItem>)}
                </Select>
              </FormControl>
              <Button
                variant="contained"
                size="small"
                disabled={!selectedVehicle || !selectedSensor}
                onClick={() => setLoadEvidence(true)}
                sx={{ borderRadius: 0, boxShadow: 'none', fontWeight: 'bold', fontSize: '11px' }}
              >
                LOAD EVIDENCE
              </Button>
              {sensorEvidenceQuery.data?.data_source && (
                <Chip size="small" label={sensorEvidenceQuery.data.data_source}
                  sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '10px', height: 18 }} />
              )}
            </Box>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <EChart
                option={evidenceOption}
                loading={sensorEvidenceQuery.isFetching}
                empty={evidenceData.length === 0 && !sensorEvidenceQuery.isFetching}
                emptyText={loadEvidence ? 'No bronze data found for this vehicle/module/sensor' : 'Select vehicle, sensor, and click LOAD EVIDENCE'}
              />
            </Box>
          </Paper>

        </Box>
      )}
    </Box>
  );
}
