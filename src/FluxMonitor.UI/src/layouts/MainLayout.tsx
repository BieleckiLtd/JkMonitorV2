import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { AppBarProvider } from '../components/AppBar';
import { UpdateLockOverlay } from '../components/UpdateLockOverlay';
import { useAppStore } from '../store/useAppStore';

export function MainLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const updateProgress = useAppStore((state) => state.updateProgress);
  const hasUpdateOverlay = updateProgress !== null;
  const hasBlockingUpdateOverlay = updateProgress?.isRunning ?? false;
  const scrollPositionsRef = useRef(new Map<string, number>());
  const restoreFrameRef = useRef<number | null>(null);
  const scrollKey = `${location.pathname}${location.search}${location.hash}`;
  const activeScrollKeyRef = useRef(scrollKey);
  const previousScrollKeyRef = useRef(scrollKey);

  activeScrollKeyRef.current = scrollKey;

  useEffect(() => {
    document.body.style.overflow = hasUpdateOverlay ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [hasUpdateOverlay]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onScroll = () => {
      scrollPositionsRef.current.set(activeScrollKeyRef.current, window.scrollY);
    };

    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    scrollPositionsRef.current.set(previousScrollKeyRef.current, window.scrollY);

    const saved = scrollPositionsRef.current.get(scrollKey) ?? 0;
    previousScrollKeyRef.current = scrollKey;
    window.scrollTo(0, saved);

    restoreFrameRef.current = window.requestAnimationFrame(() => {
      window.scrollTo(0, saved);
      restoreFrameRef.current = null;
    });

    return () => {
      if (restoreFrameRef.current !== null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [scrollKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) {
      return;
    }

    const previousValue = window.history.scrollRestoration;
    window.history.scrollRestoration = 'manual';

    return () => {
      window.history.scrollRestoration = previousValue;
    };
  }, []);

  return (
    <div className='app-shell flex w-full flex-col font-sans text-foreground'>
      {!hasBlockingUpdateOverlay ? (
        <div className='flex min-w-0 flex-1 flex-col'>
          <AppBarProvider>
            <main className='app-main flex min-w-0 flex-1 w-full'>
              <div className='mx-auto flex min-h-full w-full max-w-none flex-col'>
                {children}
              </div>
            </main>
          </AppBarProvider>
        </div>
      ) : null}
      <UpdateLockOverlay />
    </div>
  );
}
