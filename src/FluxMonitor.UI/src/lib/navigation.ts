import { Bell, Cable, Gauge, Monitor, Settings, Sparkles, type LucideIcon } from 'lucide-react';

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
  { name: 'Notifications', description: 'Alerts, channels, and delivery rules', path: '/notifications', icon: Bell },
  { name: 'Settings', description: 'Theme and application preferences', path: '/settings', icon: Settings },
];

export function getPrimaryNavigationItem(pathname: string) {
  return primaryNavigationItems.find((item) => item.path === pathname) ?? null;
}
