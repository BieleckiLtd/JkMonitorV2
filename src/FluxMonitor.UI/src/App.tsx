import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { useAppStore } from './store/useAppStore';
import { MainLayout } from './layouts/MainLayout';
import { PrimaryNavigationLayout } from './layouts/PrimaryNavigationLayout';
import { useSetAppBar } from './components/AppBar';
import { PrimaryNavigationEmptyState } from './components/PrimaryNavigationPanel';
import { useMediaQuery } from './hooks/useMediaQuery';
import { getPrimaryNavigationItem } from './lib/navigation';
import { MainMenuContent } from './pages/MainMenuPage';
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
            <Route path='/' element={<PrimaryNavigationHomePage />} />
            <Route path='/system' element={<SystemPage />} />
            <Route
              path='/system/notifications'
              element={(
                <SystemSubpage title='Notifications' description='Alerts, channels, and delivery rules'>
                  <NotificationsPage hideHeader />
                </SystemSubpage>
              )}
            />
            <Route
              path='/system/theme'
              element={(
                <SystemSubpage title='Theme' description='Choose the active visual theme'>
                  <SettingsPage hideHeader />
                </SystemSubpage>
              )}
            />
            <Route path='/system/:sectionId' element={<SystemPage />} />
            <Route path='/monitor' element={<PrimaryPage titlePath='/monitor'><MonitorPage /></PrimaryPage>} />
            <Route path='/devices' element={<PrimaryPage titlePath='/devices'><DevicesPage /></PrimaryPage>} />
            <Route path='/services' element={<PrimaryPage titlePath='/services'><ServicesPage /></PrimaryPage>} />
            <Route path='/notifications' element={<Navigate to='/system/notifications' replace />} />
            <Route path='/settings' element={<Navigate to='/system/theme' replace />} />
          </Route>
          <Route path='*' element={<div className='text-muted-foreground font-mono p-8 text-center bg-card border border-white/5'>Route not found or Extension not loaded</div>} />
        </Routes>
      </MainLayout>
    </Router>
  );
}

export default App;

function PrimaryNavigationHomePage() {
  const showSplitLayout = useMediaQuery('(min-width: 768px)');

  useSetAppBar({ title: 'FLUX_MONITOR', description: '' });

  return showSplitLayout ? <PrimaryNavigationEmptyState /> : <MainMenuContent />;
}

function PrimaryPage({ titlePath, children }: { titlePath: string; children: ReactNode }) {
  const item = getPrimaryNavigationItem(titlePath);

  if (!item) {
    return <Navigate to='/' replace />;
  }

  useSetAppBar({ title: item.name, description: item.description, backTo: '/' });

  return (
    <div className='space-y-6 pb-8'>
      {children}
    </div>
  );
}

function SystemSubpage({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  useSetAppBar({ title, description, backTo: '/system' });

  return (
    <div className='space-y-6 pb-8'>
      {children}
    </div>
  );
}
