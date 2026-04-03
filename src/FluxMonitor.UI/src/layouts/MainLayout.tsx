import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { UpdateLockOverlay } from '../components/UpdateLockOverlay';
import { useAppStore } from '../store/useAppStore';

export function MainLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const updateProgress = useAppStore((state) => state.updateProgress);
  const hasUpdateOverlay = updateProgress !== null;
  const hasBlockingUpdateOverlay = updateProgress?.isRunning ?? false;
  const [scrollContainer, setScrollContainer] = useState<HTMLElement | null>(null);
  const scrollPositionsRef = useRef(new Map<string, number>());
  const restoreFrameRef = useRef<number | null>(null);
  const scrollKey = `${location.pathname}${location.search}${location.hash}`;

  const scrollKeyRef = useRef(scrollKey);
  scrollKeyRef.current = scrollKey;

  useEffect(() => {
    document.body.style.overflow = hasUpdateOverlay ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [hasUpdateOverlay]);

  // Continuously save scroll position as the user scrolls.
  // The listener depends only on scrollContainer (not scrollKey) so it is never
  // torn down and re-created on navigation. It reads scrollKeyRef.current which
  // is always up-to-date.
  useEffect(() => {
    if (!scrollContainer) {
      return;
    }

    const onScroll = () => {
      scrollPositionsRef.current.set(scrollKeyRef.current, scrollContainer.scrollTop);
    };

    scrollContainer.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', onScroll);
    };
  }, [scrollContainer]);

  // Restore scroll position when arriving at a route.
  useLayoutEffect(() => {
    if (!scrollContainer) {
      return;
    }

    const saved = scrollPositionsRef.current.get(scrollKey) ?? 0;
    scrollContainer.scrollTop = saved;

    if (typeof window !== 'undefined') {
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        scrollContainer.scrollTop = saved;
        restoreFrameRef.current = null;
      });
    }

    return () => {
      if (restoreFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [scrollContainer, scrollKey]);

  return (
    <div className='app-shell flex h-full w-full overflow-hidden bg-background font-sans text-foreground'>
      {!hasBlockingUpdateOverlay ? (
        <div className='flex h-full min-w-0 flex-1 flex-col'>
          <main ref={setScrollContainer} className='safe-area-main flex min-h-0 flex-1 w-full overflow-y-auto'>
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
