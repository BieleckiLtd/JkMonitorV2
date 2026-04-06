import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, Play, Plus, Square, Trash2, Upload, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useDeviceDefinitions } from '../hooks/useDeviceDefinition';
import { cn } from '../lib/utils';

type DeviceConfiguration = {
  deviceId: string;
  displayName: string;
  definitionId: string;
  definitionVersion?: string | null;
  transportPortName?: string | null;
  bleSettingsPin?: string | null;
  address: number;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  enabled: boolean;
};

type DeviceConfigurationResponse = {
  devices: DeviceConfiguration[];
};

type PortsResponse = {
  ports: string[];
};

type BleScanDevice = {
  address: string;
  alias?: string | null;
  name?: string | null;
  displayName: string;
  isConnected: boolean;
  isPaired: boolean;
  rssi?: number | null;
  manufacturerData: string[];
  advertisedServiceUuids: string[];
  isDefinitionVerified: boolean;
  verificationLabel?: string | null;
  verificationDetails?: string | null;
};

type BleScanResponse = {
  devices: BleScanDevice[];
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
  isTransportSupported: boolean;
  unsupportedTransportMessage?: string | null;
};

type DeviceDefinitionFamily = {
  key: string;
  name: string;
  manufacturer: string;
  model: string;
  category?: string;
  description?: string;
  definitions: DeviceDefinitionSummary[];
};

function getConnectionLabel(transportType: string | null | undefined) {
  switch (transportType?.toLowerCase()) {
    case 'serial':
      return 'USB / serial';
    case 'ble':
      return 'Bluetooth';
    case 'network':
      return 'Network';
    default:
      if (!transportType) {
        return 'Unknown';
      }

      return transportType.charAt(0).toUpperCase() + transportType.slice(1);
  }
}

function getTransportSortOrder(transportType: string) {
  switch (transportType.toLowerCase()) {
    case 'serial':
      return 0;
    case 'ble':
      return 1;
    default:
      return 10;
  }
}

function stripConnectionSuffix(name: string) {
  return name.replace(/\s*\((?:ble|bluetooth|serial|usb(?:\s*\/\s*serial)?|wired)\)\s*$/i, '').trim();
}

function getFamilyKey(definition: DeviceDefinitionSummary) {
  const manufacturer = definition.manufacturer.trim();
  const model = definition.model.trim();
  if (manufacturer || model) {
    return `${manufacturer.toLowerCase()}|${model.toLowerCase()}`;
  }

  return definition.id;
}

function getFamilyName(definitions: DeviceDefinitionSummary[]) {
  const baseNames = definitions.map((definition) => stripConnectionSuffix(definition.name)).filter((name) => name.length > 0);
  const firstName = baseNames[0];
  if (firstName && baseNames.every((name) => name.localeCompare(firstName, undefined, { sensitivity: 'accent' }) === 0)) {
    return firstName;
  }

  return stripConnectionSuffix(definitions.find((definition) => definition.transportType === 'serial')?.name ?? definitions[0]?.name ?? 'Device');
}

function buildDefinitionFamilies(definitions: DeviceDefinitionSummary[]) {
  const families = new Map<string, DeviceDefinitionSummary[]>();
  for (const definition of definitions) {
    const key = getFamilyKey(definition);
    const existing = families.get(key);
    if (existing) {
      existing.push(definition);
    } else {
      families.set(key, [definition]);
    }
  }

  return Array.from(families.entries())
    .map(([key, entries]) => {
      const definitionsForFamily = [...entries].sort((left, right) => {
        const transportDelta = getTransportSortOrder(left.transportType) - getTransportSortOrder(right.transportType);
        if (transportDelta !== 0) {
          return transportDelta;
        }

        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      });

      const primaryDefinition = definitionsForFamily[0];
      return {
        key,
        name: getFamilyName(definitionsForFamily),
        manufacturer: primaryDefinition?.manufacturer ?? '',
        model: primaryDefinition?.model ?? '',
        category: primaryDefinition?.category,
        description: primaryDefinition?.description,
        definitions: definitionsForFamily,
      } satisfies DeviceDefinitionFamily;
    })
    .sort((left, right) => {
      const nameDelta = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      if (nameDelta !== 0) {
        return nameDelta;
      }

      return left.key.localeCompare(right.key, undefined, { sensitivity: 'base' });
    });
}

