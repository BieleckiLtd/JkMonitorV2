import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Bell, Cable, Settings, Menu, Activity, Monitor, Gauge, X, Sparkles } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { UpdateLockOverlay } from '../components/UpdateLockOverlay';
import { useAppStore } from '../store/useAppStore';

type DeviceClockSnapshot = {
  localDateTime: string;
  timeZoneId: string;
  utcOffsetMinutes: number;
};

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Sidebar() {
  const isDesktopSidebarOpen = useAppStore((state) => state.isDesktopSidebarOpen);
  const isMobileSidebarOpen = useAppStore((state) => state.isMobileSidebarOpen);
  const closeMobileSidebar = useAppStore((state) => state.closeMobileSidebar);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);

  const navItems = [
    { name: 'System', path: '/', icon: Monitor },
    { name: 'Monitor', path: '/monitor', icon: Gauge },
    { name: 'Devices', path: '/devices', icon: Cable },
    { name: 'Services', path: '/services', icon: Sparkles },
    { name: 'Notifications', path: '/notifications', icon: Bell },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];

  return (
    <>
      <aside
        className={cn(
          'hidden h-full shrink-0 flex-col border-r border-border bg-background transition-all duration-300 md:flex',
          isDesktopSidebarOpen ? 'w-64' : 'w-16'
        )}
      >
        <div
          className={cn(
            'flex h-14 items-center border-b border-border px-3',
            isDesktopSidebarOpen ? 'justify-between gap-3' : 'justify-center gap-2 px-2'
          )}
        >
          <div className='flex min-w-0 items-center gap-3 overflow-hidden'>
            <Activity className='h-6 w-6 shrink-0 text-primary' />
            {!isDesktopSidebarOpen && null}
            {isDesktopSidebarOpen && (
              <span className='overflow-hidden text-ellipsis whitespace-nowrap font-semibold tracking-tight text-foreground'>
                Flux Monitor
              </span>
            )}
          </div>
          <button
            onClick={toggleSidebar}
            className='rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
            aria-label={isDesktopSidebarOpen ? 'Collapse navigation' : 'Expand navigation'}
          >
            <Menu className='h-5 w-5' />
          </button>
        </div>
        <SidebarContent navItems={navItems} isCollapsed={!isDesktopSidebarOpen} />
      </aside>

      <div
        className={cn(
          'fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 md:hidden',
          isMobileSidebarOpen ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        )}
        onClick={closeMobileSidebar}
        aria-hidden={!isMobileSidebarOpen}
      >
        <aside
          className={cn(
            'flex h-full w-[min(18rem,85vw)] flex-col border-r border-border bg-background shadow-2xl transition-transform duration-300',
            isMobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <div className='flex h-14 items-center justify-between border-b border-border px-4'>
            <div className='flex items-center gap-3'>
              <Activity className='h-6 w-6 shrink-0 text-primary' />
              <span className='font-semibold tracking-tight text-foreground'>
                Flux Monitor
              </span>
            </div>
            <button
              onClick={closeMobileSidebar}
              className='rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground'
              aria-label='Close navigation'
            >
              <X className='h-5 w-5' />
            </button>
          </div>
          <SidebarContent navItems={navItems} isCollapsed={false} onNavigate={closeMobileSidebar} />
        </aside>
      </div>
    </>
  );
}

function MobileSidebarToggle() {
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);

  return (
    <button
      type='button'
      onClick={toggleSidebar}
      className='safe-area-fab fixed z-30 inline-flex h-12 items-center gap-2 rounded-full border border-border/70 bg-background/72 px-4 text-sm font-medium text-foreground shadow-lg shadow-black/10 backdrop-blur-xl transition-colors hover:bg-background/88 md:hidden'
      aria-label='Open navigation'
    >
      <Menu className='h-5 w-5' />
      <span>Menu</span>
    </button>
  );
}

