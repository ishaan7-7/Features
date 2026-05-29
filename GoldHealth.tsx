import React, { useMemo, useState, useEffect } from 'react';
import {
  Box, Typography, Paper, Select, MenuItem, FormControl, InputLabel,
  ToggleButton, ToggleButtonGroup, Divider, Checkbox, FormControlLabel,
  Slider, Button, Alert, Chip, TextField, IconButton
} from '@mui/material';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { ModuleRegistry, ClientSideRowModelModule } from 'ag-grid-community';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-balham.css';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useStore } from '../store';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import DeleteIcon from '@mui/icons-material/Delete';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';

ModuleRegistry.registerModules([ClientSideRowModelModule]);

const ALL_MODULES = ["engine", "transmission", "battery", "body", "tyre"];
const COLORS = { engine: '#e57373', transmission: '#ffb74d', battery: '#81c784', body: '#ba68c8', tyre: '#4dd0e1' };

const BUILTIN_PRESETS: Record<string, Record<string, number>> = {
  'Safety-First':     { engine: 0.40, transmission: 0.20, battery: 0.25, body: 0.05, tyre: 0.10 },
  'Drivetrain-Heavy': { engine: 0.45, transmission: 0.35, battery: 0.10, body: 0.05, tyre: 0.05 },
  'Equal-Weight':     { engine: 0.20, transmission: 0.20, battery: 0.20, body: 0.20, tyre: 0.20 },
};

const fetchGoldMetrics = async () => (await axios.get('http://127.0.0.1:8005/api/gold/metrics')).data;
const fetchGoldConfig = async () => (await axios.get('http://127.0.0.1:8005/api/gold/config')).data;
const fetchGoldHistory = async (simId: string) => (await axios.get(`http://127.0.0.1:8005/api/gold/history/${simId}`)).data.data;

interface WeightPanelProps {
  label: string;
  profile: 'A' | 'B';
  weights: Record<string, number>;
  modules: string[];
  weightSum: number;
  isImbalanced: boolean;
  allPresets: Record<string, Record<string, number>>;
  savedPresets: Record<string, Record<string, number>>;
  onWeightChange: (mod: string, val: number) => void;
  onToggleModule: (mod: string) => void;
  onAutoBalance: () => void;
  onApplyPreset: (name: string, profile: 'A' | 'B') => void;
  onSavePreset: (name: string, weights: Record<string, number>, modules: string[]) => void;
  onDeletePreset: (name: string) => void;
}

