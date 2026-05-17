import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { MainLayout } from './layouts/MainLayout';
import { PrimaryNavigationLayout } from './layouts/PrimaryNavigationLayout';
import { SystemPage } from './pages/SystemPage';
import { MonitorPage } from './pages/MonitorPage';
import { DevicesPage } from './pages/DevicesPage';
import { SettingsPage } from './pages/SettingsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { AutomationsPage } from './pages/AutomationsPage';
import { ServicesPage } from './pages/ServicesPage';

function App() {
  const loadExternalTheme = useAppStore((state) => state.loadExternalTheme);
  const connectUpdateProgressStream = useAppStore((state) => state.connectUpdateProgressStream);
  const disconnectUpdateProgressStream = useAppStore((state) => state.disconnectUpdateProgressStream);
  const fetchUpdateProgress = useAppStore((state) => state.fetchUpdateProgress);

  useEffect(() => {
    void loadExternalTheme();
  }, [loadExternalTheme]);

  useEffect(() => {
    connectUpdateProgressStream();
    return () => {
      disconnectUpdateProgressStream();
    };
  }, [connectUpdateProgressStream, disconnectUpdateProgressStream]);

  useEffect(() => {
    void fetchUpdateProgress();
  }, [fetchUpdateProgress]);

  return (
    <Router>
      <MainLayout>
        <Routes>
          <Route element={<PrimaryNavigationLayout />}>
            <Route path='/' element={null} />
            <Route path='/system' element={null} />
            <Route
              path='/system/notifications'
              element={<PageContent><NotificationsPage hideHeader /></PageContent>}
            />
            <Route
              path='/system/automations'
              element={<PageContent><AutomationsPage hideHeader /></PageContent>}
            />
            <Route
              path='/system/theme'
              element={<PageContent><SettingsPage hideHeader /></PageContent>}
            />
            <Route path='/system/:sectionId' element={<SystemPage />} />
            <Route path='/monitor' element={<PageContent><MonitorPage /></PageContent>} />
            <Route path='/devices' element={null} />
            <Route path='/devices/add' element={<PageContent><DevicesPage initialShowAddPicker /></PageContent>} />
            <Route path='/devices/:deviceId' element={<PageContent><RoutedDevicePage /></PageContent>} />
            <Route path='/services' element={<PageContent><ServicesPage /></PageContent>} />
            <Route path='/notifications' element={<Navigate to='/system/notifications' replace />} />
            <Route path='/automations' element={<Navigate to='/system/automations' replace />} />
            <Route path='/settings' element={<Navigate to='/system/theme' replace />} />
          </Route>
          <Route path='*' element={<div className='text-muted-foreground font-mono p-8 text-center bg-card border border-white/5'>Route not found or Extension not loaded</div>} />
        </Routes>
      </MainLayout>
    </Router>
  );
}

export default App;

function PageContent({ children }: { children: React.ReactNode }) {
  return <div className='space-y-6 pb-8'>{children}</div>;
}

function RoutedDevicePage() {
  const { deviceId } = useParams();

  return <DevicesPage selectedDeviceId={deviceId ? decodeURIComponent(deviceId) : undefined} />;
}
