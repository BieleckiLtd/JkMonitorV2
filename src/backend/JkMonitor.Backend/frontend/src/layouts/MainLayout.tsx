import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAppStore } from '../store/useAppStore';
import { Cable, Settings, Puzzle, Menu, Activity, Monitor } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function Sidebar() {
  const isSidebarOpen = useAppStore((state) => state.isSidebarOpen);

  const navItems = [
    { name: 'System', path: '/', icon: Monitor },
    { name: 'Devices Structure', path: '/devices', icon: Cable },
    { name: 'Community Hub', path: '/hub', icon: Puzzle },
    { name: 'Settings', path: '/settings', icon: Settings },
  ];

  return (
    <aside
      className={cn(
        "bg-background border-r border-border transition-all duration-300 flex flex-col h-full shrink-0 hidden md:flex",
        isSidebarOpen ? "w-64" : "w-16"
      )}
    >
      <div className="h-14 flex items-center justify-center border-b border-border">
        <Activity className="h-6 w-6 text-primary shrink-0" />
        {isSidebarOpen && (
          <span className="ml-3 font-semibold text-foreground tracking-tight whitespace-nowrap overflow-hidden text-ellipsis">
            JK Monitor <span className="text-muted-foreground/70 font-light">V2</span>
          </span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) =>
              cn(
                "flex items-center px-2 py-2.5 rounded-md transition-colors group relative",
                isActive 
                  ? "bg-primary/10 text-primary" 
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )
            }
            title={!isSidebarOpen ? item.name : undefined}
          >
            <item.icon className={cn("h-5 w-5 shrink-0", !isSidebarOpen && "mx-auto")} />
            {isSidebarOpen && <span className="ml-3 font-medium text-sm">{item.name}</span>}
          </NavLink>
        ))}
      </nav>

      {/* Extension Injection Point Reminder */}
      <div className="p-4 border-t border-border">
        {isSidebarOpen ? (
          <div className="text-xs text-muted-foreground/50 font-mono text-center">Open for Extensions</div>
        ) : (
          <Puzzle className="h-4 w-4 mx-auto text-muted-foreground/50" />
        )}
      </div>
    </aside>
  );
}

export function Header() {
  const { toggleSidebar } = useAppStore();

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

  return (
    <div className="h-screen w-full flex overflow-hidden font-sans text-foreground bg-background">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 h-full">
        <Header />
        <main className="flex-1 overflow-y-auto w-full p-6">
          <div className="max-w-7xl mx-auto w-full h-full">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
