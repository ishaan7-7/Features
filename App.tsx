import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import WriterOps from './pages/WriterOps';
import GoldHealth from './pages/GoldHealth';
import AutomotiveDive from './pages/AutomotiveDive';
import DashboardInference from './pages/DashboardInference';
import DashboardAlerts from './pages/DashboardAlerts';
import FleetHealth from './pages/FleetHealth';
import DtcInvestigation from './pages/DtcInvestigation';

function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<WriterOps />} />
          <Route path="inference" element={<DashboardInference />} />
          <Route path="gold" element={<GoldHealth />} />
          <Route path="alerts" element={<DashboardAlerts />} />
          <Route path="automotive" element={<AutomotiveDive />} />
          <Route path="fleet" element={<FleetHealth />} />
          <Route path="dtc" element={<DtcInvestigation />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;