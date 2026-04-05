import { Bell, Cpu, Database, List, Palette, RefreshCcw, Usb, Wifi, type LucideIcon } from 'lucide-react';

export type SystemSection =
  | 'resource-usage'
  | 'software-update'
  | 'connectivity'
  | 'hardware-interfaces'
  | 'database'
  | 'logs';

export const systemSectionRouteSegments: SystemSection[] = [
  'resource-usage',
  'software-update',
  'connectivity',
  'hardware-interfaces',
  'database',
  'logs',
];

export type SystemSectionItem = {
  id: SystemSection;
  label: string;
  description: string;
  icon: LucideIcon;
};

export const systemSectionItems: readonly SystemSectionItem[] = [
  { id: 'resource-usage', label: 'Resource usage', description: 'CPU, memory, and storage', icon: Cpu },
  { id: 'software-update', label: 'Software update', description: 'Check and install releases', icon: RefreshCcw },
  { id: 'connectivity', label: 'Connectivity', description: 'Wi-Fi, Bluetooth, and Ethernet', icon: Wifi },
  { id: 'hardware-interfaces', label: 'Hardware interfaces', description: 'Serial ports and block devices', icon: Usb },
  { id: 'database', label: 'Database', description: 'Storage size, backup, and restore', icon: Database },
  { id: 'logs', label: 'Logs', description: 'Application log output', icon: List },
];

export type SystemShortcutItem = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  path: string;
};

export const systemShortcutItems: readonly SystemShortcutItem[] = [
  { id: 'notifications', label: 'Notifications', description: 'Alerts, channels, and delivery rules', icon: Bell, path: '/system/notifications' },
  { id: 'theme', label: 'Theme', description: 'Choose the active visual theme', icon: Palette, path: '/system/theme' },
];

export type SystemMenuItem =
  | (SystemSectionItem & { path: string; sectionId: SystemSection })
  | SystemShortcutItem;

const logsSystemSection = systemSectionItems.find((item) => item.id === 'logs');
const mainSystemSectionItems = systemSectionItems.filter((item) => item.id !== 'logs');

export const systemMenuItems: readonly SystemMenuItem[] = [
  ...mainSystemSectionItems.map((item) => ({ ...item, path: `/system/${item.id}`, sectionId: item.id })),
  ...systemShortcutItems,
  ...(logsSystemSection ? [{ ...logsSystemSection, path: `/system/${logsSystemSection.id}`, sectionId: logsSystemSection.id }] : []),
];

export const defaultSystemSection: SystemSection = 'resource-usage';

export function getSystemSectionFromRouteSegment(sectionId?: string): SystemSection | null {
  if (!sectionId) return null;
  return systemSectionRouteSegments.includes(sectionId as SystemSection)
    ? (sectionId as SystemSection)
    : null;
}

export function getSystemSectionPath(section: SystemSection) {
  return `/system/${section}`;
}

export function getSystemSectionItem(sectionId: string): SystemSectionItem | null {
  return systemSectionItems.find((item) => item.id === sectionId) ?? null;
}

export function getSystemMenuItem(sectionId: string): { label: string; description: string } | null {
  if (sectionId === 'internet-speed' || sectionId === 'tunnel') {
    return systemSectionItems.find((item) => item.id === 'connectivity') ?? null;
  }

  const section = systemSectionItems.find((item) => item.id === sectionId);
  if (section) return section;
  const shortcut = systemShortcutItems.find((item) => item.id === sectionId);
  if (shortcut) return shortcut;
  return null;
}
