import { ChevronRight, LoaderCircle, Lock, RefreshCcw, Wifi } from 'lucide-react';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import { SignalStrengthIndicator, isWifiNetworkSecured } from './shared';
import type {
  InlineFeedback,
  SystemConnectivitySnapshot,
  WifiAccessPointInfo,
  WifiInterfaceSnapshot,
} from './types';

type WifiMenuItemProps = {
  connectivity: SystemConnectivitySnapshot | null;
  wifiPowered: boolean | null;
  wifiSummary: string;
  wifiSectionOpen: boolean;
  wifiPowerLoading: boolean;
  wifiFeedback: InlineFeedback | null;
  wifiInterfaces: WifiInterfaceSnapshot[];
  selectedWifiInterface: WifiInterfaceSnapshot | null;
  selectedWifiAccessPoints: WifiAccessPointInfo[];
  hasInternetAccess: boolean | null;
  wifiScanLoading: string | null;
  onToggleExpanded: () => void;
  onTogglePower: () => void;
  onSelectInterface: (wifiInterface: WifiInterfaceSnapshot) => void | Promise<void>;
  onSelectAccessPoint: (accessPoint: WifiAccessPointInfo) => void | Promise<void>;
  onOpenOtherDialog: () => void;
  onScan: (interfaceName: string) => void | Promise<void>;
};

export function WifiMenuItem({
  connectivity,
  wifiPowered,
  wifiSummary,
  wifiSectionOpen,
  wifiPowerLoading,
  wifiFeedback,
  wifiInterfaces,
  selectedWifiInterface,
  selectedWifiAccessPoints,
  hasInternetAccess,
  wifiScanLoading,
  onToggleExpanded,
  onTogglePower,
  onSelectInterface,
  onSelectAccessPoint,
  onOpenOtherDialog,
  onScan,
}: WifiMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='Wi-Fi'
      summary={wifiSummary}
      icon={Wifi}
      expanded={wifiSectionOpen}
      onToggleExpanded={onToggleExpanded}
      expandButtonLabel={{
        collapsed: 'Expand Wi-Fi details',
        expanded: 'Collapse Wi-Fi details',
      }}
      toggleControl={(
        <Switch
          checked={Boolean(connectivity?.network.supported) && wifiPowered !== false}
          disabled={wifiPowerLoading || !(connectivity?.network.supported ?? false)}
          onCheckedChange={onTogglePower}
          aria-label='Toggle Wi-Fi power'
        />
      )}
    >
      {wifiFeedback ? (
        <div className={cn(
          'system-feedback',
          wifiFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
        )}>
          {wifiFeedback.message}
        </div>
      ) : null}

      {!connectivity?.network.supported ? (
        <div className='system-muted-banner'>
          {connectivity?.network.statusMessage ?? 'Wi-Fi controls are unavailable on this host.'}
        </div>
      ) : wifiPowered === false ? (
        <div className='system-empty-state'>
          Turn Wi-Fi on to scan nearby networks and switch access points.
        </div>
      ) : wifiInterfaces.length === 0 || !selectedWifiInterface ? (
        <div className='system-empty-state'>
          No Wi-Fi interfaces detected.
        </div>
      ) : (
        <>
          {wifiInterfaces.length > 1 ? (
            <div className='flex flex-wrap gap-2'>
              {wifiInterfaces.map((wifiInterface) => (
                <button
                  key={wifiInterface.name}
                  type='button'
                  disabled={wifiScanLoading === wifiInterface.name}
                  onClick={() => void onSelectInterface(wifiInterface)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    selectedWifiInterface.name === wifiInterface.name
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border bg-background/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  )}
                >
                  {wifiInterface.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className='system-panel-surface-muted px-4 py-3'>
            <div className='min-w-0'>
              <div className='font-mono text-sm font-semibold text-foreground'>{selectedWifiInterface.name}</div>
              {selectedWifiInterface.connectedSsid ? (
                <div className='mt-1 flex items-center gap-2 text-xs text-muted-foreground'>
                  <span>{selectedWifiInterface.connectedSsid}</span>
                  <SignalStrengthIndicator
                    kind='wifi'
                    percent={selectedWifiInterface.signalPercent}
                  />
                </div>
              ) : (
                <div className='mt-1 text-xs text-muted-foreground'>Not connected</div>
              )}
              {selectedWifiInterface.addresses.length > 0 ? (
                <div className='mt-1 break-all font-mono text-[11px] text-muted-foreground'>
                  {selectedWifiInterface.addresses.join(' • ')}
                </div>
              ) : null}
            </div>
          </div>

          <div className='space-y-2'>
            <div className='flex items-center justify-between gap-3'>
              <div className='system-label'>Nearby networks</div>
              {hasInternetAccess === false ? (
                <div className='text-[11px] text-amber-300'>No internet. Scanning nearby networks.</div>
              ) : null}
            </div>

            {selectedWifiAccessPoints.length > 0 ? (
              <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
                {selectedWifiAccessPoints.map((accessPoint, index) => (
                  <button
                    key={`${accessPoint.bssid ?? accessPoint.ssid}-${accessPoint.interfaceName}`}
                    type='button'
                    onClick={() => void onSelectAccessPoint(accessPoint)}
                    className={cn(
                      'group flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-background/70',
                      index > 0 ? 'border-t border-border/60' : '',
                      accessPoint.isActive ? 'bg-primary/8' : ''
                    )}
                  >
                    <div className='flex min-w-0 items-center gap-2'>
                      {isWifiNetworkSecured(accessPoint) ? <Lock className='h-3.5 w-3.5 shrink-0 text-muted-foreground' /> : null}
                      <div className='truncate text-sm font-medium text-foreground'>{accessPoint.ssid}</div>
                    </div>
                    <SignalStrengthIndicator
                      kind='wifi'
                      percent={accessPoint.signalPercent}
                      revealOnParentInteraction
                      className='shrink-0'
                    />
                  </button>
                ))}
              </div>
            ) : wifiScanLoading === selectedWifiInterface.name ? (
              <div className='system-empty-state'>
                Scanning nearby networks...
              </div>
            ) : wifiScanLoading !== selectedWifiInterface.name ? (
              <div className='system-empty-state'>
                No scan results yet. Click scan to refresh nearby networks.
              </div>
            ) : null}

            <button
              type='button'
              onClick={onOpenOtherDialog}
              className='flex w-full items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/20 px-4 py-3 text-left transition-colors hover:bg-background/70'
            >
              <div className='text-sm font-medium text-foreground'>Other</div>
              <ChevronRight className='h-4 w-4 text-muted-foreground' />
            </button>
          </div>

          <button
            type='button'
            disabled={wifiScanLoading === selectedWifiInterface.name}
            onClick={() => void onScan(selectedWifiInterface.name)}
            className='system-button-secondary w-full'
          >
            {wifiScanLoading === selectedWifiInterface.name ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
            Scan networks
          </button>
        </>
      )}
    </ConnectivityMenuItem>
  );
}
