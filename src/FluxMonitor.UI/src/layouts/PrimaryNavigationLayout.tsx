import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { type ReactNode } from 'react';
import { AutomationsNavigationPanel } from '../components/AutomationsNavigationPanel';
import { DevicesNavigationPanel } from '../components/DevicesNavigationPanel';
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
  const isDevicesRoot = pathname === '/devices';
  const deviceChildMatch = pathname.match(/^\/devices\/([^/]+)/);
  const deviceChildId = deviceChildMatch?.[1] ?? null;
  const isDevicesChild = deviceChildId !== null;
  const isDevicesRoute = isDevicesRoot || isDevicesChild;
  const isAutomationsRoot = pathname === '/automations';
  const automationChildMatch = pathname.match(/^\/automations\/([^/]+)/);
  const automationChildId = automationChildMatch?.[1] ?? null;
  const isAutomationsChild = automationChildId !== null;
  const isAutomationsRoute = isAutomationsRoot || isAutomationsChild;
  const isPrimaryPage = !isRoot && !isSystemRoute && !isDevicesRoute && !isAutomationsRoute;

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

  // ── Devices root (/devices) ────────────────────────────────────────
  if (isDevicesRoot) {
    return menuSlots === 0
      ? <DevicesNavigationPanel />
      : (
          <MenuAndContent menu={<PrimaryNavigationPanel />}>
            <DevicesNavigationPanel />
          </MenuAndContent>
        );
  }

  // ── Device pages (/devices/add, /devices/:deviceId) ────────────────
  if (isDevicesChild) {
    if (menuSlots >= 2) {
      return (
        <TwoMenusAndContent menu1={<PrimaryNavigationPanel />} menu2={<DevicesNavigationPanel />}>
          <Outlet />
        </TwoMenusAndContent>
      );
    }
    if (menuSlots === 1) {
      return (
        <MenuAndContent menu={<DevicesNavigationPanel />}>
          <Outlet />
        </MenuAndContent>
      );
    }
    return <Outlet />;
  }

  // ── Automations root (/automations) ───────────────────────────────
  if (isAutomationsRoot) {
    return menuSlots === 0
      ? <AutomationsNavigationPanel />
      : (
          <MenuAndContent menu={<PrimaryNavigationPanel />}>
            <AutomationsNavigationPanel />
          </MenuAndContent>
        );
  }

  // ── Automation pages (/automations/new, /automations/:ruleId) ─────
  if (isAutomationsChild) {
    if (menuSlots >= 2) {
      return (
        <TwoMenusAndContent menu1={<PrimaryNavigationPanel />} menu2={<AutomationsNavigationPanel />}>
          <Outlet />
        </TwoMenusAndContent>
      );
    }
    if (menuSlots === 1) {
      return (
        <MenuAndContent menu={<AutomationsNavigationPanel />}>
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
  const isDevicesRoot = pathname === '/devices';
  const deviceChildMatch = pathname.match(/^\/devices\/([^/]+)/);
  const deviceChildId = deviceChildMatch?.[1] ?? null;
  const isDevicesChild = deviceChildId !== null;
  const isAutomationsRoot = pathname === '/automations';
  const automationChildMatch = pathname.match(/^\/automations\/([^/]+)/);
  const automationChildId = automationChildMatch?.[1] ?? null;
  const isAutomationsChild = automationChildId !== null;

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

  if (isDevicesRoot) {
    return {
      title: 'Devices',
      description: 'Select a device readout or add a new one',
      backTo: menuSlots === 0 ? '/' : undefined,
    };
  }

  if (isDevicesChild && deviceChildId) {
    return {
      title: deviceChildId === 'add' ? 'Add a new device' : 'Devices',
      description: deviceChildId === 'add'
        ? 'Add a device from the library or upload a definition'
        : 'Live telemetry and quick readout controls',
      backTo: menuSlots < 2 ? '/devices' : undefined,
    };
  }

  if (isAutomationsRoot) {
    return {
      title: 'Automations',
      description: '',
      backTo: menuSlots === 0 ? '/' : undefined,
    };
  }

  if (isAutomationsChild) {
    return {
      title: automationChildId === 'new' ? 'Create automation' : 'Automations',
      description: '',
      backTo: menuSlots < 2 ? '/automations' : undefined,
    };
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