export function MainLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isMobileSidebarOpen = useAppStore((state) => state.isMobileSidebarOpen);
  const updateProgress = useAppStore((state) => state.updateProgress);
  const hasUpdateOverlay = updateProgress !== null;
  const hasBlockingUpdateOverlay = updateProgress?.isRunning ?? false;
  const isFullWidthRoute = location.pathname === '/' || location.pathname === '/services';

  useEffect(() => {
    document.body.style.overflow = isMobileSidebarOpen || hasUpdateOverlay ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [hasUpdateOverlay, isMobileSidebarOpen]);

  return (
    <div className="app-shell flex h-full w-full overflow-hidden bg-background font-sans text-foreground">
      {!hasBlockingUpdateOverlay ? (
        <>
          <Sidebar />
          <MobileSidebarToggle />
          <div className="flex h-full min-w-0 flex-1 flex-col">
            <main className="safe-area-main flex min-h-0 flex-1 w-full overflow-y-auto">
              <div className={cn('flex min-h-full w-full flex-col', isFullWidthRoute ? 'max-w-none' : 'mx-auto max-w-7xl')}>
                {children}
              </div>
            </main>
          </div>
        </>
      ) : null}
      <UpdateLockOverlay />
    </div>
  );
}

type NavItem = {
  name: string;
  path: string;
  icon: typeof Monitor;
};

function SidebarContent({ navItems, isCollapsed, onNavigate }: { navItems: NavItem[]; isCollapsed: boolean; onNavigate?: () => void }) {
  return (
    <>
      <nav className='flex-1 space-y-1 overflow-y-auto px-2 py-4'>
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center rounded-md px-2 py-2.5 transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )
            }
            title={isCollapsed ? item.name : undefined}
          >
            <item.icon className={cn('h-5 w-5 shrink-0', isCollapsed && 'mx-auto')} />
            {!isCollapsed && <span className='ml-3 text-sm font-medium'>{item.name}</span>}
          </NavLink>
        ))}
      </nav>

      <div className='border-t border-border p-4'>
        <DeviceClockFooter isCollapsed={isCollapsed} />
      </div>
    </>
  );
}

function DeviceClockFooter({ isCollapsed }: { isCollapsed: boolean }) {
  const [clockSnapshot, setClockSnapshot] = useState<{ wallClockMs: number; syncedAtMs: number } | null>(null);
  const [renderedAtMs, setRenderedAtMs] = useState(() => Date.now());

  useEffect(() => {
    let isMounted = true;

    const loadClock = async () => {
      try {
        const response = await fetch('/api/system/clock', { cache: 'no-store' });
        if (!response.ok) {
          throw new Error('Unable to load device time.');
        }

        const data = await response.json() as DeviceClockSnapshot;
        const wallClockMs = parseDeviceWallClockMs(data.localDateTime);
        if (!isMounted || wallClockMs === null) {
          return;
        }

        const syncedAtMs = Date.now();
        setClockSnapshot({ wallClockMs, syncedAtMs });
        setRenderedAtMs(syncedAtMs);
      } catch {
        return;
      }
    };

    void loadClock();
    const refreshHandle = window.setInterval(() => {
      void loadClock();
    }, 60000);

    return () => {
      isMounted = false;
      window.clearInterval(refreshHandle);
    };
  }, []);

  useEffect(() => {
    const tickHandle = window.setInterval(() => {
      setRenderedAtMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(tickHandle);
    };
  }, []);

  if (!clockSnapshot) {
    return (
      <div className={cn('text-center font-mono text-xs text-muted-foreground/50', isCollapsed && 'text-[11px]')}>
        {isCollapsed ? '--:--' : 'Loading time...'}
      </div>
    );
  }

  const wallClockNow = new Date(clockSnapshot.wallClockMs + (renderedAtMs - clockSnapshot.syncedAtMs));

  return (
    <div className={cn('text-center font-mono text-muted-foreground/70', isCollapsed ? 'text-[11px]' : 'space-y-1')}>
      <div className='tabular-nums'>{formatDeviceTime(wallClockNow, !isCollapsed)}</div>
      {!isCollapsed && (
        <div className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground/50'>
          {formatDeviceDate(wallClockNow)}
        </div>
      )}
    </div>
  );
}

function parseDeviceWallClockMs(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, millisecond = '0'] = match;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millisecond.padEnd(3, '0'))
  );
}

function formatDeviceTime(value: Date, includeSeconds: boolean) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
    hour12: false,
    timeZone: 'UTC',
  }).format(value);
}

function formatDeviceDate(value: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}