function getFamilyForDefinition(definitionId: string, families: DeviceDefinitionFamily[]) {
  return families.find((family) => family.definitions.some((definition) => definition.id === definitionId)) ?? null;
}

const defaultDevice = (index: number, definition: DeviceDefinitionSummary, familyName?: string): DeviceConfiguration => ({
  deviceId: `device-${index}`,
  displayName: familyName ?? stripConnectionSuffix(definition.name),
  definitionId: definition.id,
  definitionVersion: null,
  transportPortName: '',
  bleSettingsPin: '',
  address: index,
  isMaster: false,
  pollIntervalMilliseconds: 1000,
  enabled: false,
});

function getTransportType(device: DeviceConfiguration, definitions: DeviceDefinitionSummary[]) {
  return definitions.find((definition) => definition.id === device.definitionId)?.transportType ?? null;
}

function getDefinition(device: DeviceConfiguration, definitions: DeviceDefinitionSummary[]) {
  return definitions.find((definition) => definition.id === device.definitionId) ?? null;
}

function requiresTransportIdentifier(device: DeviceConfiguration, definitions: DeviceDefinitionSummary[]) {
  const transportType = getTransportType(device, definitions);
  return transportType === 'serial' || transportType === 'ble';
}

function getActionResultClassName(result: StartStopResult) {
  if (result.outcome === 'Succeeded') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400';
  }

  if (result.stopped || result.outcome === 'Started') {
    return 'border-border bg-muted/60 text-foreground';
  }

  return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
}

function getActionResultMessage(result: StartStopResult) {
  const explicitMessage = result.message?.trim() ?? '';
  const blankFailureMessage = /^Device started but first poll failed:\s*$/i.test(explicitMessage);

  if (result.outcome === 'Started') {
    return 'Device start requested. Waiting for first poll result...';
  }

  if (explicitMessage && !blankFailureMessage) {
    return explicitMessage;
  }

  const error = result.error?.trim();
  if (result.started && error) {
    return `Device started but first poll failed: ${error}`;
  }

  if (result.started) {
    return 'Device started, but the first poll result is still pending.';
  }

  if (result.stopped) {
    return 'Device stopped.';
  }

  return error || 'Action completed.';
}

