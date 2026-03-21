import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { MainLayout } from './layouts/MainLayout';
import { DashboardPage } from './pages/DashboardPage';
import { DevicesPage } from './pages/DevicesPage';
import { HubPage } from './pages/HubPage';
import { SettingsPage } from './pages/SettingsPage';

function App() {
  const loadThemeConfig = useAppStore((state) => state.loadThemeConfig);

  useEffect(() => {
    // Load external JSON theme on mount
    void loadThemeConfig();
  }, [loadThemeConfig]);

  return (
    <Router>
      <MainLayout>
        <Routes>
          <Route path='/' element={<DashboardPage />} />
          <Route path='/devices' element={<DevicesPage />} />
          <Route path='/hub' element={<HubPage />} />
          <Route path='/settings' element={<SettingsPage />} />
          <Route path='*' element={<div className='text-zinc-500 font-mono p-8 text-center bg-zinc-900/50 rounded-xl border border-zinc-800 border-dashed'>Route not found or Extension not loaded</div>} />
        </Routes>
      </MainLayout>
    </Router>
  );
}

export default App;
