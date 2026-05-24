import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import WriterOps from './pages/WriterOps';
import GoldHealth from './pages/GoldHealth';
import AutomotiveDive from './pages/AutomotiveDive';
import DashboardInference from './pages/DashboardInference';
import DashboardAlerts from './pages/DashboardAlerts';

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
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default App;