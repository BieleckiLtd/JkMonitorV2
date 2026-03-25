import { useEffect, useState, useCallback } from 'react';
import { Database, LoaderCircle, Play, Plus, Save, Square, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useDeviceDefinitions } from '../hooks/useDeviceDefinition';

type DeviceConfiguration = {
  deviceId: string;
  displayName: string;
  definitionId: string;
  transportPortName?: string | null;
  databaseName?: string | null;
  address: number;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  enabled: boolean;
};

type DeviceConfigurationResponse = {
  configurationFile: string;
  devices: DeviceConfiguration[];
};

type PortsResponse = {
  ports: string[];
  defaultPort: string;
  error?: string;
};

type StartStopResult = {
  deviceId: string;
  started?: boolean;
  stopped?: boolean;
  outcome?: string;
  error?: string | null;
  message: string;
};

type DeviceDefinitionSummary = {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  transportType: string;
};

type DatabaseSuggestion = {
  suggested: string;
  requiresDatabase: boolean;
  provider: string;
};

type SchemaValidation = {
  compatible: boolean;
  hasTimescaleDb: boolean;
  existingTables: string[];
  issues: string[];
  isEmpty: boolean;
};

const defaultDevice = (index: number, definitionId: string): DeviceConfiguration => ({
  deviceId: `device-${index}`,
  displayName: `Battery ${index}`,
  definitionId,
  transportPortName: '',
  databaseName: '',
  address: index,
  isMaster: false,
  pollIntervalMilliseconds: 1000,
  enabled: false,
});

function needsSerialPort(device: DeviceConfiguration, definitions: DeviceDefinitionSummary[]): boolean {
  if (!device.definitionId) return true;
  const def = definitions.find(d => d.id === device.definitionId);
  return !def || def.transportType === 'serial';
}

