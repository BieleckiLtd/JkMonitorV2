import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignal, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { LoaderCircle, type LucideIcon } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { cn } from '../../lib/utils';
import type {
  BluetoothDeviceSnapshot,
  EthernetInterfaceSnapshot,
  LocalAccessModeSnapshot,
  WifiAccessPointInfo,
  WifiInterfaceSnapshot,
} from './types';

export const noDataLabel = 'N/D';
export const monitorHttpPort = 5074;
export const supportedTemporaryHistoryMinutes = [1, 5, 10, 30];
export const supportedPersistedBucketMinutes = [1, 5, 10, 30];

export function UsagePanel({
  icon: Icon,
  label,
  percent,
  summary,
  secondary,
  details,
  labelIcon: LabelIcon,
  labelIconClassName,
}: {
  icon: LucideIcon;
  label: string;
  percent: number | null;
  summary: string;
  secondary: string;
  details?: string[];
  labelIcon?: LucideIcon;
  labelIconClassName?: string;
}) {
  const footerSegments = [secondary, ...(details ?? [])];

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <Icon className='h-4 w-4 shrink-0 text-muted-foreground' />
            <div className='flex items-center gap-1.5 text-sm font-semibold text-foreground'>
              <span>{label}</span>
              {LabelIcon ? <LabelIcon className={cn('h-3.5 w-3.5 shrink-0', labelIconClassName)} /> : null}
            </div>
          </div>
          <div className='text-sm text-muted-foreground'>{summary}</div>
        </div>
        <div className='shrink-0 text-sm font-semibold text-foreground'>{formatPercent(percent)}</div>
      </div>
      <div className='h-2 overflow-hidden rounded-full bg-muted'>
        <div className='h-full rounded-full bg-primary transition-[width] duration-500 ease-out' style={{ width: `${Math.max(percent ?? 0, 4)}%` }} />
      </div>
      <div className='flex flex-wrap items-center gap-y-1 text-xs text-muted-foreground'>
        {footerSegments.map((segment, index) => (
          <span key={`${index}-${segment}`} className='whitespace-nowrap'>
            {index > 0 ? <span className='px-1 text-muted-foreground/70'>•</span> : null}
            {segment}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='system-detail-tile'>
      <div className='system-label'>{label}</div>
      <div className='mt-2 text-sm font-semibold text-foreground'>{value}</div>
    </div>
  );
}

export function UpdateChannelTile({
  value,
  disabled,
  pending,
  onChange,
}: {
  value: string;
  disabled: boolean;
  pending: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className='system-detail-tile'>
      <div className='flex items-center justify-between gap-2 system-label'>
        <span>Channel</span>
        {pending ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : null}
      </div>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label='Software update channel' className='mt-2 w-full'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='dev'>Dev</SelectItem>
          <SelectItem value='main'>Main</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function SpeedMetricCard({
  label,
  value,
  dialValue,
  caption,
  gaugePercent,
  tone,
  isActive = false,
}: {
  label: string;
  value: string;
  dialValue: string;
  caption?: string;
  gaugePercent: number;
  tone: 'emerald' | 'sky' | 'emerald-soft' | 'amber' | 'rose';
  isActive?: boolean;
}) {
  const toneClassName = tone === 'emerald'
    ? 'text-emerald-400'
    : tone === 'sky'
      ? 'text-sky-400'
      : tone === 'amber'
        ? 'text-amber-400'
        : tone === 'rose'
          ? 'text-rose-400'
          : 'text-emerald-300';
  const toneBarClassName = tone === 'emerald'
    ? 'bg-emerald-400'
    : tone === 'sky'
      ? 'bg-sky-400'
      : tone === 'amber'
        ? 'bg-amber-400'
        : tone === 'rose'
          ? 'bg-rose-400'
          : 'bg-emerald-300';

  return (
    <div className={cn(
      'system-detail-tile px-4 py-4 transition-colors duration-300',
      isActive && 'border-primary/35 bg-primary/5'
    )}>
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0 space-y-1'>
          <div className='system-label'>{label}</div>
          <div className='text-sm font-semibold text-foreground'>{value}</div>
          {caption ? <div className='text-xs leading-5 text-muted-foreground'>{caption}</div> : null}
        </div>
        <div className='shrink-0 text-right'>
          <div className={cn('text-xl font-semibold tracking-tight', toneClassName)}>{dialValue}</div>
          <div className='mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Current</div>
        </div>
      </div>
      <div className='mt-4 h-1.5 overflow-hidden rounded-full bg-background/70'>
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', toneBarClassName)}
          style={{ width: `${Math.max(8, Math.min(100, gaugePercent))}%` }}
        />
      </div>
    </div>
  );
}

export function BluetoothDeviceCard({ device }: { device: BluetoothDeviceSnapshot }) {
  return (
    <div className='flex items-center justify-between gap-3 px-4 py-3'>
      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold text-foreground'>{device.displayName}</div>
        <div className='mt-1 text-[11px] font-mono text-muted-foreground'>{device.address}</div>
      </div>
      <SignalStrengthIndicator
        kind='signal'
        percent={normalizeBluetoothSignalPercent(device.rssi)}
        unavailableLabel='Signal unavailable'
        className='shrink-0'
      />
    </div>
  );
}

export function SignalStrengthIndicator({
  kind,
  percent,
  disabled = false,
  unavailableLabel = 'Unavailable',
  revealOnParentInteraction = false,
  className,
}: {
  kind: 'wifi' | 'signal';
  percent: number | null | undefined;
  disabled?: boolean;
  unavailableLabel?: string;
  revealOnParentInteraction?: boolean;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const normalizedPercent = normalizeSignalPercent(percent);
  const label = normalizedPercent != null ? `${normalizedPercent}%` : unavailableLabel;

  return (
    <span
      role='button'
      tabIndex={0}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setRevealed((current) => !current);
      }}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={() => setRevealed(false)}
      onBlur={() => setRevealed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          setRevealed((current) => !current);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-background/60',
        revealOnParentInteraction ? 'group-hover:bg-background/60 group-focus:bg-background/60 group-active:bg-background/60' : '',
        className
      )}
    >
      <SignalStrengthGlyph kind={kind} percent={normalizedPercent} disabled={disabled} />
      <span className={cn(
        'overflow-hidden whitespace-nowrap transition-all duration-150',
        revealed
          ? 'max-w-16 opacity-100'
          : revealOnParentInteraction
            ? 'max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-focus:max-w-16 group-focus:opacity-100 group-active:max-w-16 group-active:opacity-100'
            : 'max-w-0 opacity-0'
      )}>
        {label}
      </span>
    </span>
  );
}

function SignalStrengthGlyph({
  kind,
  percent,
  disabled,
}: {
  kind: 'wifi' | 'signal';
  percent: number | null;
  disabled: boolean;
}) {
  if (kind === 'wifi') {
    return <WifiSignalGlyph percent={percent} disabled={disabled} />;
  }

  const toneClassName = getSignalToneClassName(percent, disabled);

  return (
    <span className='inline-flex items-center justify-center' aria-hidden='true'>
      <FontAwesomeIcon icon={faSignal as IconDefinition} className={cn('h-3.5 w-3.5 transition-opacity', toneClassName)} />
    </span>
  );
}

function WifiSignalGlyph({ percent, disabled }: { percent: number | null; disabled: boolean }) {
  const state = getWifiSignalState(percent, disabled);
  const toneClassName = getWifiSignalToneClassName(state);

  return (
    <span className={cn('inline-flex items-center justify-center', toneClassName)} aria-hidden='true'>
      <svg viewBox='0 0 640 512' className='h-3.5 w-4 fill-current'>
        {state === 'weak' ? (
          <>
            <path opacity='.4' d='M0 179.8c0 8 3 15.9 8.9 22.2c12.2 12.8 32.5 13.2 45.2 .9C123.2 136.7 216.8 96 320 96s196.8 40.7 265.8 106.9c12.8 12.2 33 11.8 45.2-.9c6-6.2 8.9-14.2 8.9-22.2c0-8.4-3.3-16.8-9.8-23.1C549.7 79.5 440.4 32 320 32S90.3 79.5 9.8 156.7C3.3 163 0 171.4 0 179.8zM126.7 309.2c11.7 13.3 31.9 14.5 45.2 2.8c39.5-34.9 91.3-56 148.2-56s108.6 21.1 148.2 56c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2C459.8 219.2 393 192 320 192s-139.8 27.2-190.5 72c-13.3 11.7-14.5 31.9-2.8 45.2z' />
            <path d='M256 416a64 64 0 1 1 128 0 64 64 0 1 1 -128 0z' />
          </>
        ) : state === 'fair' ? (
          <>
            <path opacity='.4' d='M0 179.8c0 8 3 15.9 8.9 22.2c6.3 6.5 14.7 9.8 23.1 9.8c8 0 15.9-3 22.2-8.9C123.2 136.7 216.8 96 320 96s196.8 40.7 265.8 106.9c6.2 6 14.2 8.9 22.2 8.9c8.4 0 16.8-3.3 23.1-9.8c12.2-12.8 11.8-33-.9-45.2C549.7 79.5 440.4 32 320 32S90.3 79.5 9.8 156.7C3.3 163 0 171.4 0 179.8z' />
            <path d='M171.8 312c39.5-34.9 91.3-56 148.2-56s108.7 21.1 148.2 56c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2C459.8 219.2 393 192 320 192s-139.8 27.2-190.5 72c-13.3 11.7-14.5 31.9-2.8 45.2s31.9 14.5 45.2 2.8zM320 480a64 64 0 1 0 0-128 64 64 0 1 0 0 128z' />
          </>
        ) : state === 'strong' ? (
          <path d='M54.2 202.9C123.2 136.7 216.8 96 320 96s196.8 40.7 265.8 106.9c12.8 12.2 33 11.8 45.2-.9s11.8-33-.9-45.2C549.7 79.5 440.4 32 320 32S90.3 79.5 9.8 156.7C-2.9 169-3.3 189.2 8.9 202s32.5 13.2 45.2 .9zM320 256c56.8 0 108.6 21.1 148.2 56c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2C459.8 219.2 393 192 320 192s-139.8 27.2-190.5 72c-13.3 11.7-14.5 31.9-2.8 45.2s31.9 14.5 45.2 2.8c39.5-34.9 91.3-56 148.2-56zm64 160a64 64 0 1 0 -128 0 64 64 0 1 0 128 0z' />
        ) : state === 'none' ? (
          <>
            <path opacity='.4' d='M8.9 202c12.2 12.8 32.5 13.2 45.2 .9c51.3-49.2 116.2-84.3 188.5-99.1l-1.4-19.3c-1.2-17.4 3.3-33.9 11.9-47.6C159.4 51 75.1 94.1 9.8 156.7C-2.9 169-3.3 189.2 8.9 202zM126.7 309.2c11.7 13.3 31.9 14.5 45.2 2.8c23.6-20.8 51.6-36.7 82.4-46.2l-4.7-65.1C204.4 212 163.4 234.1 129.5 264c-13.3 11.7-14.5 31.9-2.8 45.2zm259.1-43.4c30.8 9.4 58.8 25.4 82.4 46.2c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2c-33.9-29.9-74.9-52-120.1-63.3l-4.6 65.1zM386.8 37c8.6 13.7 13.1 30.1 11.9 47.6l-1.4 19.3c72.3 14.8 137.2 49.9 188.5 99.1c12.8 12.2 33 11.8 45.2-.9c6-6.2 8.9-14.2 8.9-22.2c0-8.4-3.3-16.8-9.8-23.1C564.9 94.1 480.6 51 386.8 37z' />
            <path d='M320 32c-27.2 0-48.7 23.1-46.8 50.2l14.9 208C289.3 307 303.2 320 320 320s30.7-13 31.9-29.7l14.9-208C368.7 55.1 347.2 32 320 32zm0 448a64 64 0 1 0 0-128 64 64 0 1 0 0 128z' />
          </>
        ) : (
          <>
            <path opacity='.4' d='M8.9 202c-12.2-12.8-11.8-33 .9-45.2C20 147 30.7 137.7 41.7 128.9l51.9 40.9C79.7 179.9 66.6 191 54.2 202.9c-12.8 12.2-33 11.8-45.2-.9zM126.7 309.2c-11.7-13.3-10.4-33.5 2.8-45.2c13.4-11.9 28-22.5 43.5-31.7L228 275.7c-20.6 9.3-39.5 21.6-56.2 36.3c-13.3 11.7-33.5 10.4-45.2-2.8zm1.4-234.1C186.3 47.5 251.3 32 320 32c120.4 0 229.7 47.5 310.2 124.7c12.8 12.2 13.2 32.5 .9 45.2s-32.5 13.2-45.2 .9C516.8 136.7 423.2 96 320 96c-47.3 0-92.6 8.5-134.4 24.2c-19.2-15-38.3-30.1-57.5-45.1zM256 416c0-35.3 28.7-64 64-64c1.7 0 3.5 .1 5.2 .2L380.8 396c2.1 6.3 3.2 13 3.2 20c0 35.3-28.7 64-64 64s-64-28.7-64-64zm24.7-221.3c12.9-1.8 26-2.7 39.3-2.7c73 0 139.8 27.2 190.5 72c13.2 11.7 14.5 31.9 2.8 45.2s-31.9 14.5-45.2 2.8c-28.9-25.5-64.4-43.7-103.6-51.6c-28-21.9-55.9-43.8-83.9-65.8z' />
            <path d='M5.1 9.2C13.3-1.2 28.4-3.1 38.8 5.1l592 464c10.4 8.2 12.3 23.3 4.1 33.7s-23.3 12.3-33.7 4.1L9.2 42.9C-1.2 34.7-3.1 19.6 5.1 9.2z' />
          </>
        )}
      </svg>
    </span>
  );
}

export function mergeBluetoothDevices(primary: BluetoothDeviceSnapshot[], secondary: BluetoothDeviceSnapshot[]) {
  const devices = new Map<string, BluetoothDeviceSnapshot>();

  for (const device of [...primary, ...secondary]) {
    const existing = devices.get(device.address);
    if (!existing) {
      devices.set(device.address, device);
      continue;
    }

    devices.set(device.address, {
      ...existing,
      ...device,
      displayName: device.displayName || existing.displayName,
      address: device.address || existing.address,
      rssi: device.rssi ?? existing.rssi,
      advertisedServiceUuids: device.advertisedServiceUuids.length > 0 ? device.advertisedServiceUuids : existing.advertisedServiceUuids,
      isConnected: device.isConnected || existing.isConnected,
      isPaired: device.isPaired || existing.isPaired,
    });
  }

  return Array.from(devices.values()).sort((left, right) => {
    const leftScore = (left.isConnected ? 4 : 0) + (left.isPaired ? 2 : 0) + (left.rssi ?? -200);
    const rightScore = (right.isConnected ? 4 : 0) + (right.isPaired ? 2 : 0) + (right.rssi ?? -200);

    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

export function normalizeSignalPercent(percent: number | null | undefined) {
  if (percent == null || !Number.isFinite(percent)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

export function normalizeBluetoothSignalPercent(rssi: number | null | undefined) {
  if (rssi == null || !Number.isFinite(rssi)) {
    return null;
  }

  return normalizeSignalPercent(((rssi + 100) / 50) * 100);
}

export function isWifiNetworkSecured(accessPoint: WifiAccessPointInfo) {
  return Boolean(accessPoint.security && accessPoint.security.trim() && accessPoint.security.trim() !== '--');
}

export function getWifiConnectRequestErrorMessage(error: unknown) {
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
    return 'The Wi-Fi change interrupted the request. If the device switched networks, reconnect to its new address and check Wi-Fi status again.';
  }

  return error instanceof Error ? error.message : 'Unable to connect to the selected Wi-Fi network.';
}

export function formatLocalAccessHostName(hostName: string | null | undefined) {
  const trimmed = hostName?.trim();
  if (!trimmed) {
    return 'Waiting';
  }

  return trimmed.includes('.') ? trimmed : `${trimmed}.local`;
}

export function formatLocalAccessBluetoothDeviceName(deviceName: string | null | undefined) {
  const trimmed = deviceName?.trim();
  if (!trimmed) {
    return 'Waiting';
  }

  return trimmed;
}

export function formatLocalAccessName(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return 'Waiting';
  }

  return trimmed;
}

export function buildFallbackLocalAccessStatus(
  localAccessMode: LocalAccessModeSnapshot | null | undefined,
  primaryAddress: string | null,
) {
  if (!localAccessMode?.enabled) {
    return 'Disabled';
  }

  if (localAccessMode.active) {
    return primaryAddress ?? 'Active';
  }

  return 'Starts when needed';
}

export function buildConnectivityPanelLinks(
  hostName: string | null | undefined,
  wifiInterfaces: WifiInterfaceSnapshot[],
  ethernetInterfaces: EthernetInterfaceSnapshot[],
) {
  const links = new Set<string>();
  const formattedHostName = formatLocalAccessHostName(hostName);

  if (formattedHostName !== 'Waiting') {
    links.add(`http://${formattedHostName}:${monitorHttpPort}`);
  }

  for (const address of [
    ...wifiInterfaces.flatMap((wifiInterface) => wifiInterface.addresses),
    ...ethernetInterfaces.flatMap((ethernetInterface) => ethernetInterface.addresses),
  ]) {
    const normalizedAddress = normalizeConnectivityLinkAddress(address);
    if (!normalizedAddress) {
      continue;
    }

    links.add(`http://${normalizedAddress}:${monitorHttpPort}`);
  }

  return Array.from(links);
}

export function normalizeConnectivityLinkAddress(address: string | null | undefined) {
  const trimmed = address?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === '::1' || trimmed.startsWith('127.')) {
    return null;
  }

  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) ? trimmed : null;
}

export function requiresSaeForLocalAccessPassword(password: string) {
  if (password.length === 0) {
    return false;
  }

  if (password.length >= 8 && password.length <= 63) {
    return false;
  }

  if (password.length === 64 && /^[\da-f]+$/i.test(password)) {
    return false;
  }

  return true;
}

export function getWifiSignalState(percent: number | null, disabled: boolean) {
  if (disabled) {
    return 'disabled' as const;
  }

  if (percent == null || percent <= 0) {
    return 'none' as const;
  }

  if (percent < 34) {
    return 'weak' as const;
  }

  if (percent < 67) {
    return 'fair' as const;
  }

  return 'strong' as const;
}

export function getWifiSignalToneClassName(state: 'disabled' | 'none' | 'weak' | 'fair' | 'strong') {
  if (state === 'disabled') {
    return 'text-muted-foreground/45';
  }

  if (state === 'none') {
    return 'text-muted-foreground/55';
  }

  if (state === 'weak') {
    return 'text-muted-foreground/75';
  }

  if (state === 'fair') {
    return 'text-foreground/85';
  }

  return 'text-foreground';
}

export function getSignalToneClassName(percent: number | null, disabled: boolean) {
  if (disabled || percent == null) {
    return 'text-muted-foreground/35';
  }

  if (percent >= 75) {
    return 'text-foreground';
  }

  if (percent >= 50) {
    return 'text-foreground/80';
  }

  if (percent >= 25) {
    return 'text-muted-foreground/75';
  }

  return 'text-muted-foreground/45';
}

export function isWifiInterfaceInUse(wifiInterface: WifiInterfaceSnapshot | null | undefined) {
  return Boolean(wifiInterface?.connectedSsid) || (wifiInterface?.addresses.length ?? 0) > 0;
}

export function isEthernetInterfaceEnabled(ethernetInterface: EthernetInterfaceSnapshot | null | undefined) {
  if (!ethernetInterface) {
    return false;
  }

  if (ethernetInterface.enabled != null) {
    return ethernetInterface.enabled;
  }

  return isEthernetInterfaceActive(ethernetInterface);
}

export function isEthernetInterfaceActive(ethernetInterface: EthernetInterfaceSnapshot | null | undefined) {
  if (!ethernetInterface) {
    return false;
  }

  return (ethernetInterface.connectionState ?? ethernetInterface.status ?? '').toLowerCase().includes('connected')
    || stringEqualsIgnoreCase(ethernetInterface.status, 'up')
    || ethernetInterface.addresses.length > 0;
}

export function buildEthernetStatusMessage(ethernetInterface: EthernetInterfaceSnapshot | null | undefined) {
  if (!ethernetInterface) {
    return 'No Ethernet interface detected.';
  }

  if (!isEthernetInterfaceEnabled(ethernetInterface)) {
    return `${ethernetInterface.name} interface is off.`;
  }

  if (ethernetInterface.carrierDetected === false) {
    return `${ethernetInterface.name} interface is active but not operational. Check cable.`;
  }

  if (isEthernetInterfaceActive(ethernetInterface)) {
    return `${ethernetInterface.name} interface is active on the wired network.`;
  }

  return `${ethernetInterface.name} interface is on and waiting for a wired link.`;
}

export function formatEthernetStateLabel(ethernetInterface: EthernetInterfaceSnapshot | null | undefined) {
  if (!ethernetInterface) {
    return 'Unknown';
  }

  if (ethernetInterface.carrierDetected === false) {
    return 'Cable not detected';
  }

  return ethernetInterface.connectionState ?? ethernetInterface.status ?? 'Unknown';
}

export function stringEqualsIgnoreCase(left: string | null | undefined, right: string) {
  return typeof left === 'string' && left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

export function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let currentValue = value;

  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }

  const digits = currentValue >= 100 || unitIndex === 0 ? 0 : 1;
  return `${currentValue.toFixed(digits)} ${units[unitIndex]}`;
}

export function formatSpeedMbps(bitsPerSecond: number | null | undefined) {
  const megabitsPerSecond = getMegabitsPerSecond(bitsPerSecond);
  if (megabitsPerSecond == null) {
    return noDataLabel;
  }

  if (megabitsPerSecond >= 100) {
    return `${megabitsPerSecond.toFixed(0)} Mbps`;
  }

  if (megabitsPerSecond >= 10) {
    return `${megabitsPerSecond.toFixed(1)} Mbps`;
  }

  return `${megabitsPerSecond.toFixed(2)} Mbps`;
}

export function formatSpeedDialValue(bitsPerSecond: number | null | undefined) {
  const megabitsPerSecond = getMegabitsPerSecond(bitsPerSecond);
  if (megabitsPerSecond == null) {
    return '—';
  }

  if (megabitsPerSecond >= 100) {
    return megabitsPerSecond.toFixed(0);
  }

  if (megabitsPerSecond >= 10) {
    return megabitsPerSecond.toFixed(1);
  }

  return megabitsPerSecond.toFixed(2);
}

export function formatLatency(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds)) {
    return noDataLabel;
  }

  return `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)} ms`;
}

