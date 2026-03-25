import { useEffect, useState, useCallback, useRef } from 'react';
import { Check, Database, LoaderCircle, Play, Plus, Square, Trash2, Upload, X } from 'lucide-react';
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
  category?: string;
  description?: string;
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

const defaultDevice = (index: number, definitionId: string, definitionName?: string): DeviceConfiguration => ({
  deviceId: `device-${index}`,
  displayName: definitionName ?? `Battery ${index}`,
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
  const { definitions: availableDefinitions, refresh: refreshDefinitions } = useDeviceDefinitions();
  const [devices, setDevices] = useState<DeviceConfiguration[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ports, setPorts] = useState<string[]>([]);
  const [defaultPort, setDefaultPort] = useState('');
  const [deviceActions, setDeviceActions] = useState<Record<string, { loading: boolean; result?: StartStopResult }>>({});
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbSuggestions, setDbSuggestions] = useState<Record<string, DatabaseSuggestion>>({});
  const [dbValidations, setDbValidations] = useState<Record<string, SchemaValidation | null>>({});
  const [dbCreating, setDbCreating] = useState<Record<string, boolean>>({});
  const [dbCreateMsg, setDbCreateMsg] = useState<Record<string, string | null>>({});

  // Add device picker state
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-save state
  const [saveDirty, setSaveDirty] = useState(0);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const initialLoadDone = useRef(false);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;

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

  // Load initial data
  useEffect(() => {
    let isMounted = true;

    const loadDevices = async () => {
      try {
        const response = await fetch('/api/devices/config');
        if (!response.ok) throw new Error('Unable to load device configuration.');
        const data = (await response.json()) as DeviceConfigurationResponse;
        if (!isMounted) return;
        setDevices(data.devices);
        setLoadError(null);
      } catch (error) {
        if (!isMounted) return;
        setLoadError(error instanceof Error ? error.message : 'Unable to load device configuration.');
      } finally {
        if (isMounted) {
          setIsLoading(false);
          // Delay to avoid auto-save triggering on initial load side-effects
          setTimeout(() => { initialLoadDone.current = true; }, 200);
        }
      }
    };

    void loadDevices();
    void loadPorts();
    void loadDatabases();

    return () => { isMounted = false; };
  }, [loadPorts, loadDatabases]);

  // Load DB suggestions for devices with definitions
  useEffect(() => {
    for (const device of devices) {
      if (device.deviceId && device.definitionId && !dbSuggestions[device.deviceId]) {
        void loadDbSuggestion(device.deviceId);
      }
    }
  }, [devices, dbSuggestions, loadDbSuggestion]);

  // Auto-save function (reads latest devices from ref)
  const saveDevicesNow = useCallback(async (devicesToSave?: DeviceConfiguration[]) => {
    const payload = devicesToSave ?? devicesRef.current;
    try {
      setAutoSaveStatus('saving');
      const response = await fetch('/api/devices/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: payload }),
      });
      if (response.ok) {
        const data = (await response.json()) as DeviceConfigurationResponse;
        setDevices(data.devices);
        setAutoSaveStatus('saved');
        setTimeout(() => setAutoSaveStatus(prev => prev === 'saved' ? 'idle' : prev), 2000);
      } else {
        setAutoSaveStatus('error');
      }
    } catch {
      setAutoSaveStatus('error');
    }
  }, []);

  // Debounced auto-save triggered by dirty counter
  useEffect(() => {
    if (!initialLoadDone.current || saveDirty === 0) return;
    const timer = setTimeout(() => { void saveDevicesNow(); }, 600);
    return () => clearTimeout(timer);
  }, [saveDirty, saveDevicesNow]);

  const markDirty = useCallback(() => {
    setSaveDirty(d => d + 1);
  }, []);

  const updateDevice = <K extends keyof DeviceConfiguration>(index: number, key: K, value: DeviceConfiguration[K]) => {
    setDevices(currentDevices => currentDevices.map((device, currentIndex) => {
      if (currentIndex !== index) return device;
      return { ...device, [key]: value };
    }));
    markDirty();
  };

  const addDeviceFromDefinition = (definitionId: string) => {
    const def = availableDefinitions.find(d => d.id === definitionId);
    setDevices(currentDevices => [...currentDevices, defaultDevice(currentDevices.length + 1, definitionId, def?.name)]);
    setShowAddPicker(false);
    markDirty();
  };

  const handleUploadDefinition = async (file: File) => {
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const resp = await fetch('/api/definitions/upload', { method: 'POST', body: formData });
      const data = (await resp.json()) as { id?: string; name?: string; message?: string };
      if (!resp.ok) throw new Error(data.message ?? 'Upload failed');
      await refreshDefinitions();
      if (data.id) addDeviceFromDefinition(data.id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const removeDevice = (index: number) => {
    setDevices(currentDevices => currentDevices.filter((_, currentIndex) => currentIndex !== index));
    markDirty();
  };

  const startDevice = async (deviceId: string) => {
    setDeviceActions(prev => ({ ...prev, [deviceId]: { loading: true } }));
    try {
      // Flush any pending changes immediately
      await saveDevicesNow();

      const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/start`, { method: 'POST' });
      const data = (await resp.json()) as StartStopResult;
      setDeviceActions(prev => ({ ...prev, [deviceId]: { loading: false, result: data } }));
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
            Add or remove devices. Changes are saved automatically.
          </p>
        </div>
        <div className='flex items-center gap-3'>
          {autoSaveStatus === 'saving' ? (
            <span className='flex items-center gap-1.5 text-xs text-muted-foreground'>
              <LoaderCircle className='h-3 w-3 animate-spin' /> Saving...
            </span>
          ) : autoSaveStatus === 'saved' ? (
            <span className='flex items-center gap-1.5 text-xs text-emerald-500'>
              <Check className='h-3 w-3' /> Saved
            </span>
          ) : autoSaveStatus === 'error' ? (
            <span className='text-xs text-destructive'>Save failed</span>
          ) : null}
        </div>
      </div>

      <div className='flex flex-wrap gap-3'>
        <Button type='button' variant='outline' size='lg' onClick={() => setShowAddPicker(true)}>
          <Plus className='h-4 w-4' />
          Add device
        </Button>
      </div>

      {/* Add device picker */}
      {showAddPicker ? (
        <div className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
          <div className='flex items-center justify-between mb-4'>
            <h3 className='text-lg font-semibold text-foreground'>Add a new device</h3>
            <Button type='button' variant='ghost' size='sm' onClick={() => { setShowAddPicker(false); setUploadError(null); }}>
              <X className='h-4 w-4' />
            </Button>
          </div>

          {availableDefinitions.length > 0 ? (
            <div className='mb-4'>
              <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3'>
                From device library
              </span>
              <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                {availableDefinitions.map(def => (
                  <button
                    key={def.id}
                    type='button'
                    className='flex flex-col gap-1 rounded-xl border border-border bg-muted/30 p-4 text-left transition hover:border-primary/50 hover:bg-muted/60'
                    onClick={() => addDeviceFromDefinition(def.id)}
                  >
                    <span className='text-sm font-semibold text-foreground'>{def.name}</span>
                    <span className='text-xs text-muted-foreground'>{def.manufacturer} · {def.model}</span>
                    <span className='mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/70'>
                      {def.transportType}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground mb-3'>
              Upload definition JSON
            </span>
            <input
              ref={fileInputRef}
              type='file'
              accept='.json'
              className='hidden'
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUploadDefinition(file);
                e.target.value = '';
              }}
            />
            <Button
              type='button'
              variant='outline'
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className='h-4 w-4' />
              Browse for .json file
            </Button>
            {uploadError ? (
              <div className='mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'>
                {uploadError}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {loadError ? (
        <div className='rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>
          {loadError}
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
            const isSerial = needsSerialPort(device, availableDefinitions);
            const isRunning = device.enabled;
            const def = availableDefinitions.find(d => d.id === device.definitionId);

            return (
              <section key={`${device.deviceId}-${index}`} className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
                <div className='mb-5 flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-center md:justify-between'>
                  <div>
                    <div className='flex items-center gap-2'>
                      <h3 className='text-lg font-semibold text-foreground'>{device.displayName || `Device ${index + 1}`}</h3>
                      {isRunning ? (
                        <span className='rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-500'>Running</span>
                      ) : (
                        <span className='rounded-full bg-muted border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>Stopped</span>
                      )}
                    </div>
                    <div className='mt-1 flex items-center gap-2'>
                      <span className='text-xs font-mono text-muted-foreground'>{device.deviceId || 'device-id-required'}</span>
                      {def ? (
                        <span className='rounded-md bg-primary/10 border border-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary'>
                          {def.name} ({def.model})
                        </span>
                      ) : device.definitionId ? (
                        <span className='rounded-md bg-muted border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground'>
                          {device.definitionId}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    {isRunning ? (
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
                    <Button type='button' variant='destructive' onClick={() => removeDevice(index)} disabled={isRunning}>
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
                    <Input value={device.deviceId} disabled={isRunning} onChange={(event) => updateDevice(index, 'deviceId', event.target.value)} />
                  </label>
                  <label className='space-y-2 text-sm text-foreground'>
                    <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Display name</span>
                    <Input value={device.displayName} onChange={(event) => updateDevice(index, 'displayName', event.target.value)} />
                  </label>
                  {isSerial ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Serial Port</span>
                      <select
                        className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
                        value={device.transportPortName ?? ''}
                        disabled={isRunning}
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
                      disabled={isRunning}
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

                      <div className='flex items-start gap-3'>
                        <div className='flex-1 max-w-sm'>
                          <select
                            className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
                            value={currentDbName && dbExists ? currentDbName : (currentDbName ? '__custom__' : '')}
                            disabled={isRunning}
                            onChange={(event) => {
                              const val = event.target.value;
                              if (val === '__new__') {
                                updateDevice(index, 'databaseName', suggestion.suggested || '');
                                if (suggestion.suggested) void validateDatabase(device.deviceId, suggestion.suggested);
                              } else if (val === '__custom__') {
                                // keep current
                              } else {
                                updateDevice(index, 'databaseName', val || null);
                                if (val) void validateDatabase(device.deviceId, val);
                              }
                            }}
                          >
                            <option value=''>Select a database...</option>
                            {databases.map(db => (
                              <option key={db} value={db}>{db}</option>
                            ))}
                            {currentDbName && !dbExists ? (
                              <option value='__custom__'>{currentDbName} (new)</option>
                            ) : null}
                            <option value='__new__'>+ Create new database</option>
                          </select>
                        </div>

                        {/* Show input + create button when name doesn't match an existing db */}
                        {currentDbName && !dbExists && !isRunning ? (
                          <div className='flex items-center gap-2'>
                            <Input
                              className='w-48'
                              value={currentDbName}
                              placeholder={suggestion.suggested || 'database_name'}
                              onChange={(event) => {
                                updateDevice(index, 'databaseName', event.target.value || null);
                              }}
                            />
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
                          </div>
                        ) : null}
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

          {devices.length === 0 && !showAddPicker ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <div className='text-lg font-semibold text-foreground'>No devices configured</div>
              <p className='mt-2 text-sm text-muted-foreground'>Add a device from the library or upload a definition JSON to get started.</p>
              <div className='mt-6'>
                <Button type='button' onClick={() => setShowAddPicker(true)}>
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