function WeightPanel({
  label, profile, weights, modules, weightSum, isImbalanced,
  allPresets, savedPresets, onWeightChange, onToggleModule, onAutoBalance,
  onApplyPreset, onSavePreset, onDeletePreset,
}: WeightPanelProps) {
  const [selectedPreset, setSelectedPreset] = useState('');
  const [saveAsName, setSaveAsName] = useState('');

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 800, color: '#212121', mb: 1 }}>{label}</Typography>

      <Box sx={{ display: 'flex', gap: 1, mb: 1.5, alignItems: 'center' }}>
        <FormControl size="small" sx={{ flex: 1 }}>
          <Select value={selectedPreset} onChange={e => setSelectedPreset(e.target.value)} displayEmpty sx={{ borderRadius: 0, fontSize: '12px' }}>
            <MenuItem value=""><em>— Select Preset —</em></MenuItem>
            {Object.keys(allPresets).map(name => (
              <MenuItem key={name} value={name} sx={{ fontSize: '12px' }}>{name}</MenuItem>
            ))}
          </Select>
        </FormControl>
        <Button size="small" variant="outlined" onClick={() => { if (selectedPreset) onApplyPreset(selectedPreset, profile); }}
          disabled={!selectedPreset} sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '11px', minWidth: 50, height: 32 }}>
          APPLY
        </Button>
        {selectedPreset && savedPresets[selectedPreset] && (
          <IconButton size="small" onClick={() => { onDeletePreset(selectedPreset); setSelectedPreset(''); }} sx={{ borderRadius: 0, p: 0.5 }}>
            <DeleteIcon fontSize="small" />
          </IconButton>
        )}
      </Box>

      {isImbalanced && (
        <Alert severity="warning" icon={false} sx={{ borderRadius: 0, mb: 1.5, '& .MuiAlert-message': { p: 0 } }}
          action={<Button size="small" color="inherit" onClick={onAutoBalance} startIcon={<AutoFixHighIcon />}>RECALIBRATE</Button>}>
          <Typography variant="caption" sx={{ fontWeight: 'bold', display: 'block' }}>
            Sum: {weightSum.toFixed(3)} (Target: 1.0)
          </Typography>
        </Alert>
      )}

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        {ALL_MODULES.map(mod => {
          const isActive = modules.includes(mod);
          return (
            <Box key={mod} sx={{ opacity: isActive ? 1 : 0.5 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <FormControlLabel
                  control={<Checkbox size="small" checked={isActive} onChange={() => onToggleModule(mod)}
                    sx={{ color: COLORS[mod as keyof typeof COLORS] }} />}
                  label={<Typography variant="body2" sx={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: '12px' }}>{mod}</Typography>}
                />
                <Chip size="small" label={isActive ? (weights[mod] || 0).toFixed(2) : 'OFF'}
                  sx={{ borderRadius: 1, height: '20px', fontSize: '11px', fontWeight: 'bold' }} />
              </Box>
              <Slider size="small" value={weights[mod] || 0} onChange={(_, val) => onWeightChange(mod, val as number)}
                min={0} max={1} step={0.01} disabled={!isActive}
                sx={{ color: COLORS[mod as keyof typeof COLORS], ml: 4, width: 'calc(100% - 32px)', mt: -1 }} />
            </Box>
          );
        })}
      </Box>

      <Box sx={{ mt: 2.5, pt: 1.5, borderTop: '1px solid #e0e0e0', display: 'flex', gap: 1 }}>
        <TextField size="small" label="Save as preset..." value={saveAsName} onChange={e => setSaveAsName(e.target.value)}
          sx={{ flex: 1, '& .MuiInputBase-root': { borderRadius: 0 }, '& .MuiInputBase-input': { fontSize: '12px' } }} />
        <Button size="small" variant="contained" disableElevation
          onClick={() => { onSavePreset(saveAsName, weights, modules); setSaveAsName(''); }}
          disabled={!saveAsName.trim()} sx={{ borderRadius: 0, fontWeight: 'bold', fontSize: '11px' }}>
          SAVE
        </Button>
      </Box>
    </Box>
  );
}

