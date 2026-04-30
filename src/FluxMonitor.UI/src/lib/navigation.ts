import { Cable, Gauge, Monitor, Sparkles, type LucideIcon } from 'lucide-react';

export const oneMenuQuery = '(min-width: 768px)';
export const twoMenuQuery = '(min-width: 1100px)';

export type PrimaryNavigationItem = {
  name: string;
  description: string;
  path: string;
  icon: LucideIcon;
};

export const primaryNavigationItems: readonly PrimaryNavigationItem[] = [
  { name: 'System', description: 'Host status, updates, and logs', path: '/system', icon: Monitor },
  { name: 'Monitor', description: 'Live telemetry and power flow', path: '/monitor', icon: Gauge },
  { name: 'Devices', description: 'Ports, transports, and device setup', path: '/devices', icon: Cable },
  { name: 'Services', description: 'Installed packages and runtime insight', path: '/services', icon: Sparkles },
];

export function getPrimaryNavigationItem(pathname: string) {
  return primaryNavigationItems.find((item) => isPrimaryNavigationItemActive(item.path, pathname)) ?? null;
}

export function isPrimaryNavigationItemActive(itemPath: string, pathname: string) {
  return pathname === itemPath || pathname.startsWith(`${itemPath}/`);
}