export function DevicesPage() {
  const { definitions: availableDefinitions, refresh: refreshDefinitions } = useDeviceDefinitions();
  const definitionFamilies = buildDefinitionFamilies(availableDefinitions);
  const [devices, setDevices] = useState<DeviceConfiguration[]>([]);
  const [ports, setPorts] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveDirty, setSaveDirty] = useState(0);
  const [bleScanResults, setBleScanResults] = useState<Record<string, BleScanDevice[]>>({});
  const [bleScanLoading, setBleScanLoading] = useState<Record<string, boolean>>({});
  const [bleScanErrors, setBleScanErrors] = useState<Record<string, string | null>>({});
  const definitionsRef = useRef<DeviceDefinitionSummary[]>([]);

  useEffect(() => {
    definitionsRef.current = availableDefinitions;
  }, [availableDefinitions]);
  const [deviceActions, setDeviceActions] = useState<Record<string, { loading: boolean; result?: StartStopResult }>>({});
  const devicesRef = useRef<DeviceConfiguration[]>([]);
  const initialLoadDone = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  devicesRef.current = devices;

  const loadPorts = useCallback(async () => {
    try {
      const response = await fetch('/api/devices/ports');
      if (!response.ok) return;
      const data = (await response.json()) as PortsResponse;
      setPorts(data.ports);
    } catch {
      // Ignore transient host errors.
    }
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch('/api/devices/config');
      if (!response.ok) throw new Error('Unable to load device configuration.');
      const data = (await response.json()) as DeviceConfigurationResponse;
      setDevices(data.devices);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load device configuration.');
    } finally {
      setIsLoading(false);
      window.setTimeout(() => {
        initialLoadDone.current = true;
      }, 200);
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void loadPorts();
  }, [loadDevices, loadPorts]);

  useEffect(() => {
    if (!showAddPicker) {
      return;
    }

    void refreshDefinitions({ includeRemote: true });
  }, [refreshDefinitions, showAddPicker]);

  const saveDevicesNow = useCallback(async (devicesToSave?: DeviceConfiguration[]) => {
    try {
      setAutoSaveStatus('saving');
      const response = await fetch('/api/devices/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: devicesToSave ?? devicesRef.current }),
      });

      if (!response.ok) {
        throw new Error('Unable to save device configuration.');
      }

      const data = (await response.json()) as DeviceConfigurationResponse;
      setDevices(data.devices);
      setAutoSaveStatus('saved');
      window.setTimeout(() => {
        setAutoSaveStatus((current) => current === 'saved' ? 'idle' : current);
      }, 2000);
    } catch {
      setAutoSaveStatus('error');
    }
  }, []);

  useEffect(() => {
    if (!initialLoadDone.current || saveDirty === 0) return;

    const timer = window.setTimeout(() => {
      void saveDevicesNow();
    }, 600);

    return () => window.clearTimeout(timer);
  }, [saveDirty, saveDevicesNow]);

  const markDirty = useCallback(() => {
    setSaveDirty((value) => value + 1);
  }, []);

  const updateDevice = useCallback(<K extends keyof DeviceConfiguration>(index: number, key: K, value: DeviceConfiguration[K]) => {
    setDevices((current) => current.map((device, deviceIndex) => {
      if (deviceIndex !== index) return device;
      return { ...device, [key]: value };
    }));
    markDirty();
  }, [markDirty]);

  const updateDeviceConnection = useCallback((index: number, nextDefinitionId: string) => {
    const nextDefinition = definitionsRef.current.find((entry) => entry.id === nextDefinitionId);
    if (!nextDefinition) {
      return;
    }

    const targetDeviceId = devicesRef.current[index]?.deviceId;
    const nextFamily = getFamilyForDefinition(nextDefinitionId, buildDefinitionFamilies(definitionsRef.current));

    setDevices((current) => current.map((device, deviceIndex) => {
      if (deviceIndex !== index) {
        return device;
      }

      const currentDefinition = definitionsRef.current.find((entry) => entry.id === device.definitionId);
      const currentTransportType = currentDefinition?.transportType ?? null;
      const nextTransportType = nextDefinition.transportType;
      const currentFamily = currentDefinition
        ? getFamilyForDefinition(currentDefinition.id, buildDefinitionFamilies(definitionsRef.current))
        : null;
      const shouldUseFamilyName = !device.displayName.trim()
        || device.displayName === (currentFamily?.name ?? '')
        || device.displayName === stripConnectionSuffix(currentDefinition?.name ?? '');

      return {
        ...device,
        displayName: shouldUseFamilyName ? (nextFamily?.name ?? stripConnectionSuffix(nextDefinition.name)) : device.displayName,
        definitionId: nextDefinition.id,
        definitionVersion: null,
        transportPortName: currentTransportType === nextTransportType ? (device.transportPortName ?? '') : '',
        bleSettingsPin: currentTransportType === 'ble' && nextTransportType === 'ble'
          ? (device.bleSettingsPin ?? '')
          : '',
      };
    }));

    if (targetDeviceId) {
      setBleScanResults((current) => {
        if (!(targetDeviceId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[targetDeviceId];
        return next;
      });
      setBleScanLoading((current) => {
        if (!(targetDeviceId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[targetDeviceId];
        return next;
      });
      setBleScanErrors((current) => {
        if (!(targetDeviceId in current)) {
          return current;
        }

        const next = { ...current };
        delete next[targetDeviceId];
        return next;
      });
    }

    markDirty();
  }, [markDirty]);

  const scanBleDevices = useCallback(async (deviceId: string, definitionId: string) => {
    setBleScanLoading((current) => ({ ...current, [deviceId]: true }));
    setBleScanErrors((current) => ({ ...current, [deviceId]: null }));

    try {
      const query = new URLSearchParams({ definitionId, timeoutMs: '6000' });
      const response = await fetch(`/api/devices/ble/scan?${query.toString()}`);
      const data = (await response.json()) as BleScanResponse;

      if (!response.ok) {
        throw new Error(data.error ?? 'Unable to scan for BLE devices.');
      }

      setBleScanResults((current) => ({ ...current, [deviceId]: data.devices }));
      setBleScanErrors((current) => ({ ...current, [deviceId]: data.error ?? null }));
    } catch (error) {
      setBleScanResults((current) => ({ ...current, [deviceId]: [] }));
      setBleScanErrors((current) => ({
        ...current,
        [deviceId]: error instanceof Error ? error.message : 'Unable to scan for BLE devices.',
      }));
    } finally {
      setBleScanLoading((current) => ({ ...current, [deviceId]: false }));
    }
  }, []);

  const addDeviceFromDefinition = useCallback((definitionId: string, explicitDefinition?: DeviceDefinitionSummary, familyName?: string) => {
    const definition = explicitDefinition ?? definitionsRef.current.find((entry) => entry.id === definitionId);
    if (!definition || !definition.isTransportSupported) return;

    setDevices((current) => [...current, defaultDevice(current.length + 1, definition, familyName)]);
    setShowAddPicker(false);
    setUploadError(null);
    markDirty();
  }, [markDirty]);

  const handleUploadDefinition = useCallback(async (file: File) => {
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/definitions/upload', { method: 'POST', body: formData });
      type DefinitionUploadResult = {
      id?: string;
      name?: string;
      manufacturer?: string;
      model?: string;
      category?: string;
      description?: string;
      transportType?: string;
      isTransportSupported?: boolean;
      unsupportedTransportMessage?: string | null;
      message?: string;
    };

    const data = (await response.json()) as DefinitionUploadResult;
      if (!response.ok) throw new Error(data.message ?? 'Upload failed.');
      await refreshDefinitions();
      if (data.id) {
        const summary: DeviceDefinitionSummary = {
          id: data.id,
          name: data.name ?? '',
          manufacturer: data.manufacturer ?? '',
          model: data.model ?? '',
          category: data.category,
          description: data.description,
          transportType: data.transportType ?? 'serial',
          isTransportSupported: data.isTransportSupported ?? true,
          unsupportedTransportMessage: data.unsupportedTransportMessage ?? null,
        };
        addDeviceFromDefinition(data.id, summary, stripConnectionSuffix(summary.name));
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed.');
    }
  }, [addDeviceFromDefinition, refreshDefinitions]);

  const removeDevice = useCallback((index: number) => {
    setDevices((current) => current.filter((_, deviceIndex) => deviceIndex !== index));
    markDirty();
  }, [markDirty]);

  const startDevice = useCallback(async (deviceId: string) => {
    setDeviceActions((current) => ({ ...current, [deviceId]: { loading: true } }));

    try {
      await saveDevicesNow();
      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/start`, { method: 'POST' });
      const data = (await response.json()) as StartStopResult;
      setDeviceActions((current) => ({ ...current, [deviceId]: { loading: false, result: data } }));
      setDevices((current) => current.map((device) => device.deviceId === deviceId ? { ...device, enabled: true } : device));
    } catch (error) {
      setDeviceActions((current) => ({
        ...current,
        [deviceId]: {
          loading: false,
          result: { deviceId, message: error instanceof Error ? error.message : 'Failed to start device.' },
        },
      }));
    }
  }, [saveDevicesNow]);

  const stopDevice = useCallback(async (deviceId: string) => {
    setDeviceActions((current) => ({ ...current, [deviceId]: { loading: true } }));

    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/stop`, { method: 'POST' });
      const data = (await response.json()) as StartStopResult;
      setDeviceActions((current) => ({ ...current, [deviceId]: { loading: false, result: data } }));
      setDevices((current) => current.map((device) => device.deviceId === deviceId ? { ...device, enabled: false } : device));
    } catch (error) {
      setDeviceActions((current) => ({
        ...current,
        [deviceId]: {
          loading: false,
          result: { deviceId, message: error instanceof Error ? error.message : 'Failed to stop device.' },
        },
      }));
    }
  }, []);

  return (
    <div className='mx-auto max-w-6xl space-y-6 pb-12'>
      <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
        <div>
          <h2 className='text-3xl font-bold tracking-tight text-foreground'>Devices</h2>
          <p className='mt-2 text-sm text-muted-foreground'>
            Add devices from the library or upload a definition JSON. Each device stores a local copy of its definition.
          </p>
        </div>
        <div className='flex items-center gap-3'>
          {autoSaveStatus === 'saving' ? <span className='flex items-center gap-1.5 text-xs text-muted-foreground'><LoaderCircle className='h-3 w-3 animate-spin' /> Saving...</span> : null}
          {autoSaveStatus === 'saved' ? <span className='flex items-center gap-1.5 text-xs text-emerald-500'><Check className='h-3 w-3' /> Saved</span> : null}
          {autoSaveStatus === 'error' ? <span className='text-xs text-destructive'>Save failed</span> : null}
        </div>
      </div>

      <div className='flex flex-wrap gap-3'>
        <Button type='button' variant='outline' size='lg' onClick={() => setShowAddPicker(true)}>
          <Plus className='h-4 w-4' />
          Add device
        </Button>
      </div>

      {showAddPicker ? (
        <div className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
          <div className='mb-4 flex items-center justify-between'>
            <h3 className='text-lg font-semibold text-foreground'>Add a new device</h3>
            <Button type='button' variant='ghost' size='sm' onClick={() => { setShowAddPicker(false); setUploadError(null); }}>
              <X className='h-4 w-4' />
            </Button>
          </div>

          <div className='mb-4'>
            <span className='mb-3 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>From device library</span>
            <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
              {definitionFamilies.map((family) => {
                const supportedConnections = family.definitions.filter((definition) => definition.isTransportSupported);

                return (
                  <div key={family.key} className='rounded-xl border border-border bg-muted/30 p-4'>
                    <div className='space-y-1'>
                      <span className='text-sm font-semibold text-foreground'>{family.name}</span>
                      <span className='block text-xs text-muted-foreground'>{family.manufacturer} · {family.model}</span>
                      {family.description ? <span className='block text-xs text-muted-foreground/80'>{family.description}</span> : null}
                    </div>

                    <div className='mt-4 space-y-2'>
                      <span className='block text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>Connection</span>
                      <div className='flex flex-wrap gap-2'>
                        {family.definitions.map((definition) => {
                          const connectionLabel = getConnectionLabel(definition.transportType);
                          return (
                            <button
                              key={definition.id}
                              type='button'
                              aria-label={`Add ${family.name} using ${connectionLabel}`}
                              className={cn(
                                'rounded-lg border px-3 py-2 text-sm transition',
                                definition.isTransportSupported
                                  ? 'border-border bg-background hover:border-primary/50 hover:bg-muted/60'
                                  : 'cursor-not-allowed border-amber-500/30 bg-amber-500/10 text-amber-700 opacity-70 dark:text-amber-300',
                              )}
                              disabled={!definition.isTransportSupported}
                              onClick={() => addDeviceFromDefinition(definition.id, definition, family.name)}
                            >
                              {connectionLabel}
                            </button>
                          );
                        })}
                      </div>
                      {supportedConnections.length === 0 ? (
                        <span className='block text-[11px] text-amber-700 dark:text-amber-300'>
                          {family.definitions[0]?.unsupportedTransportMessage ?? 'This device is not supported in the current build.'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <span className='mb-3 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Upload definition JSON</span>
            <input
              ref={fileInputRef}
              type='file'
              accept='.json'
              className='hidden'
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleUploadDefinition(file);
                event.target.value = '';
              }}
            />
            <Button type='button' variant='outline' onClick={() => fileInputRef.current?.click()}>
              <Upload className='h-4 w-4' />
              Browse for .json file
            </Button>
            {uploadError ? <div className='mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'>{uploadError}</div> : null}
          </div>
        </div>
      ) : null}

      {loadError ? <div className='rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>{loadError}</div> : null}
      {isLoading ? <div className='flex min-h-64 items-center justify-center rounded-2xl border border-border bg-card/60'><LoaderCircle className='h-6 w-6 animate-spin text-primary' /></div> : null}

      {!isLoading ? (
        <div className='space-y-4'>
          {devices.map((device, index) => {
            const definition = getDefinition(device, availableDefinitions);
            const definitionFamily = getFamilyForDefinition(device.definitionId, definitionFamilies);
            const connectionChoices = definitionFamily?.definitions ?? (definition ? [definition] : []);
            const transportType = getTransportType(device, availableDefinitions);
            const isTransportSupported = definition?.isTransportSupported ?? false;
            const requiresTransport = requiresTransportIdentifier(device, availableDefinitions);
            const hasTransportTarget = !requiresTransport || Boolean(device.transportPortName?.trim());
            const action = deviceActions[device.deviceId];
            const bleDevices = bleScanResults[device.deviceId] ?? [];
            const bleIsScanning = bleScanLoading[device.deviceId] ?? false;
            const bleScanError = bleScanErrors[device.deviceId];

            return (
              <section key={`${device.deviceId}-${index}`} className='rounded-2xl border border-border bg-card/85 p-5 shadow-sm'>
                <div className='mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between'>
                  <div className='space-y-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <h3 className='text-lg font-semibold text-foreground'>{device.displayName || device.deviceId}</h3>
                      {transportType ? <span className='rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>{getConnectionLabel(transportType)}</span> : null}
                      {device.definitionVersion ? <span className='rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>v{device.definitionVersion}</span> : null}
                    </div>
                    <div className='text-sm text-muted-foreground'>
                      {definition ? `${definition.manufacturer} · ${definition.model}` : device.deviceId}
                    </div>
                    <div className='text-xs text-muted-foreground/70'>
                      Connection: {getConnectionLabel(transportType)}
                    </div>
                  </div>

                  <div className='flex flex-wrap gap-2'>
                    {device.enabled ? (
                      <Button type='button' variant='outline' onClick={() => void stopDevice(device.deviceId)} disabled={action?.loading}>
                        {action?.loading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Square className='h-4 w-4' />}
                        Stop
                      </Button>
                    ) : (
                      <Button
                        type='button'
                        variant='outline'
                        onClick={() => void startDevice(device.deviceId)}
                        disabled={action?.loading || !device.deviceId || !isTransportSupported || !hasTransportTarget}
                      >
                        {action?.loading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Play className='h-4 w-4' />}
                        {isTransportSupported ? 'Start' : 'Unsupported'}
                      </Button>
                    )}
                    <Button type='button' variant='destructive' onClick={() => removeDevice(index)} disabled={device.enabled}>
                      <Trash2 className='h-4 w-4' />
                      Remove
                    </Button>
                  </div>
                </div>

                {action?.result ? <div className={`mb-4 rounded-lg border px-4 py-3 text-sm ${getActionResultClassName(action.result)}`}>{getActionResultMessage(action.result)}</div> : null}
                {!isTransportSupported ? <div className='mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300'>{definition?.unsupportedTransportMessage ?? 'This device transport is not supported in the current build.'}</div> : null}
                {isTransportSupported && requiresTransport && !hasTransportTarget ? (
                  <div className='mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300'>
                    {transportType === 'ble'
                      ? 'Scan and choose a nearby BLE device, or enter the MAC address or alias before starting this device.'
                      : 'Select the serial port before starting this device.'}
                  </div>
                ) : null}

                <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
                  <div className='space-y-2 text-sm text-foreground'>
                    <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Device ID</span>
                    <Input value={device.deviceId} disabled={device.enabled} onChange={(event) => updateDevice(index, 'deviceId', event.target.value)} />
                    <p className='text-[11px] text-muted-foreground'>Use the same ID to reconnect to historical readings after re-adding a device.</p>
                  </div>

                  <label className='space-y-2 text-sm text-foreground'>
                    <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Display name</span>
                    <Input value={device.displayName} onChange={(event) => updateDevice(index, 'displayName', event.target.value)} />
                  </label>

                  <label className='space-y-2 text-sm text-foreground'>
                    <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Connection</span>
                    <select
                      className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                      value={device.definitionId}
                      disabled={device.enabled || connectionChoices.length <= 1}
                      onChange={(event) => updateDeviceConnection(index, event.target.value)}
                    >
                      {connectionChoices.map((entry) => (
                        <option key={entry.id} value={entry.id}>{getConnectionLabel(entry.transportType)}</option>
                      ))}
                    </select>
                  </label>

                  <label className='space-y-2 text-sm text-foreground'>
                    <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Poll interval</span>
                    <Input value={`${device.pollIntervalMilliseconds} ms`} disabled />
                  </label>

                  {transportType === 'serial' ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Serial port</span>
                      <select
                        className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                        value={device.transportPortName ?? ''}
                        disabled={device.enabled}
                        onChange={(event) => updateDevice(index, 'transportPortName', event.target.value || null)}
                      >
                        <option value=''>Select port…</option>
                        {ports.map((port) => <option key={port} value={port}>{port}</option>)}
                      </select>
                    </label>
                  ) : null}

                  {transportType === 'ble' ? (
                    <>
                      <div className='space-y-2 text-sm text-foreground md:col-span-2 xl:col-span-3'>
                        <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>BLE device</span>
                        <div className='flex flex-col gap-2 xl:flex-row'>
                          <Input
                            className='flex-1'
                            value={device.transportPortName ?? ''}
                            disabled={device.enabled}
                            placeholder='AA:BB:CC:DD:EE:FF or device alias'
                            onChange={(event) => updateDevice(index, 'transportPortName', event.target.value || null)}
                          />
                          <Button
                            type='button'
                            variant='outline'
                            className='shrink-0'
                            disabled={device.enabled || bleIsScanning || !device.definitionId}
                            onClick={() => void scanBleDevices(device.deviceId, device.definitionId)}
                          >
                            {bleIsScanning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : null}
                            {bleIsScanning ? 'Scanning...' : 'Scan nearby'}
                          </Button>
                        </div>
                        <p className='text-xs text-muted-foreground'>Scan on the Pi and choose a detected device, or enter the address manually.</p>
                        {bleScanError ? <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300'>{bleScanError}</div> : null}
                        {bleDevices.length > 0 ? (
                          <div className='space-y-2'>
                            {bleDevices.map((candidate) => {
                              const isSelected = candidate.address === (device.transportPortName ?? '');
                              return (
                                <button
                                  key={candidate.address}
                                  type='button'
                                  aria-label={`Select BLE device ${candidate.address}`}
                                  disabled={device.enabled || bleIsScanning}
                                  onClick={() => updateDevice(index, 'transportPortName', candidate.address)}
                                  className={cn(
                                    'w-full rounded-xl border px-3 py-3 text-left transition',
                                    isSelected
                                      ? 'border-primary/50 bg-primary/10'
                                      : 'border-border bg-muted/20 hover:border-primary/30 hover:bg-muted/40',
                                  )}
                                >
                                  <div className='flex items-start justify-between gap-3'>
                                    <div className='space-y-1'>
                                      <div className='flex flex-wrap items-center gap-2'>
                                        <div className='text-sm font-semibold text-foreground'>{candidate.displayName}</div>
                                        {candidate.isDefinitionVerified ? <span className='rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-500'>{candidate.verificationLabel ?? 'Verified'}</span> : null}
                                        {candidate.rssi != null ? <span className='rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>{candidate.rssi} dBm</span> : null}
                                      </div>
                                      <div className='font-mono text-xs text-muted-foreground'>{candidate.address}</div>
                                      {candidate.alias && candidate.name && candidate.alias !== candidate.name ? (
                                        <div className='text-xs text-muted-foreground'>Alias: {candidate.alias} · Name: {candidate.name}</div>
                                      ) : null}
                                      {candidate.verificationDetails ? <div className='text-xs text-muted-foreground'>{candidate.verificationDetails}</div> : null}
                                      {candidate.manufacturerData.length > 0 ? <div className='text-xs text-muted-foreground'>Manufacturer data: {candidate.manufacturerData.join(' · ')}</div> : null}
                                    </div>
                                    {isSelected ? <span className='rounded-full border border-primary/40 bg-primary/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary'>Selected</span> : null}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>

                      <label className='space-y-2 text-sm text-foreground'>
                        <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>BLE settings PIN</span>
                        <Input
                          value={device.bleSettingsPin ?? ''}
                          disabled={device.enabled}
                          placeholder='Optional'
                          onChange={(event) => updateDevice(index, 'bleSettingsPin', event.target.value || null)}
                        />
                      </label>
                    </>
                  ) : null}

                  {transportType !== 'ble' ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Address</span>
                      <Input
                        type='number'
                        min={0}
                        max={255}
                        value={device.address}
                        disabled={device.enabled}
                        onChange={(event) => updateDevice(index, 'address', Number(event.target.value))}
                      />
                    </label>
                  ) : null}
                </div>
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
      ) : null}
    </div>
  );
}
