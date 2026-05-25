import { useMemo, useCallback } from 'react';
import { Box, Typography, Paper } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store';
import EChart from '../components/EChart';
import type { EChartsOption } from 'echarts';

const API = 'http://127.0.0.1:8005';
const MODULES = ['engine', 'transmission', 'battery', 'body', 'tyre'];
const MODULE_LABELS = ['ENGINE', 'TRANSM.', 'BATTERY', 'BODY', 'TYRE'];

function healthColor(v: number): string {
  return v >= 80 ? '#2e7d32' : v >= 60 ? '#ef6c00' : '#c62828';
}

function healthLabel(v: number): string {
  return v >= 80 ? 'HEALTHY' : v >= 60 ? 'WARNING' : 'CRITICAL';
}

export default function FleetHealth() {
  const { autoRefresh } = useStore();
  const navigate = useNavigate();

  const fleetQuery = useQuery({
    queryKey: ['autoFleetSummary'],
    queryFn: () => axios.get(`${API}/api/automotive/fleet-summary`).then(r => r.data),
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const vehicles: any[] = fleetQuery.data?.vehicles || [];
  const fleetStats = fleetQuery.data?.fleet_stats || {};
  const vehicleIds = useMemo(() => vehicles.map((v: any) => v.vehicle_id), [vehicles]);

  // gold aggregator stores {mod}_contrib = raw module health score (0-100), not weighted fraction
  const heatmapData = useMemo((): [number, number, number][] => {
    const data: [number, number, number][] = [];
    vehicles.forEach((v: any, vi: number) => {
      MODULES.forEach((mod, mi) => {
        const health = Math.min(100, Math.max(0, Math.round(v[`${mod}_contrib`] ?? 0)));
        data.push([mi, vi, health]);
      });
    });
    return data;
  }, [vehicles]);

  const handleCellClick = useCallback((params: any) => {
    if (!params.data) return;
    const [mi, vi] = params.data as [number, number, number];
    const vehicle = vehicleIds[vi];
    const module = MODULES[mi];
    if (vehicle && module) {
      navigate(`/automotive?vehicle=${encodeURIComponent(vehicle)}&module=${encodeURIComponent(module)}&tab=vehicle`);
    }
  }, [vehicleIds, navigate]);

  const heatmapEvents = useMemo(() => ({ click: handleCellClick }), [handleCellClick]);

  const heatmapOption: EChartsOption = useMemo(() => ({
    tooltip: {
      trigger: 'item',
      backgroundColor: '#fff',
      borderColor: '#e0e0e0',
      borderWidth: 1,
      padding: [8, 12],
      formatter: (params: any) => {
        const [mi, vi, health] = params.data as [number, number, number];
        const c = healthColor(health);
        return `
          <div style="font-family:monospace;min-width:170px;line-height:1.6">
            <div style="font-weight:700;font-size:12px;border-bottom:1px solid #eeeeee;padding-bottom:5px;margin-bottom:6px">
              ${vehicleIds[vi]}
            </div>
            <div style="font-size:11px">Module&nbsp;&nbsp;: <b>${MODULES[mi].toUpperCase()}</b></div>
            <div style="font-size:11px">Health&nbsp;&nbsp;: <b style="color:${c}">${health}%</b></div>
            <div style="font-size:11px">Status&nbsp;&nbsp;: <b style="color:${c}">● ${healthLabel(health)}</b></div>
            <div style="font-size:10px;color:#9e9e9e;margin-top:7px;border-top:1px solid #eeeeee;padding-top:5px">
              Click to open Vehicle Deep Dive →
            </div>
          </div>`;
      },
    },
    grid: { top: 50, right: 115, bottom: 20, left: 100 },
    xAxis: {
      type: 'category',
      data: MODULE_LABELS,
      position: 'top',
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontWeight: 'bold',
        fontSize: 11,
        color: '#424242',
        fontFamily: 'monospace',
        interval: 0,
        margin: 12,
      },
    },
    yAxis: {
      type: 'category',
      data: vehicleIds,
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 11,
        fontWeight: 'bold',
        color: '#424242',
        fontFamily: 'monospace',
      },
    },
    visualMap: {
      min: 0,
      max: 100,
      calculable: true,
      orient: 'vertical',
      right: 8,
      top: 'center',
      text: ['100%', '0%'],
      textStyle: { fontSize: 10, color: '#616161', fontFamily: 'monospace' },
      inRange: { color: ['#c62828', '#ef6c00', '#2e7d32'] },
      itemWidth: 14,
      itemHeight: 100,
    },
    series: [{
      type: 'heatmap',
      data: heatmapData,
      cursor: 'pointer',
      itemStyle: {
        borderColor: '#f5f5f5',
        borderWidth: 3,
        borderRadius: 2,
      },
      emphasis: {
        disabled: false,
        itemStyle: {
          shadowBlur: 14,
          shadowColor: 'rgba(25,118,210,0.35)',
          borderColor: '#1976d2',
          borderWidth: 2,
        },
      },
      label: {
        show: true,
        fontSize: 13,
        fontWeight: 'bold',
        fontFamily: 'monospace',
        formatter: (params: any) => `${(params.data as [number, number, number])[2]}%`,
      },
    }],
  }), [heatmapData, vehicleIds]);

  const healthBarOption: EChartsOption = useMemo(() => ({
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => {
        const c = healthColor(params.value);
        return `<span style="font-family:monospace"><b>${params.name}</b><br/>Health: <b style="color:${c}">${params.value}%</b> — ${healthLabel(params.value)}</span>`;
      },
      backgroundColor: '#fff',
      borderColor: '#e0e0e0',
      borderWidth: 1,
      padding: [6, 10],
    },
    grid: { top: 8, right: 52, bottom: 24, left: 80 },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: { fontSize: 10, formatter: '{value}%', color: '#757575', fontFamily: 'monospace' },
      splitLine: { lineStyle: { type: 'dashed', color: '#eeeeee' } },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'category',
      data: vehicleIds,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { fontSize: 11, fontWeight: 'bold', color: '#424242', fontFamily: 'monospace' },
    },
    series: [{
      type: 'bar',
      data: vehicles.map((v: any) => ({
        value: v.health_score,
        itemStyle: { color: healthColor(v.health_score), borderRadius: [0, 2, 2, 0] },
      })),
      barMaxWidth: 28,
      label: {
        show: true,
        position: 'right',
        fontSize: 11,
        fontWeight: 'bold',
        fontFamily: 'monospace',
        formatter: (p: any) => `${p.value}%`,
        color: '#424242',
      },
      markLine: {
        silent: true,
        symbol: 'none',
        lineStyle: { type: 'dashed', width: 1 },
        data: [
          { xAxis: 60, lineStyle: { color: '#c62828' }, label: { formatter: 'CRIT', fontSize: 9, color: '#c62828', fontFamily: 'monospace' } },
          { xAxis: 80, lineStyle: { color: '#ef6c00' }, label: { formatter: 'WARN', fontSize: 9, color: '#ef6c00', fontFamily: 'monospace' } },
        ],
      },
    }],
  }), [vehicles, vehicleIds]);

  return (
    <Box sx={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', gap: 2, p: 2, bgcolor: '#f5f5f5' }}>

      <Box sx={{ borderBottom: '2px solid #bdbdbd', pb: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#212121', letterSpacing: '-0.5px' }}>
          FLEET HEALTH COMMAND
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', gap: 2 }}>
        {[
          { label: 'FLEET SIZE', value: fleetStats.total_vehicles ?? 0, color: '#212121' },
          { label: 'AVG FLEET HEALTH', value: `${fleetStats.avg_health ?? 0}%`, color: (fleetStats.avg_health ?? 100) < 60 ? '#c62828' : '#2e7d32' },
          { label: 'CRITICAL ( < 60% )', value: fleetStats.critical_count ?? 0, color: (fleetStats.critical_count ?? 0) > 0 ? '#c62828' : '#212121' },
          { label: 'WARNING ( 60–80% )', value: fleetStats.warning_count ?? 0, color: (fleetStats.warning_count ?? 0) > 0 ? '#ef6c00' : '#212121' },
        ].map((kpi, i) => (
          <Paper key={i} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: '4px solid #1976d2' }}>
            <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold', fontFamily: 'monospace' }}>{kpi.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color, mt: 0.5, fontFamily: 'monospace' }}>{kpi.value}</Typography>
          </Paper>
        ))}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
        <Paper sx={{ flex: 2, borderRadius: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 1 }}>
            <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', fontFamily: 'monospace' }}>
              MODULE HEALTH MATRIX — SUBSYSTEM HEALTH SCORE PER VEHICLE (%)
            </Typography>
            <Typography variant="caption" sx={{ color: '#9e9e9e', fontFamily: 'monospace', fontSize: '10px' }}>
              ↙ click any cell to open Vehicle Deep Dive
            </Typography>
          </Box>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <EChart
              option={heatmapOption}
              loading={fleetQuery.isLoading}
              empty={heatmapData.length === 0}
              emptyText="No fleet data. Start the streaming pipeline to populate vehicle data."
              onEvents={heatmapEvents}
            />
          </Box>
        </Paper>

        <Paper sx={{ flex: 1, borderRadius: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1, fontFamily: 'monospace' }}>
            FUSED VEHICLE HEALTH SCORES
          </Typography>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <EChart
              option={healthBarOption}
              loading={fleetQuery.isLoading}
              empty={vehicles.length === 0}
              emptyText="No vehicle data"
            />
          </Box>
        </Paper>
      </Box>
    </Box>
  );
}