export function formatLatencyDialValue(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds)) {
    return '—';
  }

  return milliseconds.toFixed(milliseconds >= 100 ? 0 : 1);
}

export function formatTransferSize(bytes: number | null | undefined, suffix: string) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return `Traffic ${suffix} unavailable`;
  }

  return `${formatBytes(bytes)} ${suffix}`;
}

export function formatDistance(kilometers: number | null | undefined) {
  if (kilometers == null || !Number.isFinite(kilometers)) {
    return noDataLabel;
  }

  return `${kilometers.toFixed(kilometers >= 100 ? 0 : 1)} km`;
}

export function formatInternetSpeedServer(sponsor: string | null | undefined, name: string | null | undefined, country: string | null | undefined) {
  const segments = [sponsor, name, country].filter((value): value is string => Boolean(value?.trim()));
  return segments.length > 0 ? segments.join(' • ') : noDataLabel;
}

export function formatUsage(usedBytes: number | null, totalBytes: number | null) {
  if (usedBytes == null || totalBytes == null) {
    return noDataLabel;
  }

  return `${formatBytes(usedBytes)} of ${formatBytes(totalBytes)}`;
}

export function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatWholeNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return Math.round(value).toLocaleString();
}

export function formatFrequency(megahertz: number | null | undefined) {
  if (megahertz == null || !Number.isFinite(megahertz)) {
    return noDataLabel;
  }

  if (megahertz >= 1000) {
    return `${(megahertz / 1000).toFixed(2)} GHz`;
  }

  return `${Math.round(megahertz).toLocaleString()} MHz`;
}

