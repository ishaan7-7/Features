import { HashRouter, Routes, Route } from 'react-router-dom';
import { Paper, Typography } from '@mui/material';
import Layout from './components/Layout';
import WriterOps from './pages/WriterOps';
import GoldHealth from './pages/GoldHealth';
import AutomotiveDive from './pages/AutomotiveDive';
import DashboardInference from './pages/DashboardInference';
import DashboardAlerts from './pages/DashboardAlerts';

const PlaceholderView = ({ title }: { title: string }) => (
  <Paper sx={{ p: 4, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <Typography variant="h5" color="textSecondary" sx={{ fontWeight: 500 }}>
      {title} Module awaiting integration...
    </Typography>
  </Paper>
);

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<WriterOps />} />
          <Route path="inference" element={<DashboardInference />} />
          <Route path="gold" element={<GoldHealth />} />
          <Route path="alerts" element={<DashboardAlerts />} />
          <Route path="replay" element={<PlaceholderView title="Telemetry Replay" />} />
          <Route path="automotive" element={<AutomotiveDive />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;