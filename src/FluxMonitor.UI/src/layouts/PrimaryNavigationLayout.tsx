import { Outlet } from 'react-router-dom';
import { PrimaryNavigationPanel } from '../components/PrimaryNavigationPanel';
import { useMediaQuery } from '../hooks/useMediaQuery';

const primaryNavigationSplitQuery = '(min-width: 768px)';

export function PrimaryNavigationLayout() {
  const showSplitLayout = useMediaQuery(primaryNavigationSplitQuery);

  if (!showSplitLayout) {
    return <Outlet />;
  }

  return (
    <div className='grid min-h-full items-start gap-6 md:grid-cols-[17.5rem_minmax(0,1fr)] xl:grid-cols-[18.5rem_minmax(0,1fr)]'>
      <aside className='hidden self-start md:block md:sticky md:top-[calc(var(--app-safe-top)+4.25rem)]'>
        <PrimaryNavigationPanel />
      </aside>

      <section className='min-w-0 rounded-3xl border border-border/70 bg-card/45 p-4 shadow-sm backdrop-blur-sm md:p-5 xl:p-6'>
        <Outlet />
      </section>
    </div>
  );
}
