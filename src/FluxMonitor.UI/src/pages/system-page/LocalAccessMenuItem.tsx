import { ChevronDown, ChevronRight, Link2, LoaderCircle } from 'lucide-react';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import type {
  DirectAccessSettingsSnapshot,
  InlineFeedback,
  LocalAccessModeSnapshot,
} from './types';

type LocalAccessMenuItemProps = {
  localAccessSummary: string;
  localAccessSectionOpen: boolean;
  localAccessModeLoading: boolean;
  localAccessModeFeedback: InlineFeedback | null;
  localAccessMode: LocalAccessModeSnapshot | null;
  localAccessSettings: DirectAccessSettingsSnapshot | null;
  localAccessBluetoothDeviceName: string;
  localAccessHotspotSsid: string;
  localAccessStatus: string;
  localAccessAddresses: string[];
  localAccessAdvancedOpen: boolean;
  localAccessSettingsFeedback: InlineFeedback | null;
  localAccessBluetoothName: string;
  localAccessHotspotName: string;
  localAccessWifiPassword: string;
  localAccessShowPassword: boolean;
  localAccessSettingsSaving: boolean;
  localAccessSettingsDirty: boolean;
  localAccessUsesWpa3Only: boolean;
  onToggleExpanded: () => void;
  onToggleMode: () => void | Promise<void>;
  onToggleAdvanced: () => void;
  onBluetoothNameChange: (value: string) => void;
  onHotspotNameChange: (value: string) => void;
  onWifiPasswordChange: (value: string) => void;
  onShowPasswordChange: (checked: boolean) => void;
  onSaveSettings: () => void | Promise<void>;
};

