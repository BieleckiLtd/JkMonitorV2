import { Cable, ChevronRight, LoaderCircle, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Switch } from './ui/switch';
import { cn } from '../lib/utils';
import { runWithViewTransition } from '../lib/viewTransitions';

type DeviceNavigationItem = {
  deviceId: string;
  displayName: string;
  enabled: boolean;
  sortOrder?: number;
};

type DeviceConfigurationResponse = {
  devices: DeviceNavigationItem[];
};

type StartStopResult = {
  message?: string;
};

type DeviceActionState = {
  loading: boolean;
  error?: string;
};

function getDevicePath(deviceId: string) {
  return `/devices/${encodeURIComponent(deviceId)}`;
}

function getSortedDevices(devices: DeviceNavigationItem[]) {
  return [...devices].sort((left, right) => {
    const leftSortOrder = left.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const rightSortOrder = right.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftSortOrder !== rightSortOrder) {
      return leftSortOrder - rightSortOrder;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

export function DevicesNavigationPanel({ className }: { className?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<DeviceNavigationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, DeviceActionState>>({});

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch('/api/devices/summary', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load configured devices.');
      }

      const data = (await response.json()) as DeviceConfigurationResponse;
      setDevices(getSortedDevices(data.devices ?? []));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load configured devices.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    const handleDevicesChanged = () => {
      void loadDevices();
    };

    window.addEventListener('devices:config-changed', handleDevicesChanged);
    return () => {
      window.removeEventListener('devices:config-changed', handleDevicesChanged);
    };
  }, [loadDevices]);

  const toggleDevice = useCallback(async (device: DeviceNavigationItem, enabled: boolean) => {
    setActions((current) => ({
      ...current,
      [device.deviceId]: { loading: true },
    }));

    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(device.deviceId)}/${enabled ? 'start' : 'stop'}`, {
        method: 'POST',
      });
      const data = (await response.json().catch(() => ({}))) as StartStopResult;
      if (!response.ok) {
        throw new Error(data.message ?? `Unable to ${enabled ? 'start' : 'stop'} device.`);
      }

      setDevices((current) => current.map((candidate) => (
        candidate.deviceId === device.deviceId
          ? { ...candidate, enabled }
          : candidate
      )));
      setActions((current) => ({
        ...current,
        [device.deviceId]: { loading: false },
      }));
    } catch (error) {
      setActions((current) => ({
        ...current,
        [device.deviceId]: {
          loading: false,
          error: error instanceof Error ? error.message : `Unable to ${enabled ? 'start' : 'stop'} device.`,
        },
      }));
    }
  }, []);

  const activePath = location.pathname;

  return (
    <nav
      aria-label='Devices navigation'
      className={cn('border border-border/70 bg-card/85 shadow-sm backdrop-blur-sm', className)}
    >
      <div className='flex items-center justify-between px-4 pt-4 pb-3'>
        <span className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>DEVICES</span>
        <span className='border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>
          {devices.length + 1}_ITEMS
        </span>
      </div>

      {isLoading ? (
        <div className='flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground'>
          <LoaderCircle className='h-4 w-4 animate-spin' />
          Loading devices...
        </div>
      ) : null}

      {loadError ? (
        <div className='px-4 pb-3 text-xs text-rose-400'>
          {loadError}
        </div>
      ) : null}

      <div>
        {devices.map((device) => {
          const isActive = activePath === getDevicePath(device.deviceId);
          const action = actions[device.deviceId];

          return (
            <div key={device.deviceId}>
              <div
                data-active={isActive ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 transition-all duration-100',
                  isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/25',
                )}
              >
                <button
                  type='button'
                  onClick={() => {
                    if (isActive) {
                      return;
                    }

                    runWithViewTransition(() => {
                      navigate(getDevicePath(device.deviceId));
                    }, { direction: 'forward' });
                  }}
                  className='flex min-w-0 flex-1 items-center gap-2.5 text-left'
                >
                  <div
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center',
                      isActive ? 'bg-primary/14 text-primary' : 'bg-white/5 text-muted-foreground',
                    )}
                  >
                    <Cable className={cn('h-4 w-4', isActive ? 'opacity-100' : 'opacity-60')} />
                  </div>
                  <div className='min-w-0'>
                    <div className={cn('truncate font-mono text-sm', isActive ? 'text-primary' : 'text-foreground')}>
                      {device.displayName}
                    </div>
                    <div className='truncate font-mono text-[10px] uppercase tracking-tight text-muted-foreground'>
                      {device.deviceId}
                    </div>
                  </div>
                </button>

                <div className='flex shrink-0 items-center gap-1.5'>
                  {action?.loading ? <LoaderCircle className='h-3.5 w-3.5 animate-spin text-muted-foreground' /> : null}
                  <Switch
                    size='sm'
                    checked={device.enabled}
                    aria-label={`Toggle readouts for ${device.displayName}`}
                    disabled={action?.loading}
                    onCheckedChange={(checked: boolean) => {
                      void toggleDevice(device, checked);
                    }}
                  />
                  <ChevronRight className={cn('h-4 w-4', isActive ? 'opacity-80' : 'opacity-50')} />
                </div>
              </div>

              {action?.error ? (
                <div className='px-4 pb-2 text-[10px] text-rose-400'>
                  {action.error}
                </div>
              ) : null}

              <div aria-hidden='true' className='px-4'>
                <div className='h-px bg-white/5' />
              </div>
            </div>
          );
        })}

        <button
          type='button'
          onClick={() => {
            if (activePath === '/devices/add') {
              return;
            }

            runWithViewTransition(() => {
              navigate('/devices/add');
            }, { direction: 'forward' });
          }}
          className={cn(
            'flex w-full items-center justify-between px-3 py-2.5 text-left transition-all duration-100',
            activePath === '/devices/add' ? 'bg-primary/10 text-primary' : 'hover:bg-accent/25',
          )}
        >
          <div className='flex items-center gap-2.5'>
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center',
                activePath === '/devices/add' ? 'bg-primary/14 text-primary' : 'bg-white/5 text-muted-foreground',
              )}
            >
              <Plus className={cn('h-4 w-4', activePath === '/devices/add' ? 'opacity-100' : 'opacity-60')} />
            </div>
            <div>
              <div className={cn('font-mono text-sm', activePath === '/devices/add' ? 'text-primary' : 'text-foreground')}>
                Add a new device
              </div>
              <div className='font-mono text-[10px] uppercase tracking-tight text-muted-foreground'>
                Open the device library and uploader
              </div>
            </div>
          </div>
          <ChevronRight className={cn('h-5 w-5 shrink-0', activePath === '/devices/add' ? 'opacity-80' : 'opacity-50')} />
        </button>
      </div>
    </nav>
  );
}
