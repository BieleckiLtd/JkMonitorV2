import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDown, ArrowUp, Battery, Check, Droplets, LoaderCircle, Play, Plus, RotateCcw, Square, Thermometer, Trash2, Upload, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useDeviceDefinitions } from '../hooks/useDeviceDefinition';
import { cn } from '../lib/utils';
import type { DeviceDefinition, DeviceDefinitionSummary } from '../types/deviceDefinition';

type DisplayPrecision = {
  voltage: number;
  cellVoltage: number;
  current: number;
  power: number;
  temperature: number;
  soc: number;
  deltaVoltage: number;
};

type DeviceConfigurationWire = {
  persistedId?: number | null;
  deviceId: string;
  displayName: string;
  sortOrder?: number;
  definitionId: string;
  definitionVersion?: string | null;
  transportPortName?: string | null;
  bleSettingsPin?: string | null;
  address: number;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  enabled: boolean;
  cellVoltageSmoothingFactor: number;
  cellVoltageSmoothingBreakoutMillivolts: number;
  displayPrecision?: DisplayPrecision | null;
  temperatureUnit?: string | null;
  hasDefinitionOverride?: boolean;
  definition?: DeviceDefinition | null;
};

type DeviceConfiguration = DeviceConfigurationWire & {
  clientKey: string;
  displayPrecision: DisplayPrecision;
  temperatureUnit: string;
  hasDefinitionOverride: boolean;
  definition: DeviceDefinition | null;
};

type DeviceConfigurationResponse = {
  devices: DeviceConfigurationWire[];
  rememberedDeviceIds?: string[];
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
  lastSeenAt?: string | null;
  signalStrengthPercent?: number | null;
  temperatureCelsius?: number | null;
  humidityPercent?: number | null;
  batteryPercent?: number | null;
};

type BleScanResponse = {
  devices: BleScanDevice[];
  error?: string;
};

type LibraryBleSelection = {
  definition: DeviceDefinitionSummary;
  familyName: string;
};

type StartStopResult = {
  deviceId: string;
  started?: boolean;
  stopped?: boolean;
  outcome?: string;
  error?: string | null;
  message: string;
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

type PrimitiveEditorValue = string | number | boolean | null | undefined;

type SaveFieldTarget = {
  deviceClientKey: string;
  fieldKey: string;
};

const catalogDefinitionCache = new Map<string, DeviceDefinition>();
let nextDeviceClientKey = 0;
const defaultDisplayPrecision: DisplayPrecision = {
  voltage: 2,
  cellVoltage: 3,
  current: 1,
  power: 0,
  temperature: 1,
  soc: 0,
  deltaVoltage: 3,
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

function compareNullableStrings(left: string | null | undefined, right: string | null | undefined) {
  const normalizedLeft = left?.trim() ?? '';
  const normalizedRight = right?.trim() ?? '';
  if (!normalizedLeft && !normalizedRight) return 0;
  if (!normalizedLeft) return 1;
  if (!normalizedRight) return -1;
  return normalizedLeft.localeCompare(normalizedRight, undefined, { sensitivity: 'base' });
}

function sortBleScanDevices(devices: BleScanDevice[]) {
  return [...devices].sort((left, right) => {
    if (left.isDefinitionVerified !== right.isDefinitionVerified) {
      return Number(right.isDefinitionVerified) - Number(left.isDefinitionVerified);
    }

    if (left.isConnected !== right.isConnected) {
      return Number(right.isConnected) - Number(left.isConnected);
    }

    const leftRssi = left.rssi ?? Number.NEGATIVE_INFINITY;
    const rightRssi = right.rssi ?? Number.NEGATIVE_INFINITY;
    if (leftRssi !== rightRssi) {
      return rightRssi - leftRssi;
    }

    const displayNameComparison = compareNullableStrings(left.displayName, right.displayName);
    if (displayNameComparison !== 0) {
      return displayNameComparison;
    }

    return compareNullableStrings(left.address, right.address);
  });
}

function mergeBleScanDevices(current: BleScanDevice[], incoming: BleScanDevice[]) {
  const merged = new Map<string, BleScanDevice>();
  for (const candidate of current) {
    merged.set(candidate.address, candidate);
  }

  for (const candidate of incoming) {
    merged.set(candidate.address, candidate);
  }

  return sortBleScanDevices([...merged.values()]);
}

function normalizeBleIdentifier(value: string | null | undefined) {
  return (value ?? '')
    .trim()
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase();
}

function getAssignedBleTargets(
  devices: DeviceConfiguration[],
  definitionId: string,
  excludeClientKey?: string,
) {
  const assigned = new Set<string>();
  for (const device of devices) {
    if (device.clientKey === excludeClientKey) {
      continue;
    }

    if (device.definitionId !== definitionId) {
      continue;
    }

    const normalized = normalizeBleIdentifier(device.transportPortName);
    if (normalized) {
      assigned.add(normalized);
    }
  }

  return assigned;
}

function filterAssignedBleCandidates(
  candidates: BleScanDevice[],
  assignedTargets: Set<string>,
) {
  return candidates.filter((candidate) => !assignedTargets.has(normalizeBleIdentifier(candidate.address)));
}

function formatPreviewValue(value: number | null | undefined, digits = 0, suffix = '') {
  if (value == null || Number.isNaN(value)) {
    return 'N/A';
  }

  return `${value.toFixed(digits)}${suffix}`;
}

function formatRelativeSeen(lastSeenAt: string | null | undefined, nowMs: number) {
  if (!lastSeenAt) {
    return 'Not seen yet';
  }

  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs)) {
    return 'Seen recently';
  }

  const deltaSeconds = Math.max(0, Math.round((nowMs - lastSeenMs) / 1000));
  return deltaSeconds <= 1 ? 'Seen just now' : `Seen ${deltaSeconds}s ago`;
}

function getBatteryTone(batteryPercent: number | null | undefined) {
  if (batteryPercent == null) {
    return 'text-muted-foreground';
  }

  if (batteryPercent <= 15) {
    return 'text-rose-500';
  }

  if (batteryPercent <= 35) {
    return 'text-amber-500';
  }

  return 'text-emerald-500';
}

