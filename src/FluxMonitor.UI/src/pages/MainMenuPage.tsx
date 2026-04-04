import { useSetAppBar } from '../components/AppBar';
import { PrimaryNavigationPanel } from '../components/PrimaryNavigationPanel';

export function MainMenuPage() {
  useSetAppBar({ title: 'FLUX_MONITOR', description: '' });

  return <MainMenuContent />;
}

export function MainMenuContent() {
  return (
    <div className='pb-8'>
      <PrimaryNavigationPanel />
    </div>
  );
}
