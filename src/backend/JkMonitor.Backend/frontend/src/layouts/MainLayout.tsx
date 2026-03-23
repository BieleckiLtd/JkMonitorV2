import { useEffect, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { Cable, Settings, Puzzle, Menu, Activity, Monitor, Gauge, X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Sidebar() {
  const isDesktopSidebarOpen = useAppStore((state) => state.isDesktopSidebarOpen);
  const isMobileSidebarOpen = useAppStore((state) => state.isMobileSidebarOpen);
  const closeMobileSidebar = useAppStore((state) => state.closeMobileSidebar);

  const navItems = [
    { name: 'System', path: '/', icon: Monitor },
    { name: 'Monitor', path: '/monitor', icon: Gauge },
    { name: 'Devices Structure', path: '/devices', icon: Cable },
    { name: 'Community Hub', path: '/hub', icon: Puzzle },
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
                JK Monitor <span className='font-light text-muted-foreground/70'>V2</span>
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

export function Header() {
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);

  return (
    <header className="h-14 bg-background/50 backdrop-blur-md border-b border-border flex items-center justify-between px-4 sticky top-0 z-10 shrink-0">
      <div className="flex items-center gap-4">
        <button 
          onClick={toggleSidebar}
          className="p-1.5 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <Menu className="h-5 w-5" />
        </button>
        {/* Breadcrumb could go here */}
        <h1 className="text-sm font-medium text-foreground/90 hidden sm:block">Command Center</h1>
      </div>
      
      <div className="flex items-center gap-3">
        {/* Status Indicators */}
        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 border border-primary/20">
          <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
          <span className="text-xs font-medium text-primary">System Healthy</span>
        </div>
      </div>
    </header>
  );
}

export function MainLayout({ children }: { children: ReactNode }) {
  const isMobileSidebarOpen = useAppStore((state) => state.isMobileSidebarOpen);

  useEffect(() => {
    document.body.style.overflow = isMobileSidebarOpen ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileSidebarOpen]);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background font-sans text-foreground">
      <Sidebar />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1 w-full overflow-y-auto px-1 py-2 sm:p-4 md:p-6">
          <div className="mx-auto w-full max-w-7xl">
            {children}
          </div>
        </main>
      </div>
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
      <div className='flex h-14 items-center justify-center border-b border-border'>
        <Activity className='h-6 w-6 shrink-0 text-primary' />
        {!isCollapsed && (
          <span className='ml-3 overflow-hidden text-ellipsis whitespace-nowrap font-semibold tracking-tight text-foreground'>
            JK Monitor <span className='font-light text-muted-foreground/70'>V2</span>
          </span>
        )}
      </div>

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
        {isCollapsed ? (
          <Puzzle className='mx-auto h-4 w-4 text-muted-foreground/50' />
        ) : (
          <div className='text-center font-mono text-xs text-muted-foreground/50'>Open for Extensions</div>
        )}
      </div>
    </>
  );
}
