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

  useEffect(() => {
    document.body.style.overflow = hasUpdateOverlay ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [hasUpdateOverlay]);

  useLayoutEffect(() => {
    if (!scrollContainer) {
      return;
    }

    const restoreScrollPosition = () => {
      scrollContainer.scrollTop = scrollPositionsRef.current.get(scrollKey) ?? 0;
    };

    restoreScrollPosition();

    if (typeof window !== 'undefined') {
      restoreFrameRef.current = window.requestAnimationFrame(() => {
        restoreScrollPosition();
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

  useEffect(() => {
    if (!scrollContainer) {
      return;
    }

    const saveScrollPosition = () => {
      scrollPositionsRef.current.set(scrollKey, scrollContainer.scrollTop);
    };

    saveScrollPosition();
    scrollContainer.addEventListener('scroll', saveScrollPosition, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', saveScrollPosition);
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
