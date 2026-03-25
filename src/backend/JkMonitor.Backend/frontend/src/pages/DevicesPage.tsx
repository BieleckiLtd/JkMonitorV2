import { useEffect, useState } from 'react';
import { Cable, LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { useDeviceDefinitions } from '../hooks/useDeviceDefinition';

type DeviceConfiguration = {
  deviceId: string;
  displayName: string;
  profileId: string;
  definitionId?: string | null;
  transportPortName?: string | null;
  address: number;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  enabled: boolean;
};

type DeviceConfigurationResponse = {
  configurationFile: string;
  devices: DeviceConfiguration[];
};

const defaultDevice = (index: number): DeviceConfiguration => ({
  deviceId: `device-${index}`,
  displayName: `Battery ${index}`,
  profileId: 'jk-inverter-bms',
  definitionId: 'jk-inverter-bms',
  transportPortName: '/dev/ttyUSB0',
  address: index,
  isMaster: index === 1,
  pollIntervalMilliseconds: 1000,
  enabled: true,
});

export function DevicesPage() {
  const availableDefinitions = useDeviceDefinitions();
  const [devices, setDevices] = useState<DeviceConfiguration[]>([]);
  const [configurationFile, setConfigurationFile] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadDevices = async () => {
      try {
        const response = await fetch('/api/devices/config');

        if (!response.ok) {
          throw new Error('Unable to load device configuration.');
        }

        const data = (await response.json()) as DeviceConfigurationResponse;

        if (!isMounted) {
          return;
        }

        setDevices(data.devices);
        setConfigurationFile(data.configurationFile);
        setLoadError(null);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : 'Unable to load device configuration.');
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadDevices();

    return () => {
      isMounted = false;
    };
  }, []);

  const updateDevice = <K extends keyof DeviceConfiguration>(index: number, key: K, value: DeviceConfiguration[K]) => {
    setDevices((currentDevices) => currentDevices.map((device, currentIndex) => {
      if (currentIndex !== index) {
        return device;
      }

      return {
        ...device,
        [key]: value,
      };
    }));
  };

  const addDevice = () => {
    setDevices((currentDevices) => [...currentDevices, defaultDevice(currentDevices.length + 1)]);
    setSaveMessage(null);
  };

  const removeDevice = (index: number) => {
    setDevices((currentDevices) => currentDevices.filter((_, currentIndex) => currentIndex !== index));
    setSaveMessage(null);
  };

  const saveDevices = async () => {
    setIsSaving(true);
    setSaveMessage(null);

    try {
      const response = await fetch('/api/devices/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ devices }),
      });

      const payload = await response.json() as DeviceConfigurationResponse | { message?: string };

      if (!response.ok) {
        throw new Error('message' in payload && payload.message ? payload.message : 'Unable to save device configuration.');
      }

      const data = payload as DeviceConfigurationResponse;
      setDevices(data.devices);
      setConfigurationFile(data.configurationFile);
      setSaveMessage('Configuration applied. Device changes are live — no restart required.');
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Unable to save device configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className='space-y-6 max-w-6xl mx-auto pb-12'>
      <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
        <div>
          <h2 className='text-3xl font-bold tracking-tight text-foreground'>Device Configuration</h2>
          <p className='mt-2 text-sm text-muted-foreground'>
            Add or remove devices and assign a device definition to drive polling, rendering, and storage.
          </p>
        </div>
        <div className='rounded-lg border border-border bg-card/70 px-4 py-3 text-sm text-muted-foreground'>
          <div className='font-medium text-foreground'>Active config</div>
          <div className='font-mono text-xs'>{configurationFile || 'Loading...'}</div>
        </div>
      </div>

      <div className='flex flex-col gap-3 rounded-2xl border border-border bg-card/60 p-5 shadow-sm md:flex-row md:items-center md:justify-between'>
        <div className='flex items-start gap-3'>
          <div className='flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-primary/10 text-primary'>
            <Cable className='h-5 w-5' />
          </div>
          <div>
            <div className='text-sm font-semibold text-foreground'>JSON-backed device editor</div>
            <div className='mt-1 text-sm text-muted-foreground'>
              Changes are applied live when you save — no restart required.
            </div>
          </div>
        </div>

        <div className='flex flex-wrap gap-3'>
          <Button type='button' variant='outline' size='lg' onClick={addDevice}>
            <Plus className='h-4 w-4' />
            Add device
          </Button>
          <Button type='button' size='lg' onClick={saveDevices} disabled={isLoading || isSaving}>
            {isSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Save className='h-4 w-4' />}
            Save devices
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className='rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>
          {loadError}
        </div>
      ) : null}

      {saveMessage ? (
        <div className='rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-foreground'>
          {saveMessage}
        </div>
      ) : null}

      {isLoading ? (
        <div className='flex min-h-64 items-center justify-center rounded-2xl border border-border bg-card/50'>
          <LoaderCircle className='h-6 w-6 animate-spin text-primary' />
        </div>
      ) : (
        <div className='grid gap-4'>
          {devices.map((device, index) => (
            <section key={`${device.deviceId}-${index}`} className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
              <div className='mb-5 flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between'>
                <div>
                  <h3 className='text-lg font-semibold text-foreground'>{device.displayName || `Device ${index + 1}`}</h3>
                  <p className='mt-1 text-xs font-mono text-muted-foreground'>{device.deviceId || 'device-id-required'}</p>
                </div>
                <Button type='button' variant='destructive' onClick={() => removeDevice(index)}>
                  <Trash2 className='h-4 w-4' />
                  Remove
                </Button>
              </div>

              <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Device ID</span>
                  <Input value={device.deviceId} onChange={(event) => updateDevice(index, 'deviceId', event.target.value)} />
                </label>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Display name</span>
                  <Input value={device.displayName} onChange={(event) => updateDevice(index, 'displayName', event.target.value)} />
                </label>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Device Profile</span>
                  <Input value={device.profileId} onChange={(event) => updateDevice(index, 'profileId', event.target.value)} />
                </label>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Device Definition</span>
                  <select
                    className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                    value={device.definitionId ?? ''}
                    onChange={(event) => updateDevice(index, 'definitionId', event.target.value || null)}
                  >
                    <option value=''>None (legacy profile)</option>
                    {availableDefinitions.map(d => (
                      <option key={d.id} value={d.id}>{d.name} ({d.manufacturer} {d.model})</option>
                    ))}
                  </select>
                </label>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Serial Port</span>
                  <Input
                    placeholder='/dev/ttyUSB0'
                    value={device.transportPortName ?? ''}
                    onChange={(event) => updateDevice(index, 'transportPortName', event.target.value || null)}
                  />
                </label>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Address</span>
                  <Input
                    type='number'
                    min={0}
                    max={255}
                    value={device.address}
                    onChange={(event) => updateDevice(index, 'address', Number(event.target.value))}
                  />
                </label>
                <label className='space-y-2 text-sm text-foreground'>
                  <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Poll interval ms</span>
                  <Input
                    type='number'
                    min={1}
                    value={device.pollIntervalMilliseconds}
                    onChange={(event) => updateDevice(index, 'pollIntervalMilliseconds', Number(event.target.value))}
                  />
                </label>
                <div className='rounded-xl border border-border bg-muted/40 px-4 py-3'>
                  <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Master device</div>
                  <div className='mt-3 flex items-center justify-between gap-3'>
                    <span className='text-sm text-foreground'>Prioritize this device in status views</span>
                    <Switch checked={device.isMaster} onCheckedChange={(checked) => updateDevice(index, 'isMaster', checked)} />
                  </div>
                </div>
                <div className='rounded-xl border border-border bg-muted/40 px-4 py-3'>
                  <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Enabled</div>
                  <div className='mt-3 flex items-center justify-between gap-3'>
                    <span className='text-sm text-foreground'>Include this device in polling</span>
                    <Switch checked={device.enabled} onCheckedChange={(checked) => updateDevice(index, 'enabled', checked)} />
                  </div>
                </div>
              </div>
            </section>
          ))}

          {devices.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <div className='text-lg font-semibold text-foreground'>No devices configured</div>
              <p className='mt-2 text-sm text-muted-foreground'>Create the first device and save to write an empty or populated device list back to JSON.</p>
              <div className='mt-6'>
                <Button type='button' onClick={addDevice}>
                  <Plus className='h-4 w-4' />
                  Add first device
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
