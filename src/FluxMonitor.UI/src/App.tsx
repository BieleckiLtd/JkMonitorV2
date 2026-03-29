import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { MainLayout } from './layouts/MainLayout';
import { SystemPage } from './pages/SystemPage';
import { MonitorPage } from './pages/MonitorPage';
import { DevicesPage } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ServicesPage } from './pages/ServicesPage';

function App() {
  const loadExternalTheme = useAppStore((state) => state.loadExternalTheme);
  const connectUpdateProgressStream = useAppStore((state) => state.connectUpdateProgressStream);
  const disconnectUpdateProgressStream = useAppStore((state) => state.disconnectUpdateProgressStream);

  useEffect(() => {
    void loadExternalTheme();
  }, [loadExternalTheme]);

  useEffect(() => {
    connectUpdateProgressStream();
    return () => {
      disconnectUpdateProgressStream();
    };
  }, [connectUpdateProgressStream, disconnectUpdateProgressStream]);

  return (
    <Router>
      <MainLayout>
        <Routes>
          <Route path='/' element={<SystemPage />} />
          <Route path='/monitor' element={<MonitorPage />} />
          <Route path='/devices' element={<DevicesPage />} />
          <Route path='/services' element={<ServicesPage />} />
          <Route path='/notifications' element={<NotificationsPage />} />
          <Route path='/settings' element={<SettingsPage />} />
          <Route path='*' element={<div className='text-zinc-500 font-mono p-8 text-center bg-zinc-900/50 rounded-xl border border-zinc-800 border-dashed'>Route not found or Extension not loaded</div>} />
        </Routes>
      </MainLayout>
    </Router>
  );
}

export default App;
