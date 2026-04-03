import { useEffect, type ReactNode } from 'react';
import { UpdateLockOverlay } from '../components/UpdateLockOverlay';
import { useAppStore } from '../store/useAppStore';

export function MainLayout({ children }: { children: ReactNode }) {
  const updateProgress = useAppStore((state) => state.updateProgress);
  const hasUpdateOverlay = updateProgress !== null;
  const hasBlockingUpdateOverlay = updateProgress?.isRunning ?? false;

  useEffect(() => {
    document.body.style.overflow = hasUpdateOverlay ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [hasUpdateOverlay]);

  return (
    <div className='app-shell flex h-full w-full overflow-hidden bg-background font-sans text-foreground'>
      {!hasBlockingUpdateOverlay ? (
        <div className='flex h-full min-w-0 flex-1 flex-col'>
          <main className='safe-area-main flex min-h-0 flex-1 w-full overflow-y-auto'>
            <div className='mx-auto flex min-h-full w-full max-w-none flex-col'>
              {children}
            </div>
          </main>
        </div>
      ) : null}
      <UpdateLockOverlay />
    </div>
  );
}
