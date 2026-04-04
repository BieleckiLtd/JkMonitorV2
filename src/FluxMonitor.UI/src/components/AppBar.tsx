import { useEffect, useRef, useState, createContext, useContext, useCallback, useMemo, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { runWithViewTransition } from '../lib/viewTransitions';

type AppBarState = {
  title: string;
  description: string;
  backTo?: string;
  backLabel?: string;
};

type AppBarContextValue = {
  setAppBar: (state: AppBarState) => void;
  clearAppBar: () => void;
};

const AppBarContext = createContext<AppBarContextValue | null>(null);

export function useSetAppBar(state: AppBarState) {
  const ctx = useContext(AppBarContext);

  useEffect(() => {
    ctx?.setAppBar(state);
    return () => {
      ctx?.clearAppBar();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, state.title, state.description, state.backTo, state.backLabel]);
}

export function AppBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppBarState | null>(null);

  const setAppBar = useCallback((s: AppBarState) => {
    setState(s);
  }, []);

  const clearAppBar = useCallback(() => {
    setState(null);
  }, []);

  const ctxValue = useMemo(() => ({ setAppBar, clearAppBar }), [setAppBar, clearAppBar]);

  return (
    <AppBarContext.Provider value={ctxValue}>
      <AppBar state={state} />
      {children}
    </AppBarContext.Provider>
  );
}

function AppBar({ state }: { state: AppBarState | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const barRef = useRef<HTMLElement>(null);
  const lastScrollYRef = useRef(0);
  const hiddenRef = useRef(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    hiddenRef.current = false;
    lastScrollYRef.current = 0;
  }, [location.pathname]);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const delta = y - lastScrollYRef.current;

      if (y <= 8) {
        if (hiddenRef.current) {
          hiddenRef.current = false;
          setHidden(false);
        }
      } else if (delta > 4 && !hiddenRef.current) {
        hiddenRef.current = true;
        setHidden(true);
      } else if (delta < -4 && hiddenRef.current) {
        hiddenRef.current = false;
        setHidden(false);
      }

      lastScrollYRef.current = y;
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (!state) return null;

  return (
    <header
      ref={barRef}
      className='app-bar'
      style={{
        transform: hidden ? 'translateY(-100%)' : 'translateY(0)',
      }}
    >
      <div className='flex items-center gap-2'>
        {state.backTo ? (
          <button
            type='button'
            onClick={() => {
              runWithViewTransition(() => {
                navigate(state.backTo!);
              }, { direction: 'back' });
            }}
            className='inline-flex items-center gap-1.5 py-1.5 font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground transition-colors duration-100 hover:text-primary'
          >
            <ChevronLeft className='h-4 w-4' />
            {state.backLabel ?? 'Back'}
          </button>
        ) : null}
      </div>
      <div className='flex items-center gap-3'>
        <div className='min-w-0'>
          <div className='truncate font-mono text-sm font-bold text-primary'>{state.title}</div>
        </div>
      </div>
    </header>
  );
}