export default function GoldHealth() {
  const { autoRefresh } = useStore();
  
  const [activeTab, setActiveTab] = useState<'operations' | 'experiment'>('operations');
  
  // UNIFIED FILTER CONTEXT STATE
  const [filterSim, setFilterSim] = useState<string>('ALL');

  // Experimentation State — Profile A
  const [activeModules, setActiveModules] = useState<string[]>([]);
  const [expWeights, setExpWeights] = useState<Record<string, number>>({});

  // Experimentation State — Profile B (A/B mode)
  const [profileMode, setProfileMode] = useState<'single' | 'ab'>('single');
  const [activeModulesB, setActiveModulesB] = useState<string[]>([]);
  const [expWeightsB, setExpWeightsB] = useState<Record<string, number>>({});
  const [savedPresets, setSavedPresets] = useState<Record<string, Record<string, number>>>(() => {
    try { return JSON.parse(localStorage.getItem('gold_weight_presets') || '{}'); } catch { return {}; }
  });

  // Queries
  const { data: metrics } = useQuery({ queryKey: ['goldMetrics'], queryFn: fetchGoldMetrics, refetchInterval: (activeTab === 'operations' && autoRefresh) ? 2000 : false });
  const { data: config } = useQuery({ queryKey: ['goldConfig'], queryFn: fetchGoldConfig, refetchInterval: false });
  
  const availableSims = useMemo(() => metrics?.active_sims || [], [metrics]);

  const { data: history } = useQuery({
    queryKey: ['goldHistory', filterSim],
    queryFn: () => fetchGoldHistory(filterSim),
    refetchInterval: (activeTab === 'operations' && autoRefresh) ? 10000 : false,
  });

  useEffect(() => {
    if (config && activeModules.length === 0) {
      setActiveModules(config.enabled_modules || ALL_MODULES);
      setExpWeights(config.default_weights || {});
    }
  }, [config]);

  useEffect(() => {
    if (config && activeModulesB.length === 0) {
      setActiveModulesB(config.enabled_modules || ALL_MODULES);
      setExpWeightsB(config.default_weights || {});
    }
  }, [config]);

  // --- PRESET MANAGEMENT ---
  const allPresets = useMemo(() => ({ ...BUILTIN_PRESETS, ...savedPresets }), [savedPresets]);

  const applyPreset = (name: string, profile: 'A' | 'B') => {
    const w = allPresets[name];
    if (!w) return;
    if (profile === 'A') {
      setExpWeights(prev => ({ ...prev, ...w }));
      setActiveModules(ALL_MODULES.filter(m => (w[m] || 0) > 0));
    } else {
      setExpWeightsB(prev => ({ ...prev, ...w }));
      setActiveModulesB(ALL_MODULES.filter(m => (w[m] || 0) > 0));
    }
  };

  const savePreset = (name: string, weights: Record<string, number>, modules: string[]) => {
    if (!name.trim()) return;
    const toSave: Record<string, number> = {};
    modules.forEach(m => { toSave[m] = weights[m] || 0; });
    setSavedPresets(prev => {
      const updated = { ...prev, [name.trim()]: toSave };
      localStorage.setItem('gold_weight_presets', JSON.stringify(updated));
      return updated;
    });
  };

  const deletePreset = (name: string) => {
    setSavedPresets(prev => {
      const { [name]: _, ...rest } = prev;
      localStorage.setItem('gold_weight_presets', JSON.stringify(rest));
      return rest;
    });
  };

  // --- PROFILE B WEIGHT HANDLERS ---
  const handleToggleModuleB = (mod: string) => {
    setActiveModulesB(prev => prev.includes(mod) ? prev.filter(m => m !== mod) : [...prev, mod]);
  };
  const handleWeightChangeB = (mod: string, val: number) => {
    setExpWeightsB(prev => ({ ...prev, [mod]: val }));
  };
  const currentWeightSumB = useMemo(
    () => activeModulesB.reduce((sum, mod) => sum + (expWeightsB[mod] || 0), 0),
    [activeModulesB, expWeightsB]
  );
  const isUnbalancedB = Math.abs(currentWeightSumB - 1.0) > 0.001;
  const autoBalanceWeightsB = () => {
    if (currentWeightSumB === 0) return;
    const balanced: Record<string, number> = {};
    activeModulesB.forEach(mod => {
      balanced[mod] = parseFloat(((expWeightsB[mod] || 0) / currentWeightSumB).toFixed(3));
    });
    setExpWeightsB(prev => ({ ...prev, ...balanced }));
  };

  const fleetHealthKpi = useMemo(() => {
    if (!history || history.length === 0) return 0;
    const latestPerVehicle: Record<string, number> = {};
    history.forEach((row: any) => {
      if (row.source_id !== undefined && row.vehicle_health_score !== undefined) {
        latestPerVehicle[String(row.source_id)] = row.vehicle_health_score;
      }
    });
    const healths = Object.values(latestPerVehicle);
    if (healths.length === 0) return 0;
    return parseFloat((healths.reduce((s, h) => s + h, 0) / healths.length).toFixed(1));
  }, [history]);

  // --- KPI LOGIC ---
  const displayLag = useMemo(() => {
    if (!metrics || !metrics.processing_lags) return 0;
    return Math.max(...Object.values(metrics.processing_lags as Record<string, number>));
  }, [metrics]);

  // --- EXPERIMENTATION CALIBRATION LOGIC ---
  const handleToggleModule = (mod: string) => {
    setActiveModules(prev => prev.includes(mod) ? prev.filter(m => m !== mod) : [...prev, mod]);
  };
  const handleWeightChange = (mod: string, val: number) => {
    setExpWeights(prev => ({ ...prev, [mod]: val }));
  };
  const currentWeightSum = useMemo(() => activeModules.reduce((sum, mod) => sum + (expWeights[mod] || 0), 0), [activeModules, expWeights]);
  const isUnbalanced = Math.abs(currentWeightSum - 1.0) > 0.001;

  const autoBalanceWeights = () => {
    if (currentWeightSum === 0) return;
    const balanced: Record<string, number> = {};
    activeModules.forEach(mod => {
      balanced[mod] = parseFloat(((expWeights[mod] || 0) / currentWeightSum).toFixed(3));
    });
    setExpWeights(prev => ({ ...prev, ...balanced }));
  };

  // --- MATHEMATICAL RE-FUSION ENGINE & FLEET AGGREGATION ---
  const simulatedHistory = useMemo(() => {
    if (!history || !config) return [];
    
    // Step 1: Calculate raw reverse-engineered health for every row
    const processedRows = history.map((row: any) => {
      let simulatedHealth = 0;
      const parsedRow: any = { ...row, ts_short: row.gold_window_ts };

      activeModules.forEach(mod => {
        const contribKey = `${mod}_contrib`;
        const rawHealth = row[contribKey] || 0;
        parsedRow[`${mod}_raw`] = rawHealth;
        simulatedHealth += rawHealth * (expWeights[mod] || 0);
      });

      parsedRow.experimental_health = parseFloat(simulatedHealth.toFixed(2));
      return parsedRow;
    });

    // Step 2: If "ALL" vehicles are selected, we must group by timestamp and average the healths
    if (filterSim === 'ALL') {
      const grouped: Record<string, any> = {};
      processedRows.forEach((row: any) => {
        if (!grouped[row.ts_short]) {
          grouped[row.ts_short] = { count: 0, experimental_health: 0, penalty_active: false };
          activeModules.forEach(m => grouped[row.ts_short][`${m}_raw`] = 0);
        }
        grouped[row.ts_short].count += 1;
        grouped[row.ts_short].experimental_health += row.experimental_health;
        grouped[row.ts_short].penalty_active = grouped[row.ts_short].penalty_active || row.penalty_active;
        activeModules.forEach(m => grouped[row.ts_short][`${m}_raw`] += row[`${m}_raw`]);
      });

      return Object.keys(grouped).map(ts => {
        const g = grouped[ts];
        const avgRow: any = { 
          ts_short: ts, 
          experimental_health: parseFloat((g.experimental_health / g.count).toFixed(2)), 
          penalty_active: g.penalty_active 
        };
        activeModules.forEach(m => avgRow[`${m}_raw`] = parseFloat((g[`${m}_raw`] / g.count).toFixed(2)));
        return avgRow;
      }).sort((a,b) => a.ts_short.localeCompare(b.ts_short));
    }

    return processedRows;
  }, [history, config, activeModules, expWeights, filterSim]);

  // --- PROFILE B SIMULATION ---
  const simulatedHistoryB = useMemo(() => {
    if (profileMode !== 'ab' || !history || !config) return [];
    const processedRows = history.map((row: any) => {
      let simulatedHealth = 0;
      const parsedRow: any = { ...row, ts_short: row.gold_window_ts };
      activeModulesB.forEach(mod => {
        const rawHealth = row[`${mod}_contrib`] || 0;
        parsedRow[`${mod}_raw_b`] = rawHealth;
        simulatedHealth += rawHealth * (expWeightsB[mod] || 0);
      });
      parsedRow.profile_b_health = parseFloat(simulatedHealth.toFixed(2));
      return parsedRow;
    });
    if (filterSim === 'ALL') {
      const grouped: Record<string, any> = {};
      processedRows.forEach((row: any) => {
        if (!grouped[row.ts_short]) grouped[row.ts_short] = { count: 0, profile_b_health: 0 };
        grouped[row.ts_short].count += 1;
        grouped[row.ts_short].profile_b_health += row.profile_b_health;
      });
      return Object.keys(grouped).map(ts => ({
        ts_short: ts,
        profile_b_health: parseFloat((grouped[ts].profile_b_health / grouped[ts].count).toFixed(2)),
      })).sort((a, b) => a.ts_short.localeCompare(b.ts_short));
    }
    return processedRows;
  }, [history, config, activeModulesB, expWeightsB, filterSim, profileMode]);

  const mergedChartData = useMemo(() => {
    if (profileMode !== 'ab') return simulatedHistory;
    const bMap: Record<string, number> = {};
    simulatedHistoryB.forEach((row: any) => { bMap[row.ts_short] = row.profile_b_health; });
    return simulatedHistory.map((row: any) => ({
      ...row,
      actual_gold: row.vehicle_health_score ?? null,
      profile_b_health: bMap[row.ts_short] ?? null,
    }));
  }, [profileMode, simulatedHistory, simulatedHistoryB]);

  // --- OPERATIONS BOARD DATA ---
  const reversedHistory = useMemo(() => (history ? [...history].reverse() : []), [history]);
  const latestRow = history && history.length > 0 ? history[history.length - 1] : null;
  const topFeatures = useMemo(() => {
    if (!latestRow || !latestRow.top_5_features) return [];
    try {
      const obj = JSON.parse(latestRow.top_5_features);
      return Object.entries(obj).map(([k, v]) => ({ feature: k, impact: v }));
    } catch { return []; }
  }, [latestRow]);

  const tableColDefs = useMemo<ColDef[]>(() => {
    if (!history || !history[0]) return [];

    const contribModules = new Set(ALL_MODULES.map(m => `${m}_contrib`));
    const friendlyName = (key: string): string => {
      const m = key.replace(/_contrib$/, '');
      if (contribModules.has(key)) return `${m.toUpperCase()} MODULE HEALTH`;
      return key.toUpperCase().replace(/_/g, ' ');
    };

    const keys = Object.keys(history[0]).filter(k => k !== 'top_5_features' && k !== 'source_id');
    const cols: ColDef[] = [];

    if (history[0].source_id) {
      cols.push({ field: 'source_id', headerName: 'VEHICLE ID', sortable: true, filter: true, width: 130, pinned: 'left' });
    }

    keys.forEach(key => {
      cols.push({
        field: key,
        headerName: friendlyName(key),
        sortable: true,
        filter: true,
        width: key.includes('ts') ? 200 : 140,
        cellStyle: key === 'vehicle_health_score' ? (params: any) => ({
          fontWeight: 'bold',
          color: params.value < 50 ? '#d32f2f' : (params.value < 80 ? '#f57c00' : '#388e3c')
        }) : undefined
      });
    });
    return cols;
  }, [history]);

  const chartAxisStyle = { fontSize: '11px', fill: '#616161', fontWeight: 600 };

  return (
    <Box sx={{ height: 'calc(100vh - 80px)', display: 'flex', flexDirection: 'column', gap: 2, p: 2, bgcolor: '#f5f5f5' }}>
      
      {/* HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '2px solid #bdbdbd', pb: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, color: '#212121', letterSpacing: '-0.5px' }}>
          GOLD LAYER: FUSED VEHICLE HEALTH
        </Typography>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <ToggleButtonGroup value={activeTab} exclusive onChange={(e, val) => val && setActiveTab(val)} size="small" sx={{ bgcolor: 'white' }}>
            <ToggleButton value="operations" sx={{ fontWeight: 'bold', px: 3, borderRadius: 0 }}>LIVE OPERATIONS</ToggleButton>
            <ToggleButton value="experiment" sx={{ fontWeight: 'bold', px: 3, borderRadius: 0 }}>WEIGHT EXPERIMENTATION LAB</ToggleButton>
          </ToggleButtonGroup>
        </Box>
      </Box>

      {/* GLOBAL FILTER CONTEXT */}
      <Paper sx={{ p: 1, borderRadius: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="body2" sx={{ fontWeight: 'bold', ml: 1 }}>FILTER CONTEXT:</Typography>
        
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel>Active Vehicle (Sim)</InputLabel>
          <Select value={filterSim} onChange={(e) => setFilterSim(e.target.value)} label="Active Vehicle (Sim)" sx={{ borderRadius: 0 }}>
            <MenuItem value="ALL" sx={{ fontWeight: 'bold' }}>ALL VEHICLES (FLEET)</MenuItem>
            {availableSims.map((sim: string) => <MenuItem key={sim} value={sim}>{sim}</MenuItem>)}
          </Select>
        </FormControl>

      </Paper>

      {/* TAB 1: LIVE OPERATIONS */}
      {activeTab === 'operations' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 2, minHeight: 0 }}>
          
          <Box sx={{ display: 'flex', gap: 2, width: '100%' }}>
            {[
              { label: 'ACTIVE SIMULATIONS', value: availableSims.length },
              { label: 'TOTAL GOLD ROWS', value: metrics?.total_gold_rows?.toLocaleString() || 0 },
              { label: 'GLOBAL MAX LAG', value: displayLag.toLocaleString(), color: displayLag > 1000 ? '#d32f2f' : '#212121' },
              { label: filterSim === 'ALL' ? 'FLEET AVG VEHICLE HEALTH' : 'CURRENT VEHICLE HEALTH', value: `${filterSim === 'ALL' ? fleetHealthKpi : (latestRow?.vehicle_health_score || 0)}%`, color: ((filterSim === 'ALL' ? fleetHealthKpi : (latestRow?.vehicle_health_score ?? 100)) < 60) ? '#d32f2f' : '#2e7d32' }
            ].map((kpi, idx) => (
              <Paper key={idx} sx={{ flex: 1, p: 2, borderRadius: 0, borderLeft: '4px solid #fbc02d' }}>
                <Typography variant="caption" sx={{ color: '#757575', fontWeight: 'bold' }}>{kpi.label}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold', color: kpi.color || '#212121', mt: 0.5 }}>{kpi.value}</Typography>
              </Paper>
            ))}
          </Box>

          <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>
            <Paper sx={{ width: '300px', p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
              <Typography variant="caption" sx={{ fontWeight: 'bold', color: '#616161', mb: 2 }}>{filterSim === 'ALL' ? 'LATEST DEGRADATION DRIVERS (FLEET)' : 'LATEST DEGRADATION DRIVERS'}</Typography>
              {topFeatures.length > 0 ? topFeatures.map((f: any, i) => (
                <Box key={i} sx={{ mb: 1.5 }}>
                  <Typography variant="body2" sx={{ fontWeight: 'bold', fontSize: '12px' }}>{f.feature}</Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ flex: 1, height: '6px', bgcolor: '#eeeeee', borderRadius: '3px', overflow: 'hidden' }}>
                      <Box sx={{ width: `${Math.min(100, (f.impact as number) * 10)}%`, height: '100%', bgcolor: '#d32f2f' }} />
                    </Box>
                    <Typography variant="caption">{parseFloat(f.impact).toFixed(2)}</Typography>
                  </Box>
                </Box>
              )) : <Typography variant="caption">Awaiting anomaly data...</Typography>}
            </Paper>

            <Paper sx={{ flex: 1, display: 'flex', flexDirection: 'column', p: 0, borderRadius: 0 }}>
              <Box className="ag-theme-balham" sx={{ flexGrow: 1, width: '100%' }}>
                <AgGridReact
                  rowData={reversedHistory}
                  columnDefs={tableColDefs}
                  defaultColDef={{ resizable: true, sortable: true }}
                />
              </Box>
            </Paper>
          </Box>
        </Box>
      )}

      {/* TAB 2: WEIGHT EXPERIMENTATION LAB */}
      {activeTab === 'experiment' && (
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 2 }}>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#424242' }}>SIMULATION MODE:</Typography>
            <ToggleButtonGroup value={profileMode} exclusive onChange={(_, val) => val && setProfileMode(val)} size="small" sx={{ bgcolor: 'white' }}>
              <ToggleButton value="single" sx={{ fontWeight: 'bold', px: 2, borderRadius: 0, fontSize: '12px' }}>SINGLE PROFILE</ToggleButton>
              <ToggleButton value="ab" sx={{ fontWeight: 'bold', px: 2, borderRadius: 0, fontSize: '12px' }}>
                <CompareArrowsIcon sx={{ fontSize: 16, mr: 0.5 }} />A/B COMPARISON
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box sx={{ display: 'flex', gap: 2, flex: 1, minHeight: 0 }}>

            <Paper sx={{ width: profileMode === 'ab' ? '280px' : '320px', p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column', borderTop: '3px solid #1976d2' }}>
              <WeightPanel
                label={profileMode === 'ab' ? 'PROFILE A' : 'DYNAMIC WEIGHT CONFIG'}
                profile="A"
                weights={expWeights}
                modules={activeModules}
                weightSum={currentWeightSum}
                isImbalanced={isUnbalanced}
                allPresets={allPresets}
                savedPresets={savedPresets}
                onWeightChange={handleWeightChange}
                onToggleModule={handleToggleModule}
                onAutoBalance={autoBalanceWeights}
                onApplyPreset={applyPreset}
                onSavePreset={savePreset}
                onDeletePreset={deletePreset}
              />
            </Paper>

            {profileMode === 'ab' && (
              <Paper sx={{ width: '280px', p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column', borderTop: '3px solid #7b1fa2' }}>
                <WeightPanel
                  label="PROFILE B"
                  profile="B"
                  weights={expWeightsB}
                  modules={activeModulesB}
                  weightSum={currentWeightSumB}
                  isImbalanced={isUnbalancedB}
                  allPresets={allPresets}
                  savedPresets={savedPresets}
                  onWeightChange={handleWeightChangeB}
                  onToggleModule={handleToggleModuleB}
                  onAutoBalance={autoBalanceWeightsB}
                  onApplyPreset={applyPreset}
                  onSavePreset={savePreset}
                  onDeletePreset={deletePreset}
                />
              </Paper>
            )}

            <Paper sx={{ flex: 1, p: 2, borderRadius: 0, display: 'flex', flexDirection: 'column' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 800, color: '#212121', mb: 2 }}>
                {filterSim === 'ALL' ? 'FLEET-WIDE AVERAGED HEALTH TRAJECTORY' : `RECALCULATED HEALTH TRAJECTORY: ${filterSim}`}
                {profileMode === 'ab' && ' — A/B COMPARISON'}
              </Typography>

              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={mergedChartData} margin={{ top: 10, right: 30, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eeeeee" />
                  <XAxis dataKey="ts_short" tick={chartAxisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} minTickGap={30} />
                  <YAxis domain={[0, 100]} tick={chartAxisStyle} axisLine={{ stroke: '#bdbdbd' }} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 0, fontSize: '12px', padding: '10px' }} />
                  <Legend wrapperStyle={{ fontSize: '12px', fontWeight: 'bold', color: '#616161' }} />

                  {profileMode === 'single' && activeModules.map(mod => (
                    <Line key={`${mod}_raw`} type="monotone" dataKey={`${mod}_raw`} name={`${mod.toUpperCase()} MODULE HEALTH`}
                      stroke={COLORS[mod as keyof typeof COLORS]} strokeWidth={1} strokeDasharray="5 5" dot={false} />
                  ))}

                  {profileMode === 'ab' && (
                    <Line type="monotone" dataKey="actual_gold" name="ACTUAL GOLD" stroke="#9e9e9e"
                      strokeWidth={1.5} strokeDasharray="4 4" dot={false} />
                  )}

                  <Line type="monotone" dataKey="experimental_health"
                    name={profileMode === 'ab' ? 'PROFILE A' : 'FUSED VEHICLE HEALTH'}
                    stroke="#1976d2" strokeWidth={4} dot={false} activeDot={{ r: 8 }} />

                  {profileMode === 'ab' && (
                    <Line type="monotone" dataKey="profile_b_health" name="PROFILE B"
                      stroke="#7b1fa2" strokeWidth={4} dot={false} activeDot={{ r: 8 }} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </Paper>
          </Box>
        </Box>
      )}
    </Box>
  );
}