export function LocalAccessMenuItem({
  localAccessSummary,
  localAccessSectionOpen,
  localAccessModeLoading,
  localAccessModeFeedback,
  localAccessMode,
  localAccessSettings,
  localAccessBluetoothDeviceName,
  localAccessHotspotSsid,
  localAccessStatus,
  localAccessAddresses,
  localAccessAdvancedOpen,
  localAccessSettingsFeedback,
  localAccessBluetoothName,
  localAccessHotspotName,
  localAccessWifiPassword,
  localAccessShowPassword,
  localAccessSettingsSaving,
  localAccessSettingsDirty,
  localAccessUsesWpa3Only,
  onToggleExpanded,
  onToggleMode,
  onToggleAdvanced,
  onBluetoothNameChange,
  onHotspotNameChange,
  onWifiPasswordChange,
  onShowPasswordChange,
  onSaveSettings,
}: LocalAccessMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='Fallback local access'
      summary={localAccessSummary}
      icon={Link2}
      expanded={localAccessSectionOpen}
      onToggleExpanded={onToggleExpanded}
      expandButtonLabel={{
        collapsed: 'Expand fallback local access details',
        expanded: 'Collapse fallback local access details',
      }}
      toggleControl={(
        <Switch
          checked={Boolean(localAccessMode?.supported) && Boolean(localAccessMode?.enabled)}
          disabled={localAccessModeLoading || !(localAccessMode?.supported ?? false)}
          onCheckedChange={() => void onToggleMode()}
          aria-label='Toggle fallback local access'
        />
      )}
    >
      <div className='text-xs leading-5 text-muted-foreground'>
        {localAccessSummary}
      </div>

      {localAccessModeFeedback ? (
        <div className={cn(
          'system-feedback',
          localAccessModeFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
        )}>
          {localAccessModeFeedback.message}
        </div>
      ) : null}

      {!localAccessMode?.supported ? (
        <div className='system-empty-state'>
          {localAccessMode?.statusMessage ?? 'Fallback local access is unavailable on this host.'}
        </div>
      ) : null}

      <div className='system-panel-surface bg-background/35'>
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <div className='system-detail-tile'>
            <div className='system-label'>Bluetooth name</div>
            <div className='mt-2 text-sm font-semibold text-foreground'>{localAccessBluetoothDeviceName}</div>
          </div>
          <div className='system-detail-tile'>
            <div className='system-label'>Hotspot SSID</div>
            <div className='mt-2 text-sm font-semibold text-foreground'>{localAccessHotspotSsid}</div>
          </div>
          <div className='system-detail-tile'>
            <div className='system-label'>Password</div>
            <div className='mt-2 text-sm font-semibold text-foreground'>{localAccessMode?.hotspotPassword || 'No password'}</div>
          </div>
          <div className='system-detail-tile'>
            <div className='system-label'>Status</div>
            <div className='mt-2 text-sm font-semibold text-foreground'>{localAccessStatus}</div>
          </div>
        </div>
        {localAccessAddresses.length > 1 ? (
          <div className='mt-3 break-all font-mono text-[11px] text-muted-foreground'>
            {localAccessAddresses.join(' • ')}
          </div>
        ) : null}
      </div>

      <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/30'>
        <button
          type='button'
          onClick={onToggleAdvanced}
          className='flex w-full items-center justify-between gap-3 px-4 py-3 text-left'
        >
          <div className='text-sm font-medium text-foreground'>Advanced</div>
          {localAccessAdvancedOpen ? <ChevronDown className='h-4 w-4 text-muted-foreground' /> : <ChevronRight className='h-4 w-4 text-muted-foreground' />}
        </button>

        {localAccessAdvancedOpen ? (
          <div className='system-menu-card-body'>
            {!localAccessSettings?.storageAvailable ? (
              <div className='rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-100'>
                Fallback local access settings cannot be saved until PostgreSQL storage is configured.
              </div>
            ) : null}

            {localAccessSettingsFeedback ? (
              <div className={cn(
                'system-feedback',
                localAccessSettingsFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
              )}>
                {localAccessSettingsFeedback.message}
              </div>
            ) : null}

            <div className='space-y-2'>
              <label className='system-input-label'>Bluetooth name</label>
              <Input
                aria-label='Fallback Bluetooth name'
                value={localAccessBluetoothName}
                onChange={(event) => onBluetoothNameChange(event.target.value)}
                placeholder='Flux Monitor'
              />
              <div className='text-xs leading-5 text-muted-foreground'>
                Shown when a phone or laptop pairs with the fallback Bluetooth connection.
              </div>
            </div>

            <div className='space-y-2'>
              <label className='system-input-label'>Hotspot SSID</label>
              <Input
                aria-label='Fallback hotspot SSID'
                value={localAccessHotspotName}
                onChange={(event) => onHotspotNameChange(event.target.value)}
                placeholder='FluxMonitor-Pi'
              />
              <div className='text-xs leading-5 text-muted-foreground'>
                Broadcast if fallback local access starts a hotspot because the router is unavailable.
              </div>
            </div>

            <div className='space-y-2'>
              <label className='system-input-label'>Hotspot password</label>
              <Input
                aria-label='Fallback hotspot password'
                type={localAccessShowPassword ? 'text' : 'password'}
                value={localAccessWifiPassword}
                onChange={(event) => onWifiPasswordChange(event.target.value)}
                placeholder='No password'
              />
              <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                <input
                  type='checkbox'
                  checked={localAccessShowPassword}
                  onChange={(event) => onShowPasswordChange(event.target.checked)}
                  className='h-4 w-4 rounded border border-input bg-background/70'
                />
                <span>Show password</span>
              </label>
              <div className='text-xs leading-5 text-muted-foreground'>
                {localAccessWifiPassword.length === 0
                  ? 'Leave this blank if you want local access to start without a password.'
                  : localAccessUsesWpa3Only
                    ? 'This password uses WPA3-only hotspot security.'
                    : 'This password uses the standard hotspot security mode.'}
              </div>
            </div>

            <div className='flex justify-end'>
              <button
                type='button'
                aria-label='Save fallback local access settings'
                disabled={localAccessSettingsSaving || !localAccessSettings?.storageAvailable || !localAccessSettingsDirty}
                onClick={() => void onSaveSettings()}
                className='system-button-secondary'
              >
                {localAccessSettingsSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : null}
                Save
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </ConnectivityMenuItem>
  );
}
