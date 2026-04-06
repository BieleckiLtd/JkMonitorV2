import { Bluetooth, LoaderCircle, RefreshCcw } from 'lucide-react';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import { BluetoothDeviceCard } from './shared';
import type {
  BluetoothDeviceSnapshot,
  InlineFeedback,
  SystemConnectivitySnapshot,
} from './types';

type BluetoothMenuItemProps = {
  connectivity: SystemConnectivitySnapshot | null;
  bluetoothSummary: string;
  bluetoothSectionOpen: boolean;
  bluetoothPowerLoading: boolean;
  bluetoothScanLoading: boolean;
  bluetoothFeedback: InlineFeedback | null;
  visibleBluetoothDevices: BluetoothDeviceSnapshot[];
  onToggleExpanded: () => void;
  onTogglePower: () => void | Promise<void>;
  onScan: () => void | Promise<void>;
};

export function BluetoothMenuItem({
  connectivity,
  bluetoothSummary,
  bluetoothSectionOpen,
  bluetoothPowerLoading,
  bluetoothScanLoading,
  bluetoothFeedback,
  visibleBluetoothDevices,
  onToggleExpanded,
  onTogglePower,
  onScan,
}: BluetoothMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='Bluetooth'
      summary={bluetoothSummary}
      icon={Bluetooth}
      expanded={bluetoothSectionOpen}
      onToggleExpanded={onToggleExpanded}
      expandButtonLabel={{
        collapsed: 'Expand Bluetooth details',
        expanded: 'Collapse Bluetooth details',
      }}
      toggleControl={(
        <Switch
          checked={Boolean(connectivity?.bluetooth.supported) && Boolean(connectivity?.bluetooth.powered)}
          disabled={bluetoothPowerLoading || !(connectivity?.bluetooth.supported ?? false)}
          onCheckedChange={() => void onTogglePower()}
          aria-label='Toggle Bluetooth power'
        />
      )}
    >
      {connectivity?.bluetooth.statusMessage ? (
        <div className='system-muted-banner'>
          {connectivity.bluetooth.statusMessage}
        </div>
      ) : null}

      {bluetoothFeedback ? (
        <div className={cn(
          'system-feedback',
          bluetoothFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
        )}>
          {bluetoothFeedback.message}
        </div>
      ) : null}

      {!connectivity?.bluetooth.supported ? (
        <div className='system-empty-state'>
          Bluetooth controls are unavailable on this host.
        </div>
      ) : !connectivity.bluetooth.powered ? (
        <div className='system-empty-state'>
          Turn Bluetooth on to scan nearby devices.
        </div>
      ) : (
        <>
          {visibleBluetoothDevices.length > 0 ? (
            <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
              {visibleBluetoothDevices.map((device, index) => (
                <div key={device.address} className={index > 0 ? 'border-t border-border/60' : undefined}>
                  <BluetoothDeviceCard device={device} />
                </div>
              ))}
            </div>
          ) : (
            <div className='system-empty-state'>
              No Bluetooth devices found.
            </div>
          )}

          <button
            type='button'
            disabled={bluetoothScanLoading}
            onClick={() => void onScan()}
            className='system-button-secondary w-full'
          >
            {bluetoothScanLoading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
            Scan networks
          </button>
        </>
      )}
    </ConnectivityMenuItem>
  );
}