function BleCandidateCard({
  candidate,
  selected,
  onClick,
  actionLabel,
  disabled = false,
  nowMs,
}: {
  candidate: BleScanDevice;
  selected: boolean;
  onClick: () => void;
  actionLabel: string;
  disabled?: boolean;
  nowMs: number;
}) {
  return (
    <button
      type='button'
      aria-label={`Select BLE device ${candidate.address}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'w-full rounded-xl border px-3 py-3 text-left transition',
        selected
          ? 'border-primary/50 bg-primary/10'
          : 'border-border bg-muted/20 hover:border-primary/30 hover:bg-muted/40',
        disabled ? 'cursor-not-allowed opacity-80' : undefined,
      )}
    >
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0 space-y-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <div className='text-sm font-semibold text-foreground'>{candidate.displayName}</div>
            {candidate.isDefinitionVerified ? <span className='rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-500'>{candidate.verificationLabel ?? 'Matched'}</span> : null}
            {candidate.rssi != null ? <span className='rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>{candidate.rssi} dBm</span> : null}
          </div>
          <div className='font-mono text-xs text-muted-foreground'>{candidate.address}</div>
          {candidate.alias && candidate.name && candidate.alias !== candidate.name ? (
            <div className='text-xs text-muted-foreground'>Alias: {candidate.alias} · Name: {candidate.name}</div>
          ) : null}
          <div className='grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4'>
            <div className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2'>
              <Thermometer className='h-3.5 w-3.5 text-orange-500' />
              <span>{formatPreviewValue(candidate.temperatureCelsius, 1, '°C')}</span>
            </div>
            <div className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2'>
              <Droplets className='h-3.5 w-3.5 text-sky-500' />
              <span>{formatPreviewValue(candidate.humidityPercent, 1, '%')}</span>
            </div>
            <div className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-2'>
              <Battery className={cn('h-3.5 w-3.5', getBatteryTone(candidate.batteryPercent))} />
              <span>{formatPreviewValue(candidate.batteryPercent, 0, '%')}</span>
            </div>
            <div className='rounded-lg border border-border/70 bg-background/60 px-2.5 py-2'>
              <div className='font-medium text-foreground'>Signal {formatPreviewValue(candidate.signalStrengthPercent, 0, '%')}</div>
              <div className='mt-0.5 text-[11px] text-muted-foreground'>{formatRelativeSeen(candidate.lastSeenAt, nowMs)}</div>
            </div>
          </div>
        </div>
        <span className={cn(
          'rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.18em]',
          selected
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border bg-background/70 text-muted-foreground',
        )}>
          {actionLabel}
        </span>
      </div>
    </button>
  );
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

function createDeviceClientKey() {
  nextDeviceClientKey += 1;
  return `device-${nextDeviceClientKey}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const serialTransportKeys = new Set(['baudRate', 'dataBits', 'parity', 'stopBits', 'readTimeoutMs', 'writeTimeoutMs']);
const bleTransportKeys = new Set(['serviceUuid', 'notifyCharacteristicUuid', 'writeCharacteristicUuid', 'connectionTimeoutMs', 'reconnectDelayMs']);

function filterTransportDefaults(defaults: Record<string, unknown> | undefined, transportType: string | null): Record<string, unknown> | undefined {
  if (!defaults || !isObjectRecord(defaults)) return defaults;
  const allowedKeys = transportType === 'ble' ? bleTransportKeys : transportType === 'serial' ? serialTransportKeys : null;
  if (!allowedKeys) return defaults;
  const filtered = Object.fromEntries(Object.entries(defaults).filter(([key]) => allowedKeys.has(key)));
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function humanizeKey(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\bUuid\b/g, 'UUID')
    .replace(/\bId\b/g, 'ID')
    .replace(/\bMs\b/g, 'ms')
    .replace(/^./, (character) => character.toUpperCase());
}

function getDefinitionPollInterval(definition: DeviceDefinition | null | undefined, fallback = 1000) {
  if (!definition) {
    return fallback;
  }

  const intervals = Object.values(definition.pollGroups ?? {})
    .map((group) => group.intervalMs)
    .filter((intervalMs) => intervalMs > 0);
  return intervals.length > 0 ? Math.min(...intervals) : fallback;
}

function setNestedValue(source: unknown, path: string[], nextValue: unknown): unknown {
  if (path.length === 0) {
    return nextValue;
  }

  const [segment, ...rest] = path;
  const current = isObjectRecord(source) ? source : {};
  return {
    ...current,
    [segment]: rest.length === 0
      ? nextValue
      : setNestedValue(current[segment], rest, nextValue),
  };
}

function parseArrayInput(rawValue: string, currentValue: unknown[], path: string[]) {
  const parts = rawValue
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const expectsNumbers = currentValue.some((entry) => typeof entry === 'number')
    || /preamble/i.test(path[path.length - 1] ?? '');
  if (!expectsNumbers) {
    return parts;
  }

  return parts
    .map((part) => Number(part))
    .filter((entry) => Number.isFinite(entry));
}

function areEditorValuesEqual(left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
  }

  return left === right;
}

function parsePrimitiveInput(rawValue: string, currentValue: PrimitiveEditorValue) {
  if (typeof currentValue !== 'number') {
    return rawValue;
  }

  const parsed = Number(rawValue || '0');
  return Number.isFinite(parsed) ? parsed : currentValue;
}

function getEditorInputValue(value: PrimitiveEditorValue) {
  if (value == null) {
    return '';
  }

  return String(value);
}

function mergeDeviceConfigurations(
  incomingDevices: DeviceConfigurationWire[],
  previousDevices: DeviceConfiguration[],
) {
  const previousKeysByPersistedId = new Map<number, string>();
  const previousKeysByDeviceId = new Map<string, string>();

  for (const device of previousDevices) {
    if (device.persistedId != null) {
      previousKeysByPersistedId.set(device.persistedId, device.clientKey);
    }

    previousKeysByDeviceId.set(device.deviceId.toLowerCase(), device.clientKey);
  }

  return incomingDevices.map((device, index) => {
    const clientKey = device.persistedId != null
      ? (previousKeysByPersistedId.get(device.persistedId) ?? previousKeysByDeviceId.get(device.deviceId.toLowerCase()) ?? createDeviceClientKey())
      : (previousKeysByDeviceId.get(device.deviceId.toLowerCase()) ?? createDeviceClientKey());

    return {
      clientKey,
      persistedId: device.persistedId ?? null,
      deviceId: device.deviceId,
      displayName: device.displayName,
      sortOrder: device.sortOrder ?? index,
      definitionId: device.definitionId,
      definitionVersion: device.definitionVersion ?? null,
      transportPortName: device.transportPortName ?? '',
      bleSettingsPin: device.bleSettingsPin ?? '',
      address: device.address,
      isMaster: device.isMaster,
      pollIntervalMilliseconds: device.pollIntervalMilliseconds,
      enabled: device.enabled,
      cellVoltageSmoothingFactor: device.cellVoltageSmoothingFactor ?? 0,
      cellVoltageSmoothingBreakoutMillivolts: device.cellVoltageSmoothingBreakoutMillivolts ?? 0,
      displayPrecision: device.displayPrecision ?? defaultDisplayPrecision,
      temperatureUnit: device.temperatureUnit ?? 'c',
      hasDefinitionOverride: device.hasDefinitionOverride ?? false,
      definition: device.definition ?? catalogDefinitionCache.get(device.definitionId) ?? null,
    } satisfies DeviceConfiguration;
  });
}

function serializeDevice(device: DeviceConfiguration): DeviceConfigurationWire {
  return {
    persistedId: device.persistedId ?? null,
    deviceId: device.deviceId,
    displayName: device.displayName,
    sortOrder: device.sortOrder ?? 0,
    definitionId: device.definitionId,
    definitionVersion: device.definitionVersion ?? null,
    transportPortName: device.transportPortName?.trim() ? device.transportPortName.trim() : null,
    bleSettingsPin: device.bleSettingsPin?.trim() ? device.bleSettingsPin.trim() : null,
    address: device.address,
    isMaster: device.isMaster,
    pollIntervalMilliseconds: getDefinitionPollInterval(device.definition, device.pollIntervalMilliseconds),
    enabled: device.enabled,
    cellVoltageSmoothingFactor: device.cellVoltageSmoothingFactor,
    cellVoltageSmoothingBreakoutMillivolts: device.cellVoltageSmoothingBreakoutMillivolts,
    displayPrecision: device.displayPrecision,
    temperatureUnit: device.temperatureUnit,
    hasDefinitionOverride: device.hasDefinitionOverride,
    definition: device.definition,
  };
}

function getAvailableRememberedDeviceIds(
  devices: DeviceConfiguration[],
  rememberedDeviceIds: string[],
  currentClientKey: string,
) {
  const usedByOtherDevices = new Set(
    devices
      .filter((device) => device.clientKey !== currentClientKey)
      .map((device) => device.deviceId.trim().toLowerCase())
      .filter((deviceId) => deviceId.length > 0),
  );

  return rememberedDeviceIds.filter((deviceId, index, allDeviceIds) => {
    const normalizedDeviceId = deviceId.trim();
    if (!normalizedDeviceId) {
      return false;
    }

    const normalizedKey = normalizedDeviceId.toLowerCase();
    return !usedByOtherDevices.has(normalizedKey)
      && allDeviceIds.findIndex((entry) => entry.trim().toLowerCase() === normalizedKey) === index;
  });
}

function normalizeDeviceId(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

function getDuplicateDeviceIdClientKeys(devices: DeviceConfiguration[]) {
  const clientKeysByDeviceId = new Map<string, string[]>();

  for (const device of devices) {
    const normalizedDeviceId = normalizeDeviceId(device.deviceId);
    if (!normalizedDeviceId) {
      continue;
    }

    const clientKeys = clientKeysByDeviceId.get(normalizedDeviceId) ?? [];
    clientKeys.push(device.clientKey);
    clientKeysByDeviceId.set(normalizedDeviceId, clientKeys);
  }

  const duplicateClientKeys = new Set<string>();
  for (const clientKeys of clientKeysByDeviceId.values()) {
    if (clientKeys.length < 2) {
      continue;
    }

    for (const clientKey of clientKeys) {
      duplicateClientKeys.add(clientKey);
    }
  }

  return duplicateClientKeys;
}

function createDefaultDeviceId(_index: number, devices: DeviceConfiguration[]) {
  const existingIds = new Set(devices.map((device) => normalizeDeviceId(device.deviceId)).filter((entry) => entry.length > 0));
  let nextIndex = 1;
  let candidate = `device-${nextIndex}`;

  while (existingIds.has(candidate)) {
    nextIndex += 1;
    candidate = `device-${nextIndex}`;
  }

  return candidate;
}

const defaultDevice = (
  index: number,
  definition: DeviceDefinitionSummary,
  definitionSnapshot: DeviceDefinition,
  devices: DeviceConfiguration[],
  familyName?: string,
): DeviceConfiguration => ({
  clientKey: createDeviceClientKey(),
  persistedId: null,
  deviceId: createDefaultDeviceId(index, devices),
  displayName: familyName ?? stripConnectionSuffix(definition.name),
  sortOrder: index - 1,
  definitionId: definition.id,
  definitionVersion: definitionSnapshot.version,
  transportPortName: '',
  bleSettingsPin: '',
  address: index,
  isMaster: false,
  pollIntervalMilliseconds: getDefinitionPollInterval(definitionSnapshot, 1000),
  enabled: false,
  cellVoltageSmoothingFactor: 0,
  cellVoltageSmoothingBreakoutMillivolts: 0,
  displayPrecision: defaultDisplayPrecision,
  temperatureUnit: 'c',
  hasDefinitionOverride: false,
  definition: definitionSnapshot,
});

function slugifyDeviceId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'device';
}

function createUniqueDeviceId(base: string, devices: DeviceConfiguration[]) {
  const existingIds = new Set(devices.map((device) => device.deviceId.trim().toLowerCase()).filter((entry) => entry.length > 0));
  let candidate = base;
  let suffix = 2;

  while (existingIds.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function createBleDeviceFromCandidate(
  definition: DeviceDefinitionSummary,
  definitionSnapshot: DeviceDefinition,
  candidate: BleScanDevice,
  devices: DeviceConfiguration[],
  familyName?: string,
) {
  const addressSuffix = candidate.address.replace(/[^A-Fa-f0-9]/g, '').slice(-4).toLowerCase();
  const preferredId = slugifyDeviceId(`${familyName ?? stripConnectionSuffix(definition.name)}-${candidate.displayName || addressSuffix}`);
  const deviceId = createUniqueDeviceId(preferredId, devices);

  return {
    ...defaultDevice(devices.length + 1, definition, definitionSnapshot, devices, familyName),
    deviceId,
    displayName: candidate.displayName || familyName || stripConnectionSuffix(definition.name),
    transportPortName: candidate.address,
  } satisfies DeviceConfiguration;
}

function getTransportType(device: DeviceConfiguration, definitions: DeviceDefinitionSummary[]) {
  return device.definition?.connection.transport.type
    ?? definitions.find((definition) => definition.id === device.definitionId)?.transportType
    ?? null;
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

  if (result.stopped || result.outcome === 'Started' || result.outcome === 'Listening') {
    return 'border-border bg-muted/60 text-foreground';
  }

  return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
}

function getActionResultMessage(result: StartStopResult) {
  const explicitMessage = result.message?.trim() ?? '';
  const blankFailureMessage = /^Device started but first poll failed:\s*$/i.test(explicitMessage);

  if (result.outcome === 'Listening') {
    return explicitMessage || 'Device started and listening for broadcast updates.';
  }

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

type DefinitionEditorInputProps = {
  fieldKey: string;
  label: string;
  disabled: boolean;
  path: string[];
  value: PrimitiveEditorValue | unknown[];
  onCommit: (path: string[], nextValue: unknown) => void;
  renderSaveState: (fieldKey: string) => ReactNode;
  helperText?: string;
};

function DefinitionEditorTextInput({
  fieldKey,
  label,
  disabled,
  path,
  value,
  onCommit,
  renderSaveState,
  helperText,
}: DefinitionEditorInputProps) {
  const initialValue = Array.isArray(value)
    ? value.join(', ')
    : getEditorInputValue(value as PrimitiveEditorValue);
  const [draftValue, setDraftValue] = useState(initialValue);

  useEffect(() => {
    setDraftValue(initialValue);
  }, [initialValue]);

  const commitValue = useCallback(() => {
    const nextValue = Array.isArray(value)
      ? parseArrayInput(draftValue, value, path)
      : parsePrimitiveInput(draftValue, value as PrimitiveEditorValue);

    if (!areEditorValuesEqual(nextValue, value)) {
      onCommit(path, nextValue);
    }
  }, [draftValue, onCommit, path, value]);

  return (
    <label key={fieldKey} className='min-w-0 space-y-2 text-sm text-foreground'>
      <div className='flex min-w-0 items-center justify-between gap-2'>
        <span className='block min-w-0 text-xs font-medium uppercase tracking-[0.18em] leading-snug text-muted-foreground'>{label}</span>
        {renderSaveState(fieldKey)}
      </div>
      <Input
        type={typeof value === 'number' ? 'number' : 'text'}
        step={typeof value === 'number' ? 'any' : undefined}
        value={draftValue}
        disabled={disabled}
        onChange={(event) => setDraftValue(event.target.value)}
        onBlur={commitValue}
      />
      {helperText ? <p className='text-[11px] text-muted-foreground'>{helperText}</p> : null}
    </label>
  );
}

function renderDefinitionEditorFields(
  value: Record<string, unknown>,
  path: string[],
  disabled: boolean,
  onChange: (path: string[], nextValue: unknown) => void,
  renderSaveState: (fieldKey: string) => ReactNode,
  depth = 0,
): ReactNode {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => {
      const fieldPath = [...path, key];
      const fieldKey = fieldPath.join('.');
      const label = humanizeKey(key);

      if (Array.isArray(entry)) {
        return (
          <DefinitionEditorTextInput
            key={fieldKey}
            fieldKey={fieldKey}
            label={label}
            disabled={disabled}
            path={fieldPath}
            value={entry}
            onCommit={onChange}
            renderSaveState={renderSaveState}
            helperText='Comma-separated values.'
          />
        );
      }

      if (isObjectRecord(entry)) {
        return (
          <div
            key={fieldKey}
            className={cn(
              'space-y-3 rounded-xl border border-border/70 bg-background/60 p-4',
              depth === 0 ? 'md:col-span-2 xl:col-span-2' : 'md:col-span-2 xl:col-span-4',
            )}
          >
            <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>{humanizeKey(key)}</div>
            <div className='grid gap-3 sm:grid-cols-2'>
              {renderDefinitionEditorFields(entry, fieldPath, disabled, onChange, renderSaveState, depth + 1)}
            </div>
          </div>
        );
      }

      if (typeof entry === 'boolean') {
        return (
          <label key={fieldKey} className='flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-background/60 px-4 py-3 text-sm text-foreground'>
            <span className='flex items-center gap-2'>
              <span>{humanizeKey(key)}</span>
              {renderSaveState(fieldKey)}
            </span>
            <input
              type='checkbox'
              checked={entry}
              disabled={disabled}
              onChange={(event) => onChange(fieldPath, event.target.checked)}
            />
          </label>
        );
      }

      return (
        <DefinitionEditorTextInput
          key={fieldKey}
          fieldKey={fieldKey}
          label={label}
          disabled={disabled}
          path={fieldPath}
          value={entry as PrimitiveEditorValue}
          onCommit={onChange}
          renderSaveState={renderSaveState}
        />
      );
    });
}

export function DevicesPage({
  initialShowAddPicker = false,
  selectedDeviceId,
}: {
  initialShowAddPicker?: boolean;
  selectedDeviceId?: string;
}) {
  const { definitions: availableDefinitions, refresh: refreshDefinitions } = useDeviceDefinitions();
  const navigate = useNavigate();
  const definitionFamilies = buildDefinitionFamilies(availableDefinitions);
  const [devices, setDevices] = useState<DeviceConfiguration[]>([]);
  const [rememberedDeviceIds, setRememberedDeviceIds] = useState<string[]>([]);
  const [ports, setPorts] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAddPicker, setShowAddPicker] = useState(initialShowAddPicker);
  const [libraryBleSelection, setLibraryBleSelection] = useState<LibraryBleSelection | null>(null);
  const [selectedLibraryBleAddresses, setSelectedLibraryBleAddresses] = useState<string[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [autoSaveField, setAutoSaveField] = useState<SaveFieldTarget | null>(null);
  const [saveDirty, setSaveDirty] = useState(0);
  const [editingDeviceIdClientKey, setEditingDeviceIdClientKey] = useState<string | null>(null);
  const [bleScanResults, setBleScanResults] = useState<Record<string, BleScanDevice[]>>({});
  const [bleScanLoading, setBleScanLoading] = useState<Record<string, boolean>>({});
  const [bleScanFollowUpLoading, setBleScanFollowUpLoading] = useState<Record<string, boolean>>({});
  const [bleScanErrors, setBleScanErrors] = useState<Record<string, string | null>>({});
  const [scanNowMs, setScanNowMs] = useState(() => Date.now());
  const definitionsRef = useRef<DeviceDefinitionSummary[]>([]);
  const autoSaveFieldRef = useRef<SaveFieldTarget | null>(null);
  const bleScanSequenceRef = useRef<Record<string, number>>({});
  const activeLibraryBleScanKey = libraryBleSelection ? `library:${libraryBleSelection.definition.id}` : null;

  useEffect(() => {
    definitionsRef.current = availableDefinitions;
  }, [availableDefinitions]);

  useEffect(() => {
    const timer = window.setInterval(() => setScanNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const [deviceActions, setDeviceActions] = useState<Record<string, { loading: boolean; result?: StartStopResult }>>({});
  const devicesRef = useRef<DeviceConfiguration[]>([]);
  const initialLoadDone = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const duplicateDeviceIdClientKeys = getDuplicateDeviceIdClientKeys(devices);
  const visibleDeviceEntries = devices.flatMap((device, index) => (
    !selectedDeviceId || device.deviceId === selectedDeviceId
      ? [{ device, index }]
      : []
  ));
  const selectedDeviceMissing = selectedDeviceId != null && devices.length > 0 && visibleDeviceEntries.length === 0;

  devicesRef.current = devices;

  useEffect(() => {
    setShowAddPicker(initialShowAddPicker);
  }, [initialShowAddPicker]);

  const setAutoSaveTarget = useCallback((target: SaveFieldTarget | null) => {
    autoSaveFieldRef.current = target;
    setAutoSaveField(target);
  }, []);

  const getSaveFieldTarget = useCallback((index: number, fieldKey: string): SaveFieldTarget | null => {
    const deviceClientKey = devicesRef.current[index]?.clientKey;
    return deviceClientKey ? { deviceClientKey, fieldKey } : null;
  }, []);

  const libraryAssignedBleTargets = libraryBleSelection
    ? getAssignedBleTargets(devices, libraryBleSelection.definition.id)
    : new Set<string>();
  const visibleLibraryBleDevices = activeLibraryBleScanKey
    ? filterAssignedBleCandidates(bleScanResults[activeLibraryBleScanKey] ?? [], libraryAssignedBleTargets)
    : [];

  useEffect(() => {
    if (!libraryBleSelection) {
      return;
    }

    const visibleAddresses = new Set(visibleLibraryBleDevices.map((candidate) => candidate.address));
    setSelectedLibraryBleAddresses((current) => {
      const next = current.filter((address) => visibleAddresses.has(address));
      return next.length === current.length ? current : next;
    });
  }, [libraryBleSelection, visibleLibraryBleDevices]);

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

  const loadDefinitionSnapshot = useCallback(async (definitionId: string) => {
    const cachedDefinition = catalogDefinitionCache.get(definitionId);
    if (cachedDefinition) {
      return cachedDefinition;
    }

    const response = await fetch(`/api/definitions/${encodeURIComponent(definitionId)}?preferCatalog=true`);
    if (!response.ok) {
      throw new Error(`Unable to load device definition '${definitionId}'.`);
    }

    const definition = (await response.json()) as DeviceDefinition;
    catalogDefinitionCache.set(definitionId, definition);
    return definition;
  }, []);

  const loadDevices = useCallback(async () => {
    try {
      const response = await fetch('/api/devices/config');
      if (!response.ok) throw new Error('Unable to load device configuration.');
      const data = (await response.json()) as DeviceConfigurationResponse;
      setDevices((current) => mergeDeviceConfigurations(data.devices, current));
      setRememberedDeviceIds(data.rememberedDeviceIds ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load device configuration.');
    } finally {
      setIsLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void loadPorts();
  }, [loadDevices, loadPorts]);

  useEffect(() => {
    if (!showAddPicker) {
      setLibraryBleSelection(null);
      setSelectedLibraryBleAddresses([]);
      return;
    }

    void refreshDefinitions({ includeRemote: true });
  }, [refreshDefinitions, showAddPicker]);

  const saveDevicesNow = useCallback(async (devicesToSave?: DeviceConfiguration[]) => {
    try {
      setAutoSaveStatus('saving');
      const orderedDevices = (devicesToSave ?? devicesRef.current).map((device, index) => ({
        ...device,
        sortOrder: index,
      }));
      const duplicateClientKeys = getDuplicateDeviceIdClientKeys(orderedDevices);
      const firstDuplicateDevice = orderedDevices.find((device) => duplicateClientKeys.has(device.clientKey));
      if (firstDuplicateDevice) {
        setAutoSaveTarget({ deviceClientKey: firstDuplicateDevice.clientKey, fieldKey: 'deviceId' });
        setAutoSaveStatus('error');
        return false;
      }

      const devicesPayload = orderedDevices.map(serializeDevice);
      const response = await fetch('/api/devices/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devices: devicesPayload }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(errorPayload?.message ?? 'Unable to save device configuration.');
      }

      const data = (await response.json()) as DeviceConfigurationResponse;
      setDevices((current) => mergeDeviceConfigurations(data.devices, current));
      setRememberedDeviceIds(data.rememberedDeviceIds ?? []);
      setAutoSaveStatus('saved');
      window.setTimeout(() => {
        setAutoSaveStatus((current) => current === 'saved' ? 'idle' : current);
      }, 2000);
      return true;
    } catch {
      setAutoSaveStatus('error');
      return false;
    }
  }, [setAutoSaveTarget]);

  useEffect(() => {
    if (!initialLoadDone.current || saveDirty === 0 || editingDeviceIdClientKey) return;

    const timer = window.setTimeout(() => {
      void saveDevicesNow();
    }, 600);

    return () => window.clearTimeout(timer);
  }, [editingDeviceIdClientKey, saveDirty, saveDevicesNow]);

  const markDirty = useCallback((target?: SaveFieldTarget | null) => {
    if (target) {
      setAutoSaveTarget(target);
    }
    setAutoSaveStatus('idle');
    setSaveDirty((value) => value + 1);
  }, [setAutoSaveTarget]);

  const updateDevice = useCallback(<K extends keyof DeviceConfiguration>(index: number, key: K, value: DeviceConfiguration[K]) => {
    setDevices((current) => current.map((device, deviceIndex) => {
      if (deviceIndex !== index) return device;
      return { ...device, [key]: value };
    }));
    markDirty(getSaveFieldTarget(index, String(key)));
  }, [getSaveFieldTarget, markDirty]);

  const updateDisplayPrecision = useCallback((index: number, key: keyof DisplayPrecision, value: number) => {
    setDevices((current) => current.map((device, deviceIndex) => {
      if (deviceIndex !== index) {
        return device;
      }

      return {
        ...device,
        displayPrecision: {
          ...device.displayPrecision,
          [key]: value,
        },
      };
    }));
    markDirty(getSaveFieldTarget(index, `displayPrecision.${key}`));
  }, [getSaveFieldTarget, markDirty]);

  const updateDefinitionValue = useCallback((index: number, path: string[], nextValue: unknown) => {
    setDevices((current) => current.map((device, deviceIndex) => {
      if (deviceIndex !== index || !device.definition) {
        return device;
      }

      const updatedDefinition = setNestedValue(device.definition, path, nextValue) as DeviceDefinition;
      return {
        ...device,
        definition: updatedDefinition,
        hasDefinitionOverride: true,
        definitionVersion: updatedDefinition.version,
        pollIntervalMilliseconds: getDefinitionPollInterval(updatedDefinition, device.pollIntervalMilliseconds),
      };
    }));
    markDirty(getSaveFieldTarget(index, path.join('.')));
  }, [getSaveFieldTarget, markDirty]);

  const resetDefinitionOverride = useCallback(async (index: number, definitionId: string) => {
    const definitionSnapshot = await loadDefinitionSnapshot(definitionId);

    setDevices((current) => current.map((device, deviceIndex) => {
      if (deviceIndex !== index) {
        return device;
      }

      return {
        ...device,
        definition: definitionSnapshot,
        definitionVersion: definitionSnapshot.version,
        hasDefinitionOverride: false,
        pollIntervalMilliseconds: getDefinitionPollInterval(definitionSnapshot, device.pollIntervalMilliseconds),
      };
    }));
    markDirty(getSaveFieldTarget(index, 'definitionOverride'));
  }, [getSaveFieldTarget, loadDefinitionSnapshot, markDirty]);

  const updateDeviceConnection = useCallback(async (index: number, nextDefinitionId: string) => {
    const nextDefinition = definitionsRef.current.find((entry) => entry.id === nextDefinitionId);
    if (!nextDefinition) {
      return;
    }

    const nextDefinitionSnapshot = await loadDefinitionSnapshot(nextDefinitionId);
    const targetClientKey = devicesRef.current[index]?.clientKey;
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
        definitionVersion: nextDefinitionSnapshot.version,
        transportPortName: currentTransportType === nextTransportType ? (device.transportPortName ?? '') : '',
        bleSettingsPin: nextTransportType === 'ble' ? (device.bleSettingsPin ?? '') : '',
        definition: nextDefinitionSnapshot,
        hasDefinitionOverride: false,
        pollIntervalMilliseconds: getDefinitionPollInterval(nextDefinitionSnapshot, device.pollIntervalMilliseconds),
      };
    }));

    if (targetClientKey) {
      setBleScanResults((current) => {
        if (!(targetClientKey in current)) {
          return current;
        }

        const next = { ...current };
        delete next[targetClientKey];
        return next;
      });
      setBleScanLoading((current) => {
        if (!(targetClientKey in current)) {
          return current;
        }

        const next = { ...current };
        delete next[targetClientKey];
        return next;
      });
      setBleScanErrors((current) => {
        if (!(targetClientKey in current)) {
          return current;
        }

        const next = { ...current };
        delete next[targetClientKey];
        return next;
      });
    }

    markDirty(getSaveFieldTarget(index, 'definitionId'));
  }, [getSaveFieldTarget, loadDefinitionSnapshot, markDirty]);

  const renderFieldSaveState = useCallback((deviceClientKey: string, fieldKey: string) => {
    if (!autoSaveField || autoSaveField.deviceClientKey !== deviceClientKey || autoSaveField.fieldKey !== fieldKey) {
      return null;
    }

    if (autoSaveStatus === 'saving') {
      return <span className='flex items-center gap-1 text-[11px] text-muted-foreground'><LoaderCircle className='h-3 w-3 animate-spin' /> Saving...</span>;
    }

    if (autoSaveStatus === 'saved') {
      return <span className='flex items-center gap-1 text-[11px] text-emerald-500'><Check className='h-3 w-3' /> Saved</span>;
    }

    if (autoSaveStatus === 'error') {
      return <span className='text-[11px] text-destructive'>Save failed</span>;
    }

    return null;
  }, [autoSaveField, autoSaveStatus]);

  const scanBleDevices = useCallback(async (clientKey: string, definitionId: string) => {
    const scanSequence = (bleScanSequenceRef.current[clientKey] ?? 0) + 1;
    bleScanSequenceRef.current[clientKey] = scanSequence;

    setBleScanLoading((current) => ({ ...current, [clientKey]: true }));
    setBleScanFollowUpLoading((current) => ({ ...current, [clientKey]: false }));
    setBleScanErrors((current) => ({ ...current, [clientKey]: null }));

    const isLatestScan = () => bleScanSequenceRef.current[clientKey] === scanSequence;

    const fetchScanPhase = async (timeoutMs: string, returnOnFirstMatch: boolean) => {
      const query = new URLSearchParams({
        definitionId,
        timeoutMs,
        returnOnFirstMatch: returnOnFirstMatch ? 'true' : 'false',
      });
      const response = await fetch(`/api/devices/ble/scan?${query.toString()}`);
      const data = (await response.json()) as BleScanResponse;

      if (!response.ok) {
        throw new Error(data.error ?? 'Unable to scan for BLE devices.');
      }

      return data;
    };

    try {
      const quickData = await fetchScanPhase('1000', true);
      if (!isLatestScan()) {
        return;
      }

      const quickResults = sortBleScanDevices(quickData.devices);
      setBleScanResults((current) => ({ ...current, [clientKey]: quickResults }));
      setBleScanErrors((current) => ({ ...current, [clientKey]: quickData.error ?? null }));
      setBleScanLoading((current) => ({ ...current, [clientKey]: false }));

      if (quickData.error && quickResults.length === 0) {
        return;
      }

      setBleScanFollowUpLoading((current) => ({ ...current, [clientKey]: true }));

      window.setTimeout(() => {
        if (!isLatestScan()) {
          setBleScanFollowUpLoading((current) => ({ ...current, [clientKey]: false }));
          return;
        }

        void (async () => {
          try {
            const followUpData = await fetchScanPhase('8000', false);
            if (!isLatestScan()) {
              return;
            }

            const mergedResults = mergeBleScanDevices(quickResults, followUpData.devices);
            setBleScanResults((current) => ({
              ...current,
              [clientKey]: mergeBleScanDevices(current[clientKey] ?? quickResults, followUpData.devices),
            }));
            setBleScanErrors((current) => ({
              ...current,
              [clientKey]: followUpData.error && mergedResults.length === 0 ? followUpData.error : null,
            }));
          } catch (error) {
            if (!isLatestScan()) {
              return;
            }

            if (quickResults.length === 0) {
              setBleScanErrors((current) => ({
                ...current,
                [clientKey]: error instanceof Error ? error.message : 'Unable to scan for BLE devices.',
              }));
            }
          } finally {
            if (isLatestScan()) {
              setBleScanFollowUpLoading((current) => ({ ...current, [clientKey]: false }));
            }
          }
        })();
      }, 0);
    } catch (error) {
      if (!isLatestScan()) {
        return;
      }

      setBleScanResults((current) => ({ ...current, [clientKey]: [] }));
      setBleScanErrors((current) => ({
        ...current,
        [clientKey]: error instanceof Error ? error.message : 'Unable to scan for BLE devices.',
      }));
    } finally {
      if (isLatestScan()) {
        setBleScanLoading((current) => ({ ...current, [clientKey]: false }));
      }
    }
  }, []);

  const addDeviceFromDefinition = useCallback(async (definitionId: string, explicitDefinition?: DeviceDefinitionSummary, familyName?: string) => {
    const definition = explicitDefinition ?? definitionsRef.current.find((entry) => entry.id === definitionId);
    if (!definition || !definition.isTransportSupported) return;
    const definitionSnapshot = await loadDefinitionSnapshot(definitionId);
    let nextDeviceId = '';

    setDevices((current) => {
      const nextDevice = defaultDevice(current.length + 1, definition, definitionSnapshot, current, familyName);
      nextDeviceId = nextDevice.deviceId;
      return [...current, nextDevice];
    });
    setShowAddPicker(false);
    setUploadError(null);
    markDirty();
    if (nextDeviceId) {
      navigate(`/devices/${encodeURIComponent(nextDeviceId)}`);
    }
  }, [loadDefinitionSnapshot, markDirty, navigate]);

  const openLibraryBleSelection = useCallback((definition: DeviceDefinitionSummary, familyName: string) => {
    const nextSelection = { definition, familyName } satisfies LibraryBleSelection;
    setLibraryBleSelection(nextSelection);
    setSelectedLibraryBleAddresses([]);
    setBleScanResults((current) => ({ ...current, [`library:${definition.id}`]: current[`library:${definition.id}`] ?? [] }));
    setBleScanErrors((current) => ({ ...current, [`library:${definition.id}`]: null }));
    void scanBleDevices(`library:${definition.id}`, definition.id);
  }, [scanBleDevices]);

  const addSelectedLibraryBleDevices = useCallback(async () => {
    if (!libraryBleSelection || selectedLibraryBleAddresses.length === 0) {
      return;
    }

    const definitionSnapshot = await loadDefinitionSnapshot(libraryBleSelection.definition.id);
    const selectedDevices = visibleLibraryBleDevices
      .filter((candidate) => selectedLibraryBleAddresses.includes(candidate.address));
    if (selectedDevices.length === 0) {
      return;
    }

    let firstAddedDeviceId = '';
    setDevices((current) => {
      const nextDevices = [...current];
      for (const candidate of selectedDevices) {
        const nextDevice = createBleDeviceFromCandidate(
          libraryBleSelection.definition,
          definitionSnapshot,
          candidate,
          nextDevices,
          libraryBleSelection.familyName,
        );
        if (!firstAddedDeviceId) {
          firstAddedDeviceId = nextDevice.deviceId;
        }
        nextDevices.push(nextDevice);
      }

      return nextDevices;
    });

    setLibraryBleSelection(null);
    setSelectedLibraryBleAddresses([]);
    setShowAddPicker(false);
    setUploadError(null);
    markDirty();
    if (firstAddedDeviceId) {
      navigate(`/devices/${encodeURIComponent(firstAddedDeviceId)}`);
    }
  }, [libraryBleSelection, loadDefinitionSnapshot, markDirty, navigate, selectedLibraryBleAddresses, visibleLibraryBleDevices]);

  const addManualBleDevice = useCallback(async () => {
    if (!libraryBleSelection) {
      return;
    }

    await addDeviceFromDefinition(
      libraryBleSelection.definition.id,
      libraryBleSelection.definition,
      libraryBleSelection.familyName,
    );
    setLibraryBleSelection(null);
    setSelectedLibraryBleAddresses([]);
  }, [addDeviceFromDefinition, libraryBleSelection]);

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
        const definitionSnapshot = await loadDefinitionSnapshot(data.id);
        const summary: DeviceDefinitionSummary = {
          id: data.id,
          name: data.name ?? '',
          manufacturer: data.manufacturer ?? '',
          model: data.model ?? '',
          category: data.category ?? '',
          description: data.description,
          icon: undefined,
          transportType: data.transportType ?? 'serial',
          protocolType: 'uploaded',
          isTransportSupported: data.isTransportSupported ?? true,
          unsupportedTransportMessage: data.unsupportedTransportMessage ?? null,
          entityCount: definitionSnapshot.entities.length,
          dataSourceCount: definitionSnapshot.dataSources.length,
        };
        let nextDeviceId = '';
        setDevices((current) => {
          const nextDevice = defaultDevice(current.length + 1, summary, definitionSnapshot, current, stripConnectionSuffix(summary.name));
          nextDeviceId = nextDevice.deviceId;
          return [...current, nextDevice];
        });
        setShowAddPicker(false);
        markDirty();
        if (nextDeviceId) {
          navigate(`/devices/${encodeURIComponent(nextDeviceId)}`);
        }
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Upload failed.');
    }
  }, [loadDefinitionSnapshot, markDirty, navigate, refreshDefinitions]);

  const removeDevice = useCallback((index: number) => {
    setDevices((current) => current
      .filter((_, deviceIndex) => deviceIndex !== index)
      .map((device, deviceIndex) => ({ ...device, sortOrder: deviceIndex })));
    markDirty(getSaveFieldTarget(index, 'sortOrder'));
  }, [getSaveFieldTarget, markDirty]);

  const moveDevice = useCallback((index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= devicesRef.current.length) {
      return;
    }

    setDevices((current) => {
      const next = [...current];
      const [movedDevice] = next.splice(index, 1);
      next.splice(nextIndex, 0, movedDevice);
      return next.map((device, deviceIndex) => ({ ...device, sortOrder: deviceIndex }));
    });
    markDirty(getSaveFieldTarget(index, 'sortOrder'));
  }, [getSaveFieldTarget, markDirty]);

  const startDevice = useCallback(async (clientKey: string, deviceId: string) => {
    setDeviceActions((current) => ({ ...current, [clientKey]: { loading: true } }));

    try {
      const didSave = await saveDevicesNow();
      if (!didSave) {
        setDeviceActions((current) => ({
          ...current,
          [clientKey]: {
            loading: false,
            result: { deviceId, message: 'Resolve duplicate device IDs before starting this device.' },
          },
        }));
        return;
      }

      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/start`, { method: 'POST' });
      const data = (await response.json()) as StartStopResult;
      setDeviceActions((current) => ({ ...current, [clientKey]: { loading: false, result: data } }));
      setDevices((current) => current.map((device) => device.clientKey === clientKey ? { ...device, enabled: true } : device));
    } catch (error) {
      setDeviceActions((current) => ({
        ...current,
        [clientKey]: {
          loading: false,
          result: { deviceId, message: error instanceof Error ? error.message : 'Failed to start device.' },
        },
      }));
    }
  }, [saveDevicesNow]);

  const stopDevice = useCallback(async (clientKey: string, deviceId: string) => {
    setDeviceActions((current) => ({ ...current, [clientKey]: { loading: true } }));

    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/stop`, { method: 'POST' });
      const data = (await response.json()) as StartStopResult;
      setDeviceActions((current) => ({ ...current, [clientKey]: { loading: false, result: data } }));
      setDevices((current) => current.map((device) => device.clientKey === clientKey ? { ...device, enabled: false } : device));
    } catch (error) {
      setDeviceActions((current) => ({
        ...current,
        [clientKey]: {
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
            Add devices from the library or upload a definition JSON. Each device keeps its own definition snapshot, so transport, protocol, and polling overrides can be edited per device.
          </p>
        </div>
      </div>

      <div className='flex flex-wrap gap-3'>
        <Button type='button' variant='outline' size='lg' onClick={() => { setShowAddPicker(true); setUploadError(null); navigate('/devices/add'); }}>
          <Plus className='h-4 w-4' />
          Add device
        </Button>
      </div>

      {showAddPicker ? (
        <div className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
          <div className='mb-4 flex items-center justify-between'>
            <h3 className='text-lg font-semibold text-foreground'>Add a new device</h3>
            <Button type='button' variant='ghost' size='sm' onClick={() => { setShowAddPicker(false); setUploadError(null); navigate('/devices'); }}>
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
                              onClick={() => {
                                if (definition.transportType === 'ble') {
                                  openLibraryBleSelection(definition, family.name);
                                  return;
                                }

                                void addDeviceFromDefinition(definition.id, definition, family.name);
                              }}
                            >
                              {definition.transportType === 'ble' ? `Scan ${connectionLabel}` : connectionLabel}
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
            {libraryBleSelection && activeLibraryBleScanKey ? (
              <div className='mb-6 rounded-2xl border border-border/70 bg-background/50 p-4'>
                <div className='flex flex-wrap items-start justify-between gap-3'>
                  <div>
                    <div className='text-sm font-semibold text-foreground'>{libraryBleSelection.familyName} nearby and compatible</div>
                    <div className='mt-1 text-xs text-muted-foreground'>
                      Nearby matching broadcasters show live advert status while the shared scanner keeps listening. You can still add one manually if a device is quiet right now.
                    </div>
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={bleScanLoading[activeLibraryBleScanKey]}
                      onClick={() => void scanBleDevices(activeLibraryBleScanKey, libraryBleSelection.definition.id)}
                    >
                      {bleScanLoading[activeLibraryBleScanKey] ? <LoaderCircle className='h-4 w-4 animate-spin' /> : null}
                      {bleScanLoading[activeLibraryBleScanKey] ? 'Scanning...' : 'Scan nearby'}
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      disabled={selectedLibraryBleAddresses.length === 0}
                      onClick={() => void addSelectedLibraryBleDevices()}
                    >
                      Add selected
                    </Button>
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => void addManualBleDevice()}
                    >
                      Add manually
                    </Button>
                  </div>
                </div>

                {bleScanFollowUpLoading[activeLibraryBleScanKey] ? (
                  <p className='mt-3 text-xs text-muted-foreground'>Quick matches are shown first while the scan keeps listening for more devices.</p>
                ) : null}
                {bleScanErrors[activeLibraryBleScanKey] ? (
                  <div className='mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300'>
                    {bleScanErrors[activeLibraryBleScanKey]}
                  </div>
                ) : null}

                {(bleScanResults[activeLibraryBleScanKey] ?? []).length > 0 ? (
                  <div className='mt-4 space-y-2'>
                    {visibleLibraryBleDevices.map((candidate) => {
                      const isSelected = selectedLibraryBleAddresses.includes(candidate.address);
                      return (
                        <BleCandidateCard
                          key={candidate.address}
                          candidate={candidate}
                          selected={isSelected}
                          nowMs={scanNowMs}
                          onClick={() => setSelectedLibraryBleAddresses((current) => current.includes(candidate.address)
                            ? current.filter((address) => address !== candidate.address)
                            : [...current, candidate.address])}
                          actionLabel={isSelected ? 'Selected' : 'Select'}
                        />
                      );
                    })}
                  </div>
                ) : null}
                {(bleScanResults[activeLibraryBleScanKey] ?? []).length > 0 && visibleLibraryBleDevices.length === 0 ? (
                  <div className='mt-4 rounded-lg border border-border/70 bg-background/50 px-3 py-3 text-sm text-muted-foreground'>
                    All nearby compatible devices are already added.
                  </div>
                ) : null}
              </div>
            ) : null}

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
          {visibleDeviceEntries.map(({ device, index }) => {
            const definitionSummary = getDefinition(device, availableDefinitions);
            const definitionFamily = getFamilyForDefinition(device.definitionId, definitionFamilies);
            const connectionChoices = definitionFamily?.definitions ?? (definitionSummary ? [definitionSummary] : []);
            const transportType = getTransportType(device, availableDefinitions);
            const protocolType = device.definition?.connection.protocol.type ?? definitionSummary?.protocolType ?? null;
            const isPassiveBroadcast = protocolType === 'ble-advertisement';
            const isTransportSupported = definitionSummary?.isTransportSupported ?? true;
            const requiresTransport = requiresTransportIdentifier(device, availableDefinitions);
            const hasTransportTarget = !requiresTransport || Boolean(device.transportPortName?.trim());
            const action = deviceActions[device.clientKey];
            const assignedBleTargets = getAssignedBleTargets(devices, device.definitionId, device.clientKey);
            const bleDevices = filterAssignedBleCandidates(bleScanResults[device.clientKey] ?? [], assignedBleTargets);
            const bleIsScanning = bleScanLoading[device.clientKey] ?? false;
            const bleIsScanningForMore = bleScanFollowUpLoading[device.clientKey] ?? false;
            const bleScanError = bleScanErrors[device.clientKey];
            const effectivePollInterval = getDefinitionPollInterval(device.definition, device.pollIntervalMilliseconds);
            const rememberedIdsForDevice = getAvailableRememberedDeviceIds(devices, rememberedDeviceIds, device.clientKey);
            const deviceIdListId = `device-id-suggestions-${device.clientKey}`;
            const manufacturerAndModel = [device.definition?.device.manufacturer ?? definitionSummary?.manufacturer, device.definition?.device.model ?? definitionSummary?.model]
              .filter((value): value is string => Boolean(value))
              .join(' · ');
            const definitionSections = [
              {
                key: 'transport-defaults',
                title: 'Transport defaults',
                description: transportType === 'ble' ? 'BLE transport settings stored with this device.' : 'Serial transport settings stored with this device.',
                path: ['connection', 'transport', 'defaults'],
                value: filterTransportDefaults(device.definition?.connection.transport.defaults as Record<string, unknown> | undefined, transportType),
              },
              {
                key: 'protocol-settings',
                title: 'Protocol settings',
                description: 'Retries, timeouts, framing, and protocol-specific options.',
                path: ['connection', 'protocol', 'settings'],
                value: device.definition?.connection.protocol.settings,
              },
              {
                key: 'poll-groups',
                title: 'Poll groups',
                description: 'Polling cadence per group. The fastest interval becomes the device poll rate.',
                path: ['pollGroups'],
                value: device.definition?.pollGroups,
              },
            ].filter((section): section is { key: string; title: string; description: string; path: string[]; value: Record<string, unknown> } => isObjectRecord(section.value));

            return (
              <section key={device.clientKey} className='rounded-2xl border border-border bg-card/85 p-5 shadow-sm'>
                <div className='mb-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between'>
                  <div className='space-y-1'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <h3 className='text-lg font-semibold text-foreground'>{device.displayName || device.deviceId}</h3>
                      {transportType ? <span className='rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>{getConnectionLabel(transportType)}</span> : null}
                      {device.definitionVersion ? <span className='rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>v{device.definitionVersion}</span> : null}
                      {device.hasDefinitionOverride ? <span className='rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary'>Override</span> : null}
                    </div>
                    <div className='text-sm text-muted-foreground'>
                      {manufacturerAndModel || device.deviceId}
                    </div>
                    <div className='text-xs text-muted-foreground/70'>
                      Connection: {getConnectionLabel(transportType)}{isPassiveBroadcast ? ' · Passive broadcast' : ` · Effective poll: ${effectivePollInterval} ms`}
                    </div>
                  </div>

                  <div className='flex flex-wrap gap-2'>
                    <div className='flex items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2 py-1.5 text-xs text-muted-foreground'>
                      <span className='font-medium uppercase tracking-[0.18em]'>Monitor order</span>
                      <span>{index + 1} / {devices.length}</span>
                      {renderFieldSaveState(device.clientKey, 'sortOrder')}
                      <div className='flex items-center gap-1'>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`Move ${device.displayName || device.deviceId} up`}
                          disabled={index === 0}
                          onClick={() => moveDevice(index, -1)}
                        >
                          <ArrowUp className='h-4 w-4' />
                        </Button>
                        <Button
                          type='button'
                          variant='ghost'
                          size='icon-sm'
                          aria-label={`Move ${device.displayName || device.deviceId} down`}
                          disabled={index === devices.length - 1}
                          onClick={() => moveDevice(index, 1)}
                        >
                          <ArrowDown className='h-4 w-4' />
                        </Button>
                      </div>
                    </div>
                    {device.enabled ? (
                      <Button type='button' variant='outline' onClick={() => void stopDevice(device.clientKey, device.deviceId)} disabled={action?.loading}>
                        {action?.loading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Square className='h-4 w-4' />}
                        Stop
                      </Button>
                    ) : (
                      <Button
                        type='button'
                        variant='outline'
                        onClick={() => void startDevice(device.clientKey, device.deviceId)}
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
                {!isTransportSupported ? <div className='mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300'>{definitionSummary?.unsupportedTransportMessage ?? 'This device transport is not supported in the current build.'}</div> : null}
                {isTransportSupported && requiresTransport && !hasTransportTarget ? (
                  <div className='mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300'>
                    {transportType === 'ble'
                      ? 'Scan and choose a nearby BLE device, or enter the MAC address or alias before starting this device.'
                      : 'Select the serial port before starting this device.'}
                  </div>
                ) : null}

                <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
                  <div className='space-y-2 text-sm text-foreground'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Device ID</span>
                      {renderFieldSaveState(device.clientKey, 'deviceId')}
                    </div>
                    <Input
                      list={rememberedIdsForDevice.length > 0 ? deviceIdListId : undefined}
                      value={device.deviceId}
                      disabled={device.enabled}
                      aria-invalid={duplicateDeviceIdClientKeys.has(device.clientKey)}
                      onFocus={() => setEditingDeviceIdClientKey(device.clientKey)}
                      onBlur={() => setEditingDeviceIdClientKey((current) => current === device.clientKey ? null : current)}
                      onChange={(event) => updateDevice(index, 'deviceId', event.target.value)}
                    />
                    {rememberedIdsForDevice.length > 0 ? (
                      <datalist id={deviceIdListId}>
                        {rememberedIdsForDevice.map((deviceId) => (
                          <option key={deviceId} value={deviceId} />
                        ))}
                      </datalist>
                    ) : null}
                    {duplicateDeviceIdClientKeys.has(device.clientKey) ? (
                      <p className='text-[11px] text-destructive'>Device ID must be unique.</p>
                    ) : null}
                    <p className='text-[11px] text-muted-foreground'>Choose a remembered ID or type a new one. IDs already used by other devices are hidden.</p>
                  </div>

                  <label className='space-y-2 text-sm text-foreground'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Display name</span>
                      {renderFieldSaveState(device.clientKey, 'displayName')}
                    </div>
                    <Input value={device.displayName} onChange={(event) => updateDevice(index, 'displayName', event.target.value)} />
                  </label>

                  <label className='space-y-2 text-sm text-foreground'>
                    <div className='flex items-center justify-between gap-2'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Connection</span>
                      {renderFieldSaveState(device.clientKey, 'definitionId')}
                    </div>
                    <select
                      className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                      value={device.definitionId}
                      disabled={device.enabled || connectionChoices.length <= 1}
                      onChange={(event) => { void updateDeviceConnection(index, event.target.value); }}
                    >
                      {connectionChoices.map((entry) => (
                        <option key={entry.id} value={entry.id}>{getConnectionLabel(entry.transportType)}</option>
                      ))}
                    </select>
                  </label>

                  {!isPassiveBroadcast ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Effective poll interval</span>
                      <Input value={`${effectivePollInterval} ms`} disabled />
                    </label>
                  ) : null}

                  {transportType === 'serial' ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Serial port</span>
                        {renderFieldSaveState(device.clientKey, 'transportPortName')}
                      </div>
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
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>BLE device</span>
                          {renderFieldSaveState(device.clientKey, 'transportPortName')}
                        </div>
                        <div className='flex flex-col gap-2 xl:flex-row'>
                          <Input
                          className='flex-1'
                          value={device.transportPortName ?? ''}
                          disabled={device.enabled}
                          placeholder='AA:BB:CC:DD:EE:FF or device alias'
                          onChange={(event) => updateDevice(index, 'transportPortName', event.target.value)}
                        />
                        <Button
                          type='button'
                          variant='outline'
                          className='shrink-0'
                          disabled={device.enabled || bleIsScanning || !device.definitionId}
                          onClick={() => void scanBleDevices(device.clientKey, device.definitionId)}
                        >
                          {bleIsScanning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : null}
                          {bleIsScanning ? 'Scanning...' : 'Scan nearby'}
                          </Button>
                        </div>
                        {bleIsScanningForMore ? <p className='text-xs text-muted-foreground'>Quick results shown. Looking for more nearby candidates...</p> : null}
                        {bleScanError ? <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300'>{bleScanError}</div> : null}
                        {bleDevices.length > 0 ? (
                          <div className='space-y-2'>
                            {bleDevices.map((candidate) => {
                              const isSelected = candidate.address === (device.transportPortName ?? '');
                              return (
                                <BleCandidateCard
                                  key={candidate.address}
                                  candidate={candidate}
                                  selected={isSelected}
                                  disabled={device.enabled || bleIsScanning}
                                  nowMs={scanNowMs}
                                  onClick={() => updateDevice(index, 'transportPortName', candidate.address)}
                                  actionLabel={isSelected ? 'Selected' : 'Use device'}
                                />
                              );
                            })}
                          </div>
                        ) : null}
                        {(bleScanResults[device.clientKey] ?? []).length > 0 && bleDevices.length === 0 ? (
                          <div className='rounded-lg border border-border/70 bg-background/50 px-3 py-3 text-xs text-muted-foreground'>
                            All nearby compatible devices are already assigned.
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}

                  {transportType !== 'ble' ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Address</span>
                        {renderFieldSaveState(device.clientKey, 'address')}
                      </div>
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

                  {definitionFamily?.category === 'energy-storage' ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Is master</span>
                        {renderFieldSaveState(device.clientKey, 'isMaster')}
                      </div>
                      <div className='flex h-10 items-center rounded-md border border-input bg-background px-3'>
                        <input
                          type='checkbox'
                          checked={device.isMaster}
                          disabled={device.enabled}
                          onChange={(event) => updateDevice(index, 'isMaster', event.target.checked)}
                        />
                      </div>
                    </label>
                  ) : null}

                  {transportType === 'ble' && !isPassiveBroadcast ? (
                    <label className='space-y-2 text-sm text-foreground'>
                      <div className='flex items-center justify-between gap-2'>
                        <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>BLE settings PIN</span>
                        {renderFieldSaveState(device.clientKey, 'bleSettingsPin')}
                      </div>
                      <Input
                        type='password'
                        value={device.bleSettingsPin ?? ''}
                        disabled={device.enabled}
                        onChange={(event) => updateDevice(index, 'bleSettingsPin', event.target.value)}
                      />
                    </label>
                  ) : null}
                </div>

                {definitionFamily?.category === 'energy-storage' ? (
                <details className='mt-4 rounded-2xl border border-border/70 bg-background/40 p-4'>
                  <summary className='cursor-pointer list-none text-sm font-semibold text-foreground'>Runtime tuning</summary>
                  <div className='mt-4 space-y-4'>
                    {device.enabled ? <div className='rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300'>Stop the device before changing runtime or definition settings.</div> : null}
                    <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Cell smoothing factor</span>
                          {renderFieldSaveState(device.clientKey, 'cellVoltageSmoothingFactor')}
                        </div>
                        <Input
                          type='number'
                          min={0}
                          max={1}
                          step='0.01'
                          value={device.cellVoltageSmoothingFactor}
                          disabled={device.enabled}
                          onChange={(event) => updateDevice(index, 'cellVoltageSmoothingFactor', Number(event.target.value))}
                        />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Breakout mV</span>
                          {renderFieldSaveState(device.clientKey, 'cellVoltageSmoothingBreakoutMillivolts')}
                        </div>
                        <Input
                          type='number'
                          min={0}
                          step='1'
                          value={device.cellVoltageSmoothingBreakoutMillivolts}
                          disabled={device.enabled}
                          onChange={(event) => updateDevice(index, 'cellVoltageSmoothingBreakoutMillivolts', Number(event.target.value))}
                        />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Voltage precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.voltage')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.voltage} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'voltage', Number(event.target.value))} />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Cell precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.cellVoltage')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.cellVoltage} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'cellVoltage', Number(event.target.value))} />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Current precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.current')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.current} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'current', Number(event.target.value))} />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Power precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.power')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.power} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'power', Number(event.target.value))} />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Temperature precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.temperature')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.temperature} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'temperature', Number(event.target.value))} />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Temperature unit</span>
                          {renderFieldSaveState(device.clientKey, 'temperatureUnit')}
                        </div>
                        <div className='inline-flex items-center gap-1 rounded-full border border-border/70 bg-background/70 p-1 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>
                          <button
                            type='button'
                            disabled={device.enabled}
                            onClick={() => updateDevice(index, 'temperatureUnit', 'c')}
                            className={cn(
                              'rounded-full px-3 py-1 transition-colors',
                              device.temperatureUnit === 'c' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/70',
                            )}
                          >
                            °C
                          </button>
                          <button
                            type='button'
                            disabled={device.enabled}
                            onClick={() => updateDevice(index, 'temperatureUnit', 'f')}
                            className={cn(
                              'rounded-full px-3 py-1 transition-colors',
                              device.temperatureUnit === 'f' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted/70',
                            )}
                          >
                            °F
                          </button>
                        </div>
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>SOC precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.soc')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.soc} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'soc', Number(event.target.value))} />
                      </label>
                      <label className='space-y-2 text-sm text-foreground'>
                        <div className='flex items-center justify-between gap-2'>
                          <span className='block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Delta V precision</span>
                          {renderFieldSaveState(device.clientKey, 'displayPrecision.deltaVoltage')}
                        </div>
                        <Input type='number' min={0} step='1' value={device.displayPrecision.deltaVoltage} disabled={device.enabled} onChange={(event) => updateDisplayPrecision(index, 'deltaVoltage', Number(event.target.value))} />
                      </label>
                    </div>
                  </div>
                </details>
                ) : null}

                <details className='mt-4 rounded-2xl border border-border/70 bg-background/40 p-4'>
                  <summary className='cursor-pointer list-none text-sm font-semibold text-foreground'>Definition overrides</summary>
                  <div className='mt-4 space-y-4'>
                    <div className='flex flex-wrap items-center justify-between gap-3'>
                      <p className='text-sm text-muted-foreground'>
                        These values are saved with this device&apos;s stored definition snapshot so old devices can be corrected without editing the shared catalog file.
                      </p>
                      {device.hasDefinitionOverride ? (
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={device.enabled}
                          onClick={() => void resetDefinitionOverride(index, device.definitionId)}
                        >
                          <RotateCcw className='h-4 w-4' />
                          Reset to catalog
                        </Button>
                      ) : null}
                    </div>

                    {!device.definition ? (
                      <div className='rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>
                        The stored definition snapshot could not be loaded for this device.
                      </div>
                    ) : null}

                    {definitionSections.map((section) => (
                      <div key={section.key} className='rounded-2xl border border-border/70 bg-card/60 p-4'>
                        <div className='mb-4 space-y-1'>
                          <div className='flex items-center justify-between gap-2'>
                            <div className='text-sm font-semibold text-foreground'>{section.title}</div>
                            {section.key === 'transport-defaults' ? renderFieldSaveState(device.clientKey, 'definitionOverride') : null}
                          </div>
                          <div className='text-xs text-muted-foreground'>{section.description}</div>
                        </div>
                        <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
                          {renderDefinitionEditorFields(section.value, section.path, device.enabled, (path, nextValue) => updateDefinitionValue(index, path, nextValue), (fieldKey) => renderFieldSaveState(device.clientKey, fieldKey))}
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              </section>
            );
          })}

          {selectedDeviceMissing ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <div className='text-lg font-semibold text-foreground'>Device not found</div>
              <p className='mt-2 text-sm text-muted-foreground'>The selected device is not configured or no longer available.</p>
            </div>
          ) : null}

          {devices.length === 0 && !showAddPicker ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <div className='text-lg font-semibold text-foreground'>No devices configured</div>
              <p className='mt-2 text-sm text-muted-foreground'>Add a device from the library or upload a definition JSON to get started.</p>
              <div className='mt-6'>
                <Button type='button' onClick={() => { setShowAddPicker(true); setUploadError(null); navigate('/devices/add'); }}>
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