export function DevicesPage() {
  const availableDefinitions = useDeviceDefinitions();
  const [devices, setDevices] = useState<DeviceConfiguration[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const [defaultPort, setDefaultPort] = useState('');
  const [deviceActions, setDeviceActions] = useState<Record<string, { loading: boolean; result?: StartStopResult }>>({});
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbSuggestions, setDbSuggestions] = useState<Record<string, DatabaseSuggestion>>({});
  const [dbValidations, setDbValidations] = useState<Record<string, SchemaValidation | null>>({});
  const [dbCreating, setDbCreating] = useState<Record<string, boolean>>({});
  const [dbCreateMsg, setDbCreateMsg] = useState<Record<string, string | null>>({});

  const loadPorts = useCallback(async () => {
    try {
      const resp = await fetch('/api/devices/ports');
      if (!resp.ok) return;
      const data = (await resp.json()) as PortsResponse;
      setPorts(data.ports);
      setDefaultPort(data.defaultPort);
    } catch { /* ignore */ }
  }, []);

  const loadDatabases = useCallback(async () => {
    try {
      const resp = await fetch('/api/devices/databases');
      if (!resp.ok) return;
      const data = (await resp.json()) as { databases: string[]; error?: string };
      setDatabases(data.databases);
    } catch { /* ignore */ }
  }, []);

  const loadDbSuggestion = useCallback(async (deviceId: string) => {
    try {
      const resp = await fetch(`/api/devices/databases/suggest/${encodeURIComponent(deviceId)}`);
      if (!resp.ok) return;
      const data = (await resp.json()) as DatabaseSuggestion;
      setDbSuggestions(prev => ({ ...prev, [deviceId]: data }));
    } catch { /* ignore */ }
  }, []);

  const validateDatabase = useCallback(async (deviceId: string, dbName: string) => {
    if (!dbName) { setDbValidations(prev => ({ ...prev, [deviceId]: null })); return; }
    try {
      const resp = await fetch('/api/devices/databases/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseName: dbName }),
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as SchemaValidation;
      setDbValidations(prev => ({ ...prev, [deviceId]: data }));
    } catch { /* ignore */ }
  }, []);

  const createDatabase = useCallback(async (deviceId: string, dbName: string, provider: string) => {
    setDbCreating(prev => ({ ...prev, [deviceId]: true }));
    setDbCreateMsg(prev => ({ ...prev, [deviceId]: null }));
    try {
      const resp = await fetch('/api/devices/databases/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ databaseName: dbName, provider }),
      });
      const data = (await resp.json()) as { success: boolean; message: string };
      setDbCreateMsg(prev => ({ ...prev, [deviceId]: data.message }));
      if (data.success) {
        await loadDatabases();
        await validateDatabase(deviceId, dbName);
      }
    } catch (err) {
      setDbCreateMsg(prev => ({ ...prev, [deviceId]: err instanceof Error ? err.message : 'Failed to create database.' }));
    } finally {
      setDbCreating(prev => ({ ...prev, [deviceId]: false }));
    }
  }, [loadDatabases, validateDatabase]);

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
    void loadPorts();
    void loadDatabases();

    return () => {
      isMounted = false;
    };
  }, [loadPorts, loadDatabases]);

  // Load DB suggestions for devices with definitions
  useEffect(() => {
    for (const device of devices) {
      if (device.deviceId && device.definitionId && !dbSuggestions[device.deviceId]) {
        void loadDbSuggestion(device.deviceId);
      }
    }
  }, [devices, dbSuggestions, loadDbSuggestion]);

  useEffect(() => {
    if (availableDefinitions.length === 0) {
      return;
    }

    const defaultDefinition = availableDefinitions[0];
    setDevices((currentDevices) => currentDevices.map((device) => {
      if (device.definitionId) {
        return device;
      }

      return {
        ...device,
        definitionId: defaultDefinition.id,
      };
    }));
  }, [availableDefinitions]);

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
    const defId = availableDefinitions[0]?.id ?? 'jk-inverter-bms';
    setDevices((currentDevices) => [...currentDevices, defaultDevice(currentDevices.length + 1, defId)]);
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
      setSaveMessage('Configuration saved.');
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : 'Unable to save device configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  const startDevice = async (deviceId: string) => {
    setDeviceActions(prev => ({ ...prev, [deviceId]: { loading: true } }));
    try {
      // Save first to persist any unsaved changes
      await saveDevices();

      const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/start`, { method: 'POST' });
      const data = (await resp.json()) as StartStopResult;
      setDeviceActions(prev => ({ ...prev, [deviceId]: { loading: false, result: data } }));

      // Update local enabled state
      setDevices(prev => prev.map(d => d.deviceId === deviceId ? { ...d, enabled: true } : d));
    } catch (error) {
      setDeviceActions(prev => ({
        ...prev,
        [deviceId]: {
          loading: false,
          result: { deviceId, message: error instanceof Error ? error.message : 'Failed to start device.' }
        }
      }));
    }
  };

  const stopDevice = async (deviceId: string) => {
    setDeviceActions(prev => ({ ...prev, [deviceId]: { loading: true } }));
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/stop`, { method: 'POST' });
      const data = (await resp.json()) as StartStopResult;
      setDeviceActions(prev => ({ ...prev, [deviceId]: { loading: false, result: data } }));

      // Update local enabled state
      setDevices(prev => prev.map(d => d.deviceId === deviceId ? { ...d, enabled: false } : d));
    } catch (error) {
      setDeviceActions(prev => ({
        ...prev,
        [deviceId]: {
          loading: false,
          result: { deviceId, message: error instanceof Error ? error.message : 'Failed to stop device.' }
        }
      }));
    }
  };

  return (
    <div className='space-y-6 max-w-6xl mx-auto pb-12'>
      <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
        <div>
          <h2 className='text-3xl font-bold tracking-tight text-foreground'>Devices</h2>
          <p className='mt-2 text-sm text-muted-foreground'>
            Add or remove devices and assign a device definition to drive polling, rendering, and storage.
          </p>
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
          {devices.map((device, index) => {
            const action = deviceActions[device.deviceId];
            const isSerial = needsSerialPort(device, availableDefinitions as DeviceDefinitionSummary[]);

            return (
              <section key={`${device.deviceId}-${index}`} className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
                <div className='mb-5 flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between'>
                  <div>
                    <div className='flex items-center gap-2'>
                      <h3 className='text-lg font-semibold text-foreground'>{device.displayName || `Device ${index + 1}`}</h3>
                      {device.enabled ? (
                        <span className='rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-500'>Running</span>
                      ) : (
                        <span className='rounded-full bg-muted border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>Stopped</span>
                      )}
                    </div>
                    <p className='mt-1 text-xs font-mono text-muted-foreground'>{device.deviceId || 'device-id-required'}</p>
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    {device.enabled ? (
                      <Button
                        type='button'
                        variant='outline'
                        onClick={() => void stopDevice(device.deviceId)}
                        disabled={action?.loading}
                      >
                        {action?.loading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Square className='h-4 w-4' />}
                        Stop
                      </Button>
                    ) : (
                      <Button
                        type='button'
                        variant='outline'
                        onClick={() => void startDevice(device.deviceId)}
                        disabled={action?.loading || !device.deviceId}
                      >
                        {action?.loading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Play className='h-4 w-4' />}
                        Start
                      </Button>
                    )}
                    <Button type='button' variant='destructive' onClick={() => removeDevice(index)}>
                      <Trash2 className='h-4 w-4' />
                      Remove
                    </Button>
                  </div>
                </div>

                {action?.result ? (
                  <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
                    action.result.outcome === 'Succeeded'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                      : action.result.stopped
                        ? 'border-border bg-muted/60 text-foreground'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  }`}>
                    {action.result.message}
                  </div>
                ) : null}

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
                    <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Device Definition</span>
                    <select
                      className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                      value={device.definitionId ?? availableDefinitions[0]?.id ?? ''}
                      onChange={(event) => updateDevice(index, 'definitionId', event.target.value)}
                    >
                      {availableDefinitions.map(d => (
                        <option key={d.id} value={d.id}>{d.name} ({d.model})</option>
                      ))}
                    </select>
                  </label>
                  {isSerial ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Serial Port</span>
                      <select
                        className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                        value={device.transportPortName ?? ''}
                        onChange={(event) => updateDevice(index, 'transportPortName', event.target.value || null)}
                      >
                        <option value=''>Default ({defaultPort || 'auto'})</option>
                        {ports.map(p => (
                          <option key={p} value={p}>{p}</option>
                        ))}
                      </select>
                    </label>
                  ) : null}
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
                </div>

                {/* Database configuration */}
                {(() => {
                  const suggestion = dbSuggestions[device.deviceId];
                  if (!suggestion?.requiresDatabase) return null;
                  const validation = dbValidations[device.deviceId];
                  const creating = dbCreating[device.deviceId];
                  const createMsg = dbCreateMsg[device.deviceId];
                  const currentDbName = device.databaseName ?? '';
                  const dbExists = databases.includes(currentDbName);

                  return (
                    <div className='mt-4 rounded-xl border border-border bg-muted/30 p-4'>
                      <div className='flex items-center gap-2 mb-3'>
                        <Database className='h-4 w-4 text-muted-foreground' />
                        <span className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>
                          Database ({suggestion.provider})
                        </span>
                      </div>
                      <div className='grid gap-4 md:grid-cols-2'>
                        <label className='space-y-2 text-sm text-foreground'>
                          <span className='block text-xs font-medium text-muted-foreground'>Database name</span>
                          <div className='flex gap-2'>
                            <select
                              className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                              value={currentDbName}
                              onChange={(event) => {
                                updateDevice(index, 'databaseName', event.target.value || null);
                                if (event.target.value) void validateDatabase(device.deviceId, event.target.value);
                              }}
                            >
                              <option value=''>Select or create a database...</option>
                              {suggestion.suggested && !databases.includes(suggestion.suggested) ? (
                                <option value={suggestion.suggested}>✨ {suggestion.suggested} (create new)</option>
                              ) : null}
                              {databases.map(db => (
                                <option key={db} value={db}>{db}</option>
                              ))}
                            </select>
                          </div>
                        </label>
                        <label className='space-y-2 text-sm text-foreground'>
                          <span className='block text-xs font-medium text-muted-foreground'>Or type a new name</span>
                          <div className='flex gap-2'>
                            <Input
                              value={currentDbName}
                              placeholder={suggestion.suggested || 'my_device_db'}
                              onChange={(event) => updateDevice(index, 'databaseName', event.target.value || null)}
                            />
                            {currentDbName && !dbExists ? (
                              <Button
                                type='button'
                                variant='outline'
                                size='sm'
                                className='shrink-0'
                                disabled={creating || !currentDbName}
                                onClick={() => void createDatabase(device.deviceId, currentDbName, suggestion.provider)}
                              >
                                {creating ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Plus className='h-4 w-4' />}
                                Create
                              </Button>
                            ) : null}
                          </div>
                        </label>
                      </div>

                      {createMsg ? (
                        <div className='mt-2 rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs text-foreground'>
                          {createMsg}
                        </div>
                      ) : null}

                      {validation ? (
                        <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${
                          validation.compatible || validation.isEmpty
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                        }`}>
                          {validation.isEmpty ? (
                            <span>Empty database — schema will be created on first poll.</span>
                          ) : validation.compatible ? (
                            <span>Schema is compatible. Tables: {validation.existingTables.join(', ')}</span>
                          ) : (
                            <div>
                              <span className='font-medium'>Schema issues:</span>
                              <ul className='mt-1 list-disc list-inside'>
                                {validation.issues.map((issue, i) => <li key={i}>{issue}</li>)}
                              </ul>
                            </div>
                          )}
                          {validation.hasTimescaleDb ? (
                            <span className='ml-2 text-emerald-500/80'>✓ TimescaleDB</span>
                          ) : currentDbName ? (
                            <span className='ml-2 text-amber-400'>⚠ No TimescaleDB extension</span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
              </section>
            );
          })}

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
