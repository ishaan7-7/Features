import { useMemo } from 'react';
import {
  Box, Typography, Paper
} from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store';
import EChart from '../components/EChart';
import type { EChartsOption } from 'echarts';

const API = 'http://127.0.0.1:8005';
const MODULES = ['engine', 'transmission', 'battery', 'body', 'tyre'];
const MODULE_WEIGHTS: Record<string, number> = {
  engine: 0.35, transmission: 0.25, battery: 0.20, body: 0.10, tyre: 0.10,
};

export default function FleetHealth() {
  const { autoRefresh } = useStore();

  const fleetQuery = useQuery({
    queryKey: ['autoFleetSummary'],
    queryFn: () => axios.get(`${API}/api/automotive/fleet-summary`).then(r => r.data),
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const vehicles: any[] = fleetQuery.data?.vehicles || [];
  const fleetStats = fleetQuery.data?.fleet_stats || {};
  const vehicleIds = useMemo(() => vehicles.map((v: any) => v.vehicle_id), [vehicles]);

  const heatmapData = useMemo((): [number, number, number][] => {
    const data: [number, number, number][] = [];
    vehicles.forEach((v: any, vi: number) => {
      MODULES.forEach((mod, mi) => {
        const contrib = v[`${mod}_contrib`] || 0;
        const weight = MODULE_WEIGHTS[mod];
        const rawHealth = weight > 0 ? Math.min(100, Math.round((contrib / weight) * 100)) : 0;
        data.push([mi, vi, rawHealth]);
      });
    });
    return data;
  }, [vehicles]);

  const heatmapOption: EChartsOption = useMemo(() => ({
    tooltip: {
      formatter: (params: any) => {
        const [mi, vi] = params.data as [number, number, number];
        return `<b>${vehicleIds[vi]}</b><br/>${MODULES[mi].toUpperCase()}: ${params.data[2]}%`;
      },
    },
    grid: { top: 20, right: 90, bottom: 40, left: 90 },
    xAxis: {
      type: 'category',
      data: MODULES.map(m => m.toUpperCase()),
      splitArea: { show: true },
      axisLabel: { fontWeight: 'bold', fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      data: vehicleIds,
      splitArea: { show: true },
      axisLabel: { fontSize: 11 },
    },
    visualMap: {
      min: 0,
      max: 100,
      calculable: true,
      orient: 'vertical',
      right: 5,
      top: 'center',
      text: ['100%', '0%'],
      textStyle: { fontSize: 10 },
      inRange: { color: ['#d32f2f', '#ffa000', '#2e7d32'] },
    },
    series: [{
      type: 'heatmap',
      data: heatmapData,
      label: {
        show: true,
        fontSize: 11,
        fontWeight: 'bold',
        formatter: (params: any) => `${(params.data as [number, number, number])[2]}`,
      },
      emphasis: { itemStyle: { shadowBlur: 5 } },
    }],
  }), [heatmapData, vehicleIds]);

  const healthBarOption: EChartsOption = useMemo(() => ({
    tooltip: { formatter: (params: any) => `${params.name}: ${params.value}%` },
    grid: { top: 10, right: 50, bottom: 30, left: 80 },
    xAxis: {
      type: 'value',
      max: 100,
      axisLabel: { fontSize: 10, formatter: '{value}%' },
      splitLine: { lineStyle: { type: 'dashed', color: '#eeeeee' } },
    },
    yAxis: {
      type: 'category',
      data: vehicleIds,
      axisLabel: { fontSize: 11 },
    },
    series: [{
      type: 'bar',
      data: vehicles.map((v: any) => ({
        value: v.health_score,
        itemStyle: {
          color: v.health_score < 60 ? '#d32f2f' : v.health_score < 80 ? '#ffa000' : '#2e7d32',
        },
      })),
      label: {
        show: true,
        position: 'right',
        fontSize: 10,
        fontWeight: 'bold',
        formatter: (p: any) => `${p.value}%`,
      },
      markLine: {
        silent: true,
        data: [
          { xAxis: 60, lineStyle: { color: '#d32f2f', type: 'dashed' }, label: { formatter: 'CRIT', fontSize: 9, color: '#d32f2f' } },
          { xAxis: 80, lineStyle: { color: '#ffa000', type: 'dashed' }, label: { formatter: 'WARN', fontSize: 9, color: '#ffa000' } },
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
          { label: 'AVG FLEET HEALTH', value: `${fleetStats.avg_health ?? 0}%`, color: (fleetStats.avg_health ?? 100) < 60 ? '#d32f2f' : '#2e7d32' },
          { label: 'CRITICAL ( < 60% )', value: fleetStats.critical_count ?? 0, color: (fleetStats.critical_count ?? 0) > 0 ? '#d32f2f' : '#212121' },
          { label: 'WARNING ( 60–80% )', value: fleetStats.warning_count ?? 0, color: (fleetStats.warning_count ?? 0) > 0 ? '#ed6c02' : '#212121' },
        ].map((kpi, i) => (
          <Paper key={i} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: '4px solid #1976d2' }}>
            <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold' }}>{kpi.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color, mt: 0.5 }}>{kpi.value}</Typography>
          </Paper>
        ))}
      </Box>

      <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
        <Paper sx={{ flex: 2, borderRadius: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1 }}>
            MODULE HEALTH MATRIX — ESTIMATED RAW HEALTH BY SUBSYSTEM (%)
          </Typography>
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <EChart
              option={heatmapOption}
              loading={fleetQuery.isLoading}
              empty={heatmapData.length === 0}
              emptyText="No fleet data. Start the streaming pipeline to populate vehicle data."
            />
          </Box>
        </Paper>

        <Paper sx={{ flex: 1, borderRadius: 0, p: 2, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 1 }}>
            CURRENT VEHICLE HEALTH SCORES
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
