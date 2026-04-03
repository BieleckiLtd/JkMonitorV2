import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { useAppStore } from './store/useAppStore';
import { MainLayout } from './layouts/MainLayout';
import { StackPageHeader } from './components/StackPageHeader';
import { getPrimaryNavigationItem } from './lib/navigation';
import { MainMenuPage } from './pages/MainMenuPage';
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
          <Route path='/' element={<MainMenuPage />} />
          <Route path='/system' element={<SystemPage />} />
          <Route path='/system/:sectionId' element={<SystemPage />} />
          <Route path='/monitor' element={<PrimaryPage titlePath='/monitor'><MonitorPage /></PrimaryPage>} />
          <Route path='/devices' element={<PrimaryPage titlePath='/devices'><DevicesPage /></PrimaryPage>} />
          <Route path='/services' element={<PrimaryPage titlePath='/services'><ServicesPage /></PrimaryPage>} />
          <Route path='/notifications' element={<PrimaryPage titlePath='/notifications'><NotificationsPage /></PrimaryPage>} />
          <Route path='/settings' element={<PrimaryPage titlePath='/settings'><SettingsPage /></PrimaryPage>} />
          <Route path='*' element={<div className='text-zinc-500 font-mono p-8 text-center bg-zinc-900/50 rounded-xl border border-zinc-800 border-dashed'>Route not found or Extension not loaded</div>} />
        </Routes>
      </MainLayout>
    </Router>
  );
}

export default App;

function PrimaryPage({ titlePath, children }: { titlePath: string; children: ReactNode }) {
  const item = getPrimaryNavigationItem(titlePath);

  if (!item) {
    return <Navigate to='/' replace />;
  }

  return (
    <div className='space-y-6 pb-8'>
      <StackPageHeader
        backTo='/'
        title={item.name}
        description={item.description}
      />
      {children}
    </div>
  );
}