export function formatDecimalValue(value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)} ${unit}`;
}

export function getMegabitsPerSecond(bitsPerSecond: number | null | undefined) {
  if (bitsPerSecond == null || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    return null;
  }

  return bitsPerSecond / 1_000_000;
}

export function getBandwidthGaugePercent(megabitsPerSecond: number | null) {
  if (megabitsPerSecond == null) {
    return 0;
  }

  const percent = Math.log10(megabitsPerSecond + 1) / Math.log10(1000 + 1);
  return Math.max(8, Math.min(100, Math.round(percent * 100)));
}

export function getLatencyGaugePercent(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds <= 0) {
    return 0;
  }

  const percent = 100 - ((Math.min(milliseconds, 250) / 250) * 100);
  return Math.max(8, Math.min(100, Math.round(percent)));
}

export function getLatencyTone(milliseconds: number | null | undefined): 'emerald-soft' | 'amber' | 'rose' {
  if (milliseconds == null || !Number.isFinite(milliseconds)) {
    return 'rose';
  }

  if (milliseconds <= 25) {
    return 'emerald-soft';
  }

  if (milliseconds <= 80) {
    return 'amber';
  }

  return 'rose';
}

export function clampPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatProgressDialValue(percent: number | null | undefined) {
  return `${clampPercent(percent)}%`;
}

export function getInternetSpeedActiveMetric(stage: string | null | undefined): 'download' | 'upload' | 'ping' {
  if (stage === 'download' || stage === 'upload') {
    return stage;
  }

  return 'ping';
}

export function getInternetSpeedStageLabel(stage: string | null | undefined) {
  return stage === 'download'
    ? 'Download'
    : stage === 'upload'
      ? 'Upload'
      : 'Ping';
}

export function getInternetSpeedActiveCaption(stage: 'download' | 'upload' | 'ping', statusMessage: string | null | undefined) {
  if (!statusMessage) {
    return undefined;
  }

  const normalizedMessage = statusMessage.trim().toLowerCase();
  if ((stage === 'download' && normalizedMessage === 'measuring download speed.')
    || (stage === 'upload' && normalizedMessage === 'measuring upload speed.')
    || (stage === 'ping' && normalizedMessage === 'measuring ping speed.')) {
    return undefined;
  }

  return statusMessage;
}

export function formatInternetSpeedConnectionMode(connectionMode: string | null | undefined) {
  if (!connectionMode) {
    return noDataLabel;
  }

  return stringEqualsIgnoreCase(connectionMode, 'single')
    ? 'Single'
    : stringEqualsIgnoreCase(connectionMode, 'multi')
      ? 'Multi'
      : connectionMode;
}

export function formatRpm(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${Math.round(value).toLocaleString()} RPM`;
}

