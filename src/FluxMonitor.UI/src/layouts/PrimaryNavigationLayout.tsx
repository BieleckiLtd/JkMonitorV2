import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { type ReactNode } from 'react';
import { PrimaryNavigationPanel, PrimaryNavigationEmptyState } from '../components/PrimaryNavigationPanel';
import { SystemNavigationPanel } from '../components/SystemNavigationPanel';
import { useSetAppBar } from '../components/AppBar';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { getPrimaryNavigationItem, oneMenuQuery, twoMenuQuery } from '../lib/navigation';
import { defaultSystemSection, getSystemMenuItem } from '../lib/systemNavigation';

export function PrimaryNavigationLayout() {
  const location = useLocation();
  const pathname = location.pathname;

  const canFitOneMenu = useMediaQuery(oneMenuQuery);
  const canFitTwoMenus = useMediaQuery(twoMenuQuery);
  const menuSlots = canFitTwoMenus ? 2 : canFitOneMenu ? 1 : 0;

  const isRoot = pathname === '/';
  const isSystemRoot = pathname === '/system';
  const systemChildMatch = pathname.match(/^\/system\/([^/]+)/);
  const systemChildId = systemChildMatch?.[1] ?? null;
  const isSystemChild = systemChildId !== null;
  const isSystemRoute = isSystemRoot || isSystemChild;
  const isPrimaryPage = !isRoot && !isSystemRoute;

  const shouldRedirect = isSystemRoot && menuSlots >= 2;

  // AppBar must be called unconditionally (React hook rules)
  useSetAppBar(
    computeAppBarState(pathname, menuSlots, isRoot, isSystemRoot, isSystemChild, systemChildId, isPrimaryPage),
  );

  // Auto-select: /system → /system/resource-usage when two menus + page fit
  if (shouldRedirect) {
    return <Navigate to={`/system/${defaultSystemSection}`} replace />;
  }

  // ── Root ────────────────────────────────────────────────────────────
  if (isRoot) {
    return menuSlots === 0
      ? <PrimaryNavigationPanel />
      : (
          <MenuAndContent menu={<PrimaryNavigationPanel />}>
            <PrimaryNavigationEmptyState />
          </MenuAndContent>
        );
  }

  // ── System root (narrow / medium only, wide redirected) ─────────────
  if (isSystemRoot) {
    return menuSlots === 0
      ? <SystemNavigationPanel />
      : (
          <MenuAndContent menu={<PrimaryNavigationPanel />}>
            <SystemNavigationPanel />
          </MenuAndContent>
        );
  }

  // ── System child pages (/system/:sectionId) ────────────────────────
  if (isSystemChild) {
    if (menuSlots >= 2) {
      return (
        <TwoMenusAndContent menu1={<PrimaryNavigationPanel />} menu2={<SystemNavigationPanel />}>
          <Outlet />
        </TwoMenusAndContent>
      );
    }
    if (menuSlots === 1) {
      return (
        <MenuAndContent menu={<SystemNavigationPanel />}>
          <Outlet />
        </MenuAndContent>
      );
    }
    return <Outlet />;
  }

  // ── Primary pages (/monitor, /devices, /services) ──────────────────
  if (menuSlots >= 1) {
    return (
      <MenuAndContent menu={<PrimaryNavigationPanel />}>
        <Outlet />
      </MenuAndContent>
    );
  }
  return <Outlet />;
}

// ── AppBar state ───────────────────────────────────────────────────────

function computeAppBarState(
  pathname: string,
  menuSlots: number,
  isRoot: boolean,
  isSystemRoot: boolean,
  isSystemChild: boolean,
  systemChildId: string | null,
  isPrimaryPage: boolean,
) {
  if (isRoot) {
    return { title: 'FLUX_MONITOR', description: '' };
  }

  if (isSystemRoot) {
    return {
      title: 'System',
      description: 'Host status, updates, and logs',
      backTo: menuSlots === 0 ? '/' : undefined,
    };
  }

  if (isSystemChild && systemChildId) {
    const backTo = menuSlots < 2 ? '/system' : undefined;
    const item = getSystemMenuItem(systemChildId);
    if (item) {
      return { title: item.label, description: item.description, backTo };
    }
    return { title: 'System', description: '', backTo: '/system' };
  }

  if (isPrimaryPage) {
    const item = getPrimaryNavigationItem(pathname);
    if (item) {
      return {
        title: item.name,
        description: item.description,
        backTo: menuSlots === 0 ? '/' : undefined,
      };
    }
  }

  return { title: '', description: '' };
}

// ── Layout shells ──────────────────────────────────────────────────────

const stickyTop = 'sticky top-[calc(var(--app-safe-top)+4.25rem)]';

function MenuAndContent({ menu, children }: { menu: ReactNode; children: ReactNode }) {
  return (
    <div className='grid min-h-full items-start gap-6 grid-cols-[17.5rem_minmax(0,1fr)] xl:grid-cols-[18.5rem_minmax(0,1fr)]'>
      <aside className={`self-start ${stickyTop}`} style={{ viewTransitionName: 'nav-menu-1' }}>
        {menu}
      </aside>
      <section className='min-w-0 rounded-3xl border border-border/70 bg-card/45 p-4 shadow-sm backdrop-blur-sm md:p-5 xl:p-6'>
        {children}
      </section>
    </div>
  );
}

function TwoMenusAndContent({ menu1, menu2, children }: { menu1: ReactNode; menu2: ReactNode; children: ReactNode }) {
  return (
    <div className='grid min-h-full items-start gap-6 grid-cols-[17.5rem_17.5rem_minmax(0,1fr)] xl:grid-cols-[18.5rem_18.5rem_minmax(0,1fr)]'>
      <aside className={`self-start ${stickyTop}`} style={{ viewTransitionName: 'nav-menu-1' }}>
        {menu1}
      </aside>
      <aside className={`self-start ${stickyTop}`} style={{ viewTransitionName: 'nav-menu-2' }}>
        {menu2}
      </aside>
      <section className='min-w-0 rounded-3xl border border-border/70 bg-card/45 p-4 shadow-sm backdrop-blur-sm md:p-5 xl:p-6'>
        {children}
      </section>
    </div>
  );
}
