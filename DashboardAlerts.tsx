import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Paper, ToggleButton, ToggleButtonGroup, Button,
} from '@mui/material';
import PsychologyIcon from '@mui/icons-material/Psychology';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { ModuleRegistry, ClientSideRowModelModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-balham.css';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store';

ModuleRegistry.registerModules([ClientSideRowModelModule]);

const fetchAlertsMetrics = async () => (await axios.get('http://127.0.0.1:8005/api/alerts/metrics')).data;

export default function DashboardAlerts() {
  const { autoRefresh } = useStore();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'OPEN' | 'CLOSED'>('OPEN');

  const { data: metrics, isLoading: metricsLoading } = useQuery({
    queryKey: ['alertsMetrics'],
    queryFn: fetchAlertsMetrics,
    refetchInterval: autoRefresh ? 2000 : false,
  });

  const tableColDefs = useMemo<ColDef[]>(() => [
    {
      field: 'alert_id',
      headerName: 'ALERT ID',
      flex: 1,
      minWidth: 120,
      valueFormatter: (p) => (p.value ? p.value.substring(0, 8) : ''),
      cellStyle: { fontFamily: 'monospace', fontWeight: 'bold' },
    },
    {
      field: 'module',
      headerName: 'MODULE',
      flex: 1,
      minWidth: 130,
      valueFormatter: (p) => p.value?.toUpperCase(),
    },
    {
      field: 'source_id',
      headerName: 'VEHICLE',
      flex: 1,
      minWidth: 120,
    },
    {
      field: 'peak_anomaly_ts',
      headerName: 'PEAK ANOMALY TS',
      flex: 1.5,
      minWidth: 200,
    },
    {
      field: 'max_composite_score',
      headerName: 'SEVERITY SCORE',
      flex: 1,
      minWidth: 140,
      type: 'numericColumn',
      valueFormatter: (p) => (p.value ? parseFloat(p.value).toFixed(2) : ''),
    },
    {
      headerName: 'ACTION',
      width: 160,
      pinned: 'right',
      cellRenderer: (params: any) => (
        <Button
          size="small"
          variant="contained"
          color="error"
          startIcon={<PsychologyIcon />}
          onClick={() =>
            navigate(
              `/dtc?tab=1&vehicle=${encodeURIComponent(params.data.source_id)}&module=${encodeURIComponent(params.data.module)}&peak_ts=${encodeURIComponent(params.data.peak_anomaly_ts)}`,
            )
          }
          sx={{ height: '24px', fontSize: '10px', mt: 0.5, borderRadius: 0, boxShadow: 'none' }}
        >
          ROOT CAUSE
        </Button>
      ),
    },
  ], [navigate]);

  return (
    <Box sx={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', gap: 2, p: 2, bgcolor: '#f5f5f5' }}>

      {/* HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #bdbdbd', pb: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#212121', letterSpacing: '-0.5px' }}>
          OPERATIONS CENTER: FLEET ALERTS
        </Typography>

        <ToggleButtonGroup value={activeTab} exclusive onChange={(_e, val) => val && setActiveTab(val)} size="small" sx={{ bgcolor: 'white' }}>
          <ToggleButton value="OPEN" sx={{ fontWeight: 'bold', px: 3, borderRadius: 0, color: '#d32f2f', '&.Mui-selected': { bgcolor: '#ffebee', color: '#d32f2f' } }}>
            🔴 ACTIVE (OPEN)
          </ToggleButton>
          <ToggleButton value="CLOSED" sx={{ fontWeight: 'bold', px: 3, borderRadius: 0 }}>
            📜 RESOLVED (CLOSED)
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {/* KPI CARDS */}
      <Box sx={{ display: 'flex', gap: 2, width: '100%' }}>
        {[
          { label: '🔴 ACTIVE ALERTS', value: metrics?.active_alerts_count?.toLocaleString() || 0, color: '#d32f2f' },
          { label: '⚠️ CRITICAL VEHICLES', value: metrics?.critical_vehicles?.toLocaleString() || 0, color: '#f57c00' },
          { label: 'PROCESSING LAG', value: metrics?.processing_lag?.toLocaleString() || 0, color: '' },
        ].map((kpi, idx) => (
          <Paper key={idx} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: `4px solid ${kpi.color || '#424242'}` }}>
            <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold' }}>{kpi.label}</Typography>
            <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color || '#212121', mt: 0.5 }}>{kpi.value}</Typography>
          </Paper>
        ))}
      </Box>

      {/* DATA GRID */}
      <Paper sx={{ display: 'flex', flexDirection: 'column', p: 0, borderRadius: 0, flex: 1, minHeight: 0 }}>
        <Box className="ag-theme-balham" sx={{ flexGrow: 1, width: '100%' }}>
          <AgGridReact
            rowData={activeTab === 'OPEN' ? (metrics?.open_alerts ?? []) : (metrics?.closed_alerts ?? [])}
            columnDefs={tableColDefs}
            animateRows={false}
            defaultColDef={{ resizable: true, sortable: true, filter: true }}
            overlayLoadingTemplate={metricsLoading ? '<span class="ag-overlay-loading-center">Fetching Alerts...</span>' : undefined}
            overlayNoRowsTemplate='<span class="ag-overlay-loading-center">No Alerts Found</span>'
          />
        </Box>
      </Paper>
    </Box>
  );
}