export function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return noDataLabel;
  }

  return new Date(value).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatCommit(value: string | null | undefined) {
  if (!value) {
    return noDataLabel;
  }

  return value.slice(0, 12);
}

export function getReleaseChannel(releaseTag: string | null | undefined) {
  return releaseTag === 'dev-latest' ? 'dev' : 'main';
}

export function formatReleaseChannel(channel: string | null | undefined) {
  if (!channel) {
    return noDataLabel;
  }

  return channel === 'dev' ? 'Dev' : channel === 'main' ? 'Main' : channel;
}

export function formatWorkflowRun(runNumber: string | null | undefined, runAttempt: string | null | undefined) {
  if (!runNumber) {
    return noDataLabel;
  }

  if (!runAttempt) {
    return `#${runNumber}`;
  }

  return `#${runNumber} · attempt ${runAttempt}`;
}

export function formatDuration(startedAt: string, reportedAt: string) {
  if (!startedAt || !reportedAt) {
    return noDataLabel;
  }

  const elapsedMilliseconds = Math.max(new Date(reportedAt).getTime() - new Date(startedAt).getTime(), 0);
  const totalSeconds = Math.floor(elapsedMilliseconds / 1000);

  return formatElapsedDuration(totalSeconds);
}

export function formatElapsedDuration(totalSeconds: number | null | undefined) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) {
    return noDataLabel;
  }

  const wholeSeconds = Math.max(Math.floor(totalSeconds), 0);
  const days = Math.floor(wholeSeconds / 86400);
  const hours = Math.floor((wholeSeconds % 86400) / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return '<1m';
}

export function getUsagePercent(usedBytes: number | null, totalBytes: number | null) {
  if (usedBytes == null || totalBytes == null || totalBytes <= 0) {
    return null;
  }

  return Math.min(Math.max((usedBytes / totalBytes) * 100, 0), 100);
}

export function getDerivedUsedBytes(totalBytes: number | null | undefined, availableBytes: number | null | undefined) {
  if (totalBytes == null || availableBytes == null) {
    return null;
  }

  return Math.max(totalBytes - availableBytes, 0);
}
