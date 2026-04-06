import { Cable } from 'lucide-react';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import {
  buildEthernetStatusMessage,
  formatEthernetStateLabel,
  isEthernetInterfaceEnabled,
} from './shared';
import type {
  EthernetInterfaceSnapshot,
  InlineFeedback,
} from './types';

type EthernetMenuItemProps = {
  ethernetSummary: string;
  ethernetSectionOpen: boolean;
  ethernetPowerLoading: boolean;
  ethernetFeedback: InlineFeedback | null;
  ethernetInterfaces: EthernetInterfaceSnapshot[];
  activeEthernetInterface: EthernetInterfaceSnapshot | null;
  onToggleExpanded: () => void;
  onTogglePower: () => void | Promise<void>;
};

export function EthernetMenuItem({
  ethernetSummary,
  ethernetSectionOpen,
  ethernetPowerLoading,
  ethernetFeedback,
  ethernetInterfaces,
  activeEthernetInterface,
  onToggleExpanded,
  onTogglePower,
}: EthernetMenuItemProps) {
  const ethernetToggleChecked = isEthernetInterfaceEnabled(activeEthernetInterface);
  const ethernetPrimaryStatus = buildEthernetStatusMessage(activeEthernetInterface);

  return (
    <ConnectivityMenuItem
      title='Ethernet'
      summary={ethernetSummary}
      icon={Cable}
      expanded={ethernetSectionOpen}
      onToggleExpanded={onToggleExpanded}
      expandButtonLabel={{
        collapsed: 'Expand Ethernet details',
        expanded: 'Collapse Ethernet details',
      }}
      toggleControl={(
        <Switch
          checked={ethernetToggleChecked}
          disabled={ethernetPowerLoading || !activeEthernetInterface}
          onCheckedChange={() => void onTogglePower()}
          aria-label='Toggle Ethernet interface'
        />
      )}
    >
      <div className='system-muted-banner'>
        {ethernetPrimaryStatus}
      </div>

      {ethernetFeedback ? (
        <div className={cn(
          'system-feedback',
          ethernetFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
        )}>
          {ethernetFeedback.message}
        </div>
      ) : null}

      {ethernetInterfaces.length > 0 ? (
        <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
          {ethernetInterfaces.map((ethernetInterface, index) => (
            <div
              key={ethernetInterface.name}
              className={cn(
                'flex flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:justify-between',
                index > 0 ? 'border-t border-border/60' : ''
              )}
            >
              <div className='min-w-0 flex-1'>
                <div className='font-mono text-sm font-semibold text-foreground'>{ethernetInterface.name}</div>
                <div className='mt-1 text-xs text-muted-foreground'>
                  {ethernetInterface.connectionName
                    ? `${ethernetInterface.connectionName}${ethernetInterface.speedMbps ? ` • ${ethernetInterface.speedMbps} Mbps` : ''}`
                    : ethernetInterface.description || 'Wired interface'}
                </div>
                <div className='mt-2 text-xs leading-5 text-muted-foreground'>
                  {buildEthernetStatusMessage(ethernetInterface)}
                </div>
                {ethernetInterface.addresses.length > 0 ? (
                  <div className='mt-1 break-all font-mono text-[11px] text-muted-foreground'>
                    {ethernetInterface.addresses.join(' • ')}
                  </div>
                ) : null}
              </div>
              <div className='flex w-full flex-col items-start gap-2 sm:w-auto sm:shrink-0 sm:items-end'>
                <div className='text-xs text-muted-foreground sm:text-right'>
                  {formatEthernetStateLabel(ethernetInterface)}
                </div>
                <div className='text-[11px] uppercase tracking-[0.16em] text-muted-foreground/80'>
                  {isEthernetInterfaceEnabled(ethernetInterface) ? 'On' : 'Off'}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className='system-empty-state'>
          No Ethernet interfaces detected.
        </div>
      )}
    </ConnectivityMenuItem>
  );
}
