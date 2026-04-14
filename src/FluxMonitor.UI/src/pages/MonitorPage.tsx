import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Battery, BatteryCharging, Check, ChevronDown, ChevronUp, Edit2, Gauge, LoaderCircle, Shield, Thermometer, X, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { HistoryCharts } from '../components/HistoryCharts';
import { cn } from '../lib/utils';
import { getBatteryStateFromCurrent } from '../lib/batteryStatus';
import { useDeviceDefinition } from '../hooks/useDeviceDefinition';
import type { DeviceDefinition, UiSectionDefinition, UiStatusGlyphDefinition, UiStatusGlyphLevelDefinition } from '../types/deviceDefinition';
import {
  convertTemperatureValue,
  getTemperatureDisplayUnit,
  isCelsiusUnit,
  type TemperatureUnit,
} from '../lib/temperatureUnits';

type DeviceParameter = {
  key: string;
  displayName: string;
  category: string;
  numericValue?: number | null;
  stringValue?: string | null;
  booleanValue?: boolean | null;
  unit?: string | null;
  sortOrder: number;
  isWritable?: boolean;
  rawValue?: number | null;
};

type CellVoltageSnapshot = {
  index: number;
  voltageVolts: number;
};

type DeviceTelemetrySnapshot = {
  collectedAt: string;
  cellCount?: number | null;
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  powerWatts?: number | null;
  stateOfChargePercent?: number | null;
  minCellVoltageVolts?: number | null;
  maxCellVoltageVolts?: number | null;
  averageCellVoltageVolts?: number | null;
  deltaCellVoltageVolts?: number | null;
  mosTemperatureCelsius?: number | null;
  ambientTemperatureCelsius?: number | null;
  batteryTemperatureCelsius?: number | null;
  cycleCount?: number | null;
  warningFlags?: number | null;
  statusFlags?: number | null;
  protocolVersion?: number | null;
  softwareVersion?: string | null;
  manufacturerId?: string | null;
  chargingEnabled?: boolean | null;
  dischargingEnabled?: boolean | null;
  balancingEnabled?: boolean | null;
  batteryOnline?: boolean | null;
  cells: CellVoltageSnapshot[];
  activeWarnings: string[];
  parameters: DeviceParameter[];
};

type DisplayPrecision = {
  voltage: number;
  cellVoltage: number;
  current: number;
  power: number;
  temperature: number;
  soc: number;
  deltaVoltage: number;
};

const defaultPrecision: DisplayPrecision = { voltage: 2, cellVoltage: 3, current: 1, power: 0, temperature: 1, soc: 0, deltaVoltage: 3 };

type DeviceRuntimeState = {
  deviceId: string;
  displayName: string;
  sortOrder?: number;
  definitionId: string;
  protocolHandler?: string | null;
  enabled: boolean;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  lastPollStartedAt?: string | null;
  lastPollCompletedAt?: string | null;
  lastOutcome: string;
  lastError?: string | null;
  lastPersistedAt?: string | null;
  displayPrecision?: DisplayPrecision | null;
  temperatureUnit?: string | null;
  latestTelemetry?: DeviceTelemetrySnapshot | null;
};

type DeviceRuntimeStateStreamEnvelope = {
  devices: DeviceRuntimeState[];
};

const reconnectDelayMs = 2000;
const fallbackRefreshIntervalMs = 2000;
const nd = 'N/D';
const emptyTelemetrySnapshot: DeviceTelemetrySnapshot = {
  collectedAt: '',
  cells: [],
  activeWarnings: [],
  parameters: [],
};

function getRelativeAdvertisementAgeSeconds(collectedAt: string | null | undefined, nowMs: number) {
  if (!collectedAt) {
    return null;
  }

  const collectedMs = Date.parse(collectedAt);
  if (Number.isNaN(collectedMs)) {
    return null;
  }

  return Math.max(0, Math.round((nowMs - collectedMs) / 1000));
}

type SwitchStatusChip = {
  label: string;
  className: string;
};

type ResolvedStatusGlyph = {
  key: string;
  title: string;
  toneClassName: string;
  icon: React.ReactNode;
};

export function MonitorPage() {
  const [devices, setDevices] = useState<DeviceRuntimeState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let isMounted = true;
    let requestInFlight = false;
    let eventSource: EventSource | null = null;
    let reconnectTimerId: number | null = null;
    let fallbackIntervalId: number | null = null;

    const applySnapshot = (snapshot: DeviceRuntimeState[]) => {
      if (!isMounted) return;
      setDevices(snapshot);
      setLoadError(null);
      setIsLoading(false);
    };

    const load = async () => {
      if (requestInFlight) return;
      requestInFlight = true;

      try {
        const response = await fetch('/api/devices/current', { cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to load device telemetry.');
        const data = (await response.json()) as DeviceRuntimeState[];
        applySnapshot(data);
      } catch (error) {
        if (!isMounted) return;
        setLoadError(error instanceof Error ? error.message : 'Unable to load device telemetry.');
      } finally {
        requestInFlight = false;
        if (isMounted) setIsLoading(false);
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerId == null) return;
      window.clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    };

    const closeEventSource = () => {
      if (!eventSource) return;
      eventSource.close();
      eventSource = null;
    };

    const connectStream = () => {
      if (!isMounted) return;

      if (typeof EventSource === 'undefined') {
        if (fallbackIntervalId == null) {
          fallbackIntervalId = window.setInterval(() => { void load(); }, fallbackRefreshIntervalMs);
        }
        return;
      }

      clearReconnectTimer();
      closeEventSource();

      const stream = new EventSource('/api/devices/current/stream');
      eventSource = stream;

      stream.onmessage = (event) => {
        let payload: DeviceRuntimeState[] | DeviceRuntimeStateStreamEnvelope;

        try {
          payload = JSON.parse(event.data) as DeviceRuntimeState[] | DeviceRuntimeStateStreamEnvelope;
        } catch {
          setLoadError('Unable to read device telemetry stream.');
          return;
        }

        if (Array.isArray(payload)) {
          applySnapshot(payload);
          return;
        }

        if (Array.isArray(payload.devices)) {
          applySnapshot(payload.devices);
          return;
        }

        setLoadError('Unable to read device telemetry stream.');
      };

      stream.onerror = () => {
        if (eventSource === stream) {
          closeEventSource();
        }

        void load();

        if (!isMounted || reconnectTimerId != null) {
          return;
        }

        reconnectTimerId = window.setTimeout(() => {
          reconnectTimerId = null;
          connectStream();
        }, reconnectDelayMs);
      };
    };

    void load();
    connectStream();

    return () => {
      isMounted = false;
      closeEventSource();
      clearReconnectTimer();

      if (fallbackIntervalId != null) {
        window.clearInterval(fallbackIntervalId);
      }
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className='space-y-3 pb-4 sm:space-y-6 sm:pb-8'>
      <section data-slot='page-hero-shell' className='page-hero-shell rounded-3xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur sm:p-6 md:p-8'>
        <div className='space-y-3'>
          <div className='flex flex-wrap items-center justify-between gap-3'>
            <div className='inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary'>
              <Activity className='h-3.5 w-3.5' />
              Live Telemetry
            </div>
          </div>
          <div>
            <h2 className='text-3xl font-bold tracking-tight text-foreground md:text-4xl'>Device Monitor</h2>
            <p className='mt-2 max-w-2xl text-sm leading-6 text-muted-foreground'>
              Real-time data from all connected devices. Layout and parameters are driven by the device definition.
            </p>
          </div>
        </div>
      </section>

      {loadError && (
        <div className='flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-4 text-sm text-destructive'>
          <AlertTriangle className='mt-0.5 h-5 w-5 shrink-0' />
          <div>
            <div className='font-semibold'>Telemetry feed unavailable</div>
            <div className='mt-1 text-destructive/90'>{loadError}</div>
          </div>
        </div>
      )}

      {isLoading && devices.length === 0 && (
        <div className='flex min-h-64 items-center justify-center rounded-2xl border border-border bg-card/60'>
          <LoaderCircle className='h-6 w-6 animate-spin text-primary' />
        </div>
      )}

      {devices.length === 0 && !isLoading && !loadError && (
        <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
          <div className='text-lg font-semibold text-foreground'>No devices configured</div>
          <p className='mt-2 text-sm text-muted-foreground'>Add a device in Device Configuration to start monitoring.</p>
        </div>
      )}

      {devices.map((device) => (
        <DevicePanel key={device.deviceId} device={device} nowMs={nowMs} />
      ))}
    </div>
  );
}

function DevicePanel({ device, nowMs }: { device: DeviceRuntimeState; nowMs: number }) {
  const definition = useDeviceDefinition(device.definitionId);
  const temperatureUnit: TemperatureUnit = device.temperatureUnit === 'f' ? 'f' : 'c';
  const telemetry = device.latestTelemetry;
  const parameters = telemetry?.parameters ?? [];
  const cells = telemetry?.cells ?? [];
  const warnings = telemetry?.activeWarnings ?? [];
  const isPassiveAdvertisement = definition?.connection.protocol.type === 'ble-advertisement'
    || device.protocolHandler === 'ble-advertisement';
  const isHealthy = device.lastOutcome === 'Succeeded';
  const isFailing = device.lastOutcome === 'Failed';
  const dp = device.displayPrecision ?? defaultPrecision;
  const [selectedCellIndices, setSelectedCellIndices] = useState<number[]>([]);
  const isEnvironment = definition?.device.category === 'environment';
  const isJkBms = definition?.device.manufacturer?.toLowerCase() === 'jk';
  const [isExpanded, setIsExpanded] = useState(false);

  // Build a fast lookup by entity key for definition-driven rendering
  const paramByKey = new Map(parameters.map(p => [p.key, p]));

  // Resolve monitor page UI sections from definition (if available)
  const monitorSections = definition?.ui?.pages?.monitor?.sections;

  // Group parameters by category
  const grouped = new Map<string, DeviceParameter[]>();
  for (const param of parameters) {
    const cat = param.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(param);
  }

  // Category rendering order — derived from entity order in definition, fallback to legacy
  const sortedCategories = getSortedCategories(grouped, definition);

  // Determine which sections to render for parameters
  const paramTableSections = monitorSections?.filter(s => s.type === 'parameter-table');

  // Environment devices and JK BMS units use a compact expandable card.
  if (isEnvironment || (isJkBms && telemetry)) {
    const compactTelemetry = telemetry ?? emptyTelemetrySnapshot;
    const compactParameters = compactTelemetry.parameters ?? [];
    const compactCells = compactTelemetry.cells ?? [];
    const compactWarnings = compactTelemetry.activeWarnings ?? [];
    const compactParamByKey = new Map(compactParameters.map(p => [p.key, p]));
    const heroSection = monitorSections?.find(s => s.type === 'hero-metrics');
    const heroMetrics = heroSection?.metrics ?? [];
    const batteryParam = compactParamByKey.get('battery_pct');
    const batteryValue = batteryParam?.numericValue;
    const signalValue = compactParamByKey.get('signal_strength_pct')?.numericValue;
    const capacityAh = compactParamByKey.get('nominal_battery_capacity')?.numericValue;
    const advertisementAgeSeconds = getRelativeAdvertisementAgeSeconds(telemetry?.collectedAt, nowMs);
    const compactSections = monitorSections?.filter(section => section.type !== 'hero-metrics' && section.type !== 'parameter-table') ?? [];
    const statusGlyphDefinitions = definition?.ui?.pages?.monitor?.card?.statusGlyphs;
    const headerStatusGlyphs = statusGlyphDefinitions != null
      ? resolveConfiguredStatusGlyphs(statusGlyphDefinitions, compactTelemetry, compactParamByKey, nowMs, isPassiveAdvertisement)
      : [];

    return (
      <div className='space-y-3 sm:space-y-4'>
        <div className='rounded-2xl border border-border/80 bg-card/85 shadow-sm overflow-hidden'>
          {/* Compact header */}
          <button
            type='button'
            onClick={() => setIsExpanded(prev => !prev)}
            className='flex w-full items-center justify-between gap-3 px-4 py-3 sm:px-5 sm:py-4 text-left transition-colors hover:bg-muted/30'
          >
            <div className='flex items-center gap-3 min-w-0'>
              <div className={cn(
                'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                isHealthy ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' :
                isFailing ? 'border-rose-500/30 bg-rose-500/10 text-rose-400' :
                'border-border bg-muted/50 text-muted-foreground'
              )}>
                <DeviceIcon name={definition?.device.icon} className='h-4 w-4' />
              </div>
              <div className='min-w-0'>
                <h3 className='text-base font-semibold text-foreground truncate'>{device.displayName}</h3>
                {isEnvironment ? (
                  <div className='text-[10px] font-mono text-muted-foreground/70 truncate'>
                    {device.deviceId}
                  </div>
                ) : (
                  <div className='text-[10px] font-mono text-muted-foreground/70 truncate'>
                    {formatDeviceConnectionDescriptor(device, isPassiveAdvertisement)}
                  </div>
                )}
              </div>
            </div>
            <div className='flex items-center gap-1.5 shrink-0'>
              {headerStatusGlyphs.length > 0 ? (
                <>
                  {headerStatusGlyphs.map((glyph) => (
                    <StatusGlyph key={glyph.key} title={glyph.title} toneClassName={glyph.toneClassName}>
                      {glyph.icon}
                    </StatusGlyph>
                  ))}
                </>
              ) : isEnvironment ? (
                <>
                  <StatusGlyph
                    title={telemetry ? formatAdvertisementStatusTitle(telemetry.collectedAt, nowMs) : 'Listening for a first signal'}
                    toneClassName={getAdvertisementStatusToneClassName(advertisementAgeSeconds)}
                  >
                    <SeenStatusGlyph />
                  </StatusGlyph>
                  {signalValue != null && (
                    <StatusGlyph
                      title={`Signal ${Math.round(signalValue)}%`}
                      toneClassName={getSignalStatusToneClassName(signalValue)}
                    >
                      <SignalStatusGlyph percent={signalValue} />
                    </StatusGlyph>
                  )}
                  {batteryValue != null && (
                    <StatusGlyph
                      title={`Battery ${Math.round(batteryValue)}%`}
                      toneClassName={getBatteryStatusToneClassName(batteryValue)}
                    >
                      <BatteryStatusGlyph percent={batteryValue} />
                    </StatusGlyph>
                  )}
                </>
              ) : (
                <>
                  <div className='hidden text-right sm:block'>
                    <div className='text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground/60'>Last update</div>
                    <div className='text-xs font-medium text-muted-foreground'>{new Date(compactTelemetry.collectedAt).toLocaleTimeString()}</div>
                  </div>
                  <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]', getOutcomeClass(device.lastOutcome))}>
                    {device.lastOutcome}
                  </span>
                </>
              )}
              <div className='text-muted-foreground/60'>
                {isExpanded ? <ChevronUp className='h-4 w-4' /> : <ChevronDown className='h-4 w-4' />}
              </div>
            </div>
          </button>

          {/* Compact hero metrics row */}
          <div className='border-t border-border/60 px-4 py-3 sm:px-5 sm:py-4'>
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4'>
              {heroMetrics.map((m) => {
                const param = compactParamByKey.get(m.entity);
                const entity = definition?.entities.find(e => e.id === m.entity) ?? definition?.computedEntities?.find(e => e.id === m.entity);
                const value = param?.numericValue;
                const sourceUnit = param?.unit ?? (entity && 'source' in entity ? entity.source?.unit : undefined) ?? (entity && 'unit' in entity ? (entity as { unit?: string }).unit : '') ?? '';
                const unit = getTemperatureDisplayUnit(sourceUnit, temperatureUnit) ?? '';
                const prec = entity?.display?.precision ?? 2;
                const displayValue = isCelsiusUnit(sourceUnit)
                  ? convertTemperatureValue(value != null ? Number(value) : null, temperatureUnit)
                  : value != null ? Number(value) : null;
                const chargeState = getRealtimeBatteryState(compactTelemetry, compactParamByKey);
                const isCurrentMetric = m.entity === 'current';
                const isPowerMetric = m.entity === 'power';
                const accentClass = (isCurrentMetric || isPowerMetric)
                  ? chargeState === 'CHARGING'
                    ? 'text-emerald-400'
                    : chargeState === 'DISCHARGING'
                      ? 'text-rose-400'
                      : resolveColorClass(m.color)
                  : m.entity === 'total_voltage'
                    ? 'text-sky-400'
                    : resolveColorClass(m.color);

                return (
                  <div key={m.entity} className='min-w-0'>
                    <div className='text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground/70'>
                      {param?.displayName ?? entity?.name ?? m.entity}
                    </div>
                    <div className='mt-1 flex items-baseline gap-1'>
                      <span className={cn('text-xl font-bold tracking-tight tabular-nums sm:text-2xl', accentClass)}>
                        {fmt(displayValue, prec)}
                      </span>
                      <span className='text-xs font-medium text-muted-foreground/70'>{unit}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Accent bar at bottom of collapsed card */}
          {!isExpanded && (
            <div className={cn(
              'h-0.5',
              isHealthy ? 'bg-emerald-500/40' : isFailing ? 'bg-rose-500/40' : 'bg-border/60'
            )} />
          )}

          {/* Expanded content: history charts + parameter tables */}
          {isExpanded && (
            <div className='border-t border-border/60 px-4 pb-4 pt-3 sm:px-5 sm:pb-5 sm:pt-4 space-y-4'>
              {isEnvironment ? (
                <>
                  <HistoryCharts
                    deviceId={device.deviceId}
                    precision={dp}
                    selectedCellIndices={selectedCellIndices}
                    onClearCellSelection={() => setSelectedCellIndices([])}
                    definition={definition ?? undefined}
                    capacityAh={capacityAh}
                    temperatureUnit={temperatureUnit}
                  />
                  {monitorSections?.filter(s => s.type === 'parameter-table').map((section, idx) => {
                    const params = filterParams(compactParameters, section);
                    if (params.length === 0) return null;
                    return (
                      <ParameterCategoryCard
                        key={idx}
                        category={section.title ?? 'Parameters'}
                        params={params}
                        deviceId={device.deviceId}
                        telemetry={compactTelemetry}
                        paramByKey={compactParamByKey}
                        temperatureUnit={temperatureUnit}
                      />
                    );
                  })}
                </>
              ) : (
                <>
                  {renderDefinitionSections(compactSections, compactParamByKey, compactTelemetry, dp, compactCells, selectedCellIndices, setSelectedCellIndices, device.deviceId, definition, temperatureUnit)}
                  {paramTableSections && paramTableSections.length > 0 ? (
                    <div className='grid gap-3 sm:gap-4 lg:grid-cols-2'>
                      {paramTableSections.map((section, idx) => {
                        const params = filterParams(compactParameters, section);
                        if (params.length === 0) return null;
                        if (section.groupBy === 'category') {
                          const catGroups = groupByCategory(params);
                          return Array.from(catGroups.entries()).map(([cat, catParams]) => (
                            <ParameterCategoryCard key={`${idx}-${cat}`} category={cat} params={catParams} deviceId={device.deviceId} telemetry={compactTelemetry} paramByKey={compactParamByKey} temperatureUnit={temperatureUnit} />
                          ));
                        }
                        return (
                          <ParameterCategoryCard key={idx} category={section.title ?? 'Parameters'} params={params} deviceId={device.deviceId} telemetry={compactTelemetry} paramByKey={compactParamByKey} temperatureUnit={temperatureUnit} />
                        );
                      })}
                    </div>
                  ) : (
                    <div className='grid gap-3 sm:gap-4 lg:grid-cols-2'>
                      {[...new Set(compactParameters.map(parameter => parameter.category))]
                        .filter(category => category !== 'Cell Voltages')
                        .sort((a, b) => a.localeCompare(b))
                        .map((category) => (
                          <ParameterCategoryCard
                            key={category}
                            category={category}
                            params={compactParameters.filter(parameter => parameter.category === category)}
                            deviceId={device.deviceId}
                            telemetry={compactTelemetry}
                            paramByKey={compactParamByKey}
                            temperatureUnit={temperatureUnit}
                          />
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {device.lastError && (
          <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300'>
            {device.lastError}
          </div>
        )}

        {compactWarnings.length > 0 && (
          <div className='flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 sm:px-4'>
            <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-amber-400' />
            <div className='text-sm text-amber-300'>
              <span className='font-semibold'>Active warnings: </span>
              {compactWarnings.join(', ')}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className='space-y-3 sm:space-y-4'>
      {/* Device Header */}
      <div className='flex flex-col gap-2 rounded-2xl border border-border bg-card/70 p-4 shadow-sm sm:gap-3 sm:p-5 sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex items-center gap-3'>
          <div className={cn(
            'flex h-11 w-11 items-center justify-center rounded-xl border',
            isHealthy ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' :
            isFailing ? 'border-rose-500/30 bg-rose-500/10 text-rose-400' :
            'border-border bg-muted/50 text-muted-foreground'
          )}>
            <DeviceIcon name={definition?.device.icon} className='h-5 w-5' />
          </div>
          <div>
            <div className='flex flex-wrap items-center gap-2'>
              <h3 className='text-lg font-semibold text-foreground'>{device.displayName}</h3>
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]', getOutcomeClass(device.lastOutcome))}>
                {device.lastOutcome}
              </span>
            </div>
            <div className='mt-1 text-xs font-mono text-muted-foreground'>
              {formatDeviceConnectionDescriptor(device, isPassiveAdvertisement)}
            </div>
          </div>
        </div>
        {telemetry && (
          <div className='text-xs text-muted-foreground'>
            Last update: {new Date(telemetry.collectedAt).toLocaleTimeString()}
          </div>
        )}
      </div>

      {device.lastError && (
        <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-300'>
          {device.lastError}
        </div>
      )}

      {warnings.length > 0 && (
        <div className='flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 sm:px-4'>
          <AlertTriangle className='mt-0.5 h-4 w-4 shrink-0 text-amber-400' />
          <div className='text-sm text-amber-300'>
            <span className='font-semibold'>Active warnings: </span>
            {warnings.join(', ')}
          </div>
        </div>
      )}

      {!telemetry && !device.lastError && !isPassiveAdvertisement && (
        <div className='flex items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 py-8 text-sm text-muted-foreground'>
          <LoaderCircle className='mr-2 h-4 w-4 animate-spin' /> Waiting for first reading...
        </div>
      )}

      {telemetry && (
        <>
          {/* Hero metrics — driven by definition */}
          {monitorSections ? (
            renderDefinitionSections(monitorSections, paramByKey, telemetry, dp, cells, selectedCellIndices, setSelectedCellIndices, device.deviceId, definition, temperatureUnit)
          ) : (
            <>
              {cells.length > 0 && (
                <CellVoltageChart cells={cells} minV={telemetry.minCellVoltageVolts} maxV={telemetry.maxCellVoltageVolts} avgV={telemetry.averageCellVoltageVolts} selectedCellIndices={selectedCellIndices} onCellClick={(idx) => setSelectedCellIndices(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx])} />
              )}

              <HistoryCharts deviceId={device.deviceId} precision={dp} selectedCellIndices={selectedCellIndices} onClearCellSelection={() => setSelectedCellIndices([])} temperatureUnit={temperatureUnit} />
            </>
          )}

          {/* Parameter categories */}
          {paramTableSections && paramTableSections.length > 0 ? (
            <div className='grid gap-3 sm:gap-4 lg:grid-cols-2'>
              {paramTableSections.map((section, idx) => {
                const params = filterParams(parameters, section);
                if (params.length === 0) return null;
                if (section.groupBy === 'category') {
                  const catGroups = groupByCategory(params);
                  return Array.from(catGroups.entries()).map(([cat, catParams]) => (
                    <ParameterCategoryCard key={`${idx}-${cat}`} category={cat} params={catParams} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} temperatureUnit={temperatureUnit} />
                  ));
                }
                return (
                  <ParameterCategoryCard key={idx} category={section.title ?? 'Parameters'} params={params} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} temperatureUnit={temperatureUnit} />
                );
              })}
            </div>
          ) : (
            <div className='grid gap-3 sm:gap-4 lg:grid-cols-2'>
              {sortedCategories.filter(c => c !== 'Cell Voltages').map((category) => (
                <ParameterCategoryCard key={category} category={category} params={grouped.get(category)!} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} temperatureUnit={temperatureUnit} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function HeroMetric({ icon: Icon, label, value, unit, accent, subtitle }: { icon: typeof Zap; label: string; value: string; unit: string; accent: string; subtitle?: React.ReactNode }) {
  return (
    <div data-slot='data-tile' className='rounded-2xl border border-border/80 bg-card/85 p-3 shadow-sm sm:p-5'>
      <div className='flex items-start justify-between'>
        <div>
          <div className='text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground'>{label}</div>
          <div className='mt-1.5 flex flex-wrap items-baseline gap-x-2 sm:mt-2'>
            <span className={cn('text-[1.35rem] font-bold tracking-tight sm:text-3xl', accent)}>
              {value}<span className='ml-1 text-base font-medium text-muted-foreground'>{unit}</span>
            </span>
            {subtitle}
          </div>
        </div>
        <div className='rounded-xl border border-border/70 bg-background/60 p-1.5 sm:p-2.5'>
          <Icon className='h-4 w-4 text-muted-foreground' />
        </div>
      </div>
    </div>
  );
}

function CellVoltageChart({ cells, minV, maxV, avgV, selectedCellIndices, onCellClick }: { cells: CellVoltageSnapshot[]; minV?: number | null; maxV?: number | null; avgV?: number | null; selectedCellIndices?: number[]; onCellClick?: (index: number) => void }) {
  const sorted = [...cells].sort((a, b) => a.index - b.index);
  const voltages = sorted.map(c => c.voltageVolts);
  const absMin = Math.min(...voltages);
  const absMax = Math.max(...voltages);
  const spread = Math.max(absMax - absMin, 0.001);
  // Split-axis: bottom portion covers 0V to just below the data range,
  // top portion uses a power curve (exponent 3) so 1mV near the top produces
  // a much larger visual difference than 1mV near the bottom of the detail zone.
  const basePct = 55;
  const detailPct = 100 - basePct;
  const detailFloor = Math.max(absMin - spread * 2, 0);
  const detailCeil = absMax + spread * 0.5;
  const detailRange = Math.max(detailCeil - detailFloor, 0.001);

  function barPct(v: number): number {
    if (v <= detailFloor) return Math.max((v / Math.max(detailFloor, 0.001)) * basePct, 4);
    const t = (v - detailFloor) / detailRange;          // 0..1 linear
    return basePct + Math.pow(t, 3) * detailPct;        // cubic: top mV differences are largest
  }

  return (
    <Card className='bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-3'>
        <CardTitle className='flex flex-col gap-3 text-sm lg:flex-row lg:items-center lg:justify-between'>
          <div className='flex flex-wrap items-center gap-3'>
            <div className='flex items-center gap-2' title='Cell voltages are smoothed using an Exponential Moving Average (EMA) with output hysteresis. The EMA dampens ±2mV measurement noise while tracking real trends. Hysteresis holds the reported millivolt value until the smoothed average has moved at least 1mV, preventing rounding oscillation at millivolt boundaries. A breakout threshold snaps to raw readings when sudden genuine voltage changes exceed 5mV.'>
              <Battery className='h-4 w-4 text-muted-foreground' />
              Cell Voltages
            </div>
          </div>
          <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs font-normal text-muted-foreground'>
            {minV != null && <span>Min: <span className='font-semibold text-foreground'>{minV.toFixed(3)}V</span></span>}
            {avgV != null && <span>Avg: <span className='font-semibold text-foreground'>{avgV.toFixed(3)}V</span></span>}
            {maxV != null && <span>Max: <span className='font-semibold text-foreground'>{maxV.toFixed(3)}V</span></span>}
            {minV != null && maxV != null && <span>Δ: <span className='font-semibold text-foreground'>{(maxV - minV).toFixed(3)}V</span></span>}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className='px-1 pt-2 sm:px-4 sm:pt-3'>
        <div className='pb-1 sm:pb-2'>
          <div
            className='mx-1 grid items-end gap-px pt-2 sm:mx-2 sm:gap-0.5 sm:pt-3'
            style={{ height: '164px', gridTemplateColumns: `repeat(${sorted.length}, minmax(0, 1fr))` }}
          >
          {sorted.map((cell) => {
            const pct = barPct(cell.voltageVolts);
            const isMin = cell.voltageVolts === absMin && absMin !== absMax;
            const isMax = cell.voltageVolts === absMax && absMin !== absMax;
            const isSelected = selectedCellIndices?.includes(cell.index) ?? false;

            return (
              <div
                key={cell.index}
                className='flex h-full min-w-0 flex-col items-center justify-end cursor-pointer'
                onClick={(e) => { e.stopPropagation(); onCellClick?.(cell.index); }}
              >
                <div
                  className={cn(
                    'w-full rounded-t transition-all duration-500',
                    isSelected ? 'bg-violet-500/90' :
                    isMin ? 'bg-rose-500/80' : isMax ? 'bg-emerald-500/80' : 'bg-primary/60'
                  )}
                  style={{ height: `${pct}%`, minHeight: '4px' }}
                />
                <div className='mt-0.5 text-[7px] text-muted-foreground leading-none sm:text-[9px]'>{cell.index}</div>
                <div className='text-[6px] font-semibold tabular-nums whitespace-nowrap text-muted-foreground/80 leading-none sm:text-[8px]'>
                  {cell.voltageVolts.toFixed(3)}
                </div>
              </div>
            );
          })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ParameterRow({
  param,
  deviceId,
  telemetry,
  paramByKey,
  temperatureUnit,
}: {
  param: DeviceParameter;
  deviceId: string;
  telemetry: DeviceTelemetrySnapshot;
  paramByKey: Map<string, DeviceParameter>;
  temperatureUnit: TemperatureUnit;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [writeResult, setWriteResult] = useState<{ success: boolean; message: string } | null>(null);
  const isSwitchSetting = isSwitchSettingParam(param.key);
  const statusChip = getSwitchStatusChip(param, telemetry, paramByKey);
  const value = formatParamValue(param, temperatureUnit, isSwitchSetting ? 'enabled-disabled' : 'yes-no');
  const displayUnit = getTemperatureDisplayUnit(param.unit, temperatureUnit) ?? param.unit;

  const startEdit = useCallback(() => {
    if (!param.isWritable) return;
    setEditValue(param.rawValue?.toString() ?? '');
    setIsEditing(true);
    setWriteResult(null);
  }, [param]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setWriteResult(null);
  }, []);

  const saveValue = useCallback(async () => {
    const rawValue = parseInt(editValue, 10);
    if (isNaN(rawValue) || rawValue < 0) {
      setWriteResult({ success: false, message: 'Invalid value' });
      return;
    }

    setIsSaving(true);
    setWriteResult(null);

    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/parameters/${encodeURIComponent(param.key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawValue }),
      });

      const data = await response.json().catch(() => ({})) as { success?: boolean; writtenValue?: number; readBackValue?: number; error?: string; message?: string };

      if (!response.ok) {
        setWriteResult({ success: false, message: data.message ?? 'Write failed' });
        return;
      }

      if (data.success) {
        setWriteResult({ success: true, message: `Confirmed: ${data.readBackValue}` });
        setIsEditing(false);
      } else {
        setWriteResult({ success: false, message: data.error ?? 'Verification failed' });
      }
    } catch {
      setWriteResult({ success: false, message: 'Network error' });
    } finally {
      setIsSaving(false);
    }
  }, [editValue, deviceId, param.key]);

  return (
    <div className='rounded-lg border border-border/50 bg-background/40 px-3 py-2'>
      <div className='flex items-center justify-between gap-3'>
        <span className='flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
          <span>{param.displayName}</span>
          {statusChip ? (
            <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]', statusChip.className)}>
              {statusChip.label}
            </span>
          ) : null}
        </span>
        <div className='flex items-center gap-2'>
          {isEditing ? (
            <div className='flex items-center gap-1'>
              <span className='text-[10px] text-muted-foreground/60'>raw:</span>
              <input
                type='number'
                className='w-24 rounded border border-border bg-background px-2 py-0.5 text-sm font-semibold text-foreground outline-none focus:border-primary'
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void saveValue(); if (e.key === 'Escape') cancelEdit(); }}
                disabled={isSaving}
                autoFocus
              />
              <button onClick={() => void saveValue()} disabled={isSaving}
                className='rounded p-1 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50'>
                {isSaving ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : <Check className='h-3.5 w-3.5' />}
              </button>
              <button onClick={cancelEdit} disabled={isSaving}
                className='rounded p-1 text-muted-foreground hover:bg-muted/50 disabled:opacity-50'>
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          ) : (
            <>
              <span className='text-sm font-semibold text-foreground'>
                {value}
                {displayUnit && <span className='ml-1 text-xs font-normal text-muted-foreground'>{displayUnit}</span>}
              </span>
              {param.isWritable && (
                <button onClick={startEdit} className='rounded p-1 text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition-colors'
                  title='Edit parameter'>
                  <Edit2 className='h-3 w-3' />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {writeResult && (
        <div className={cn('mt-1 text-[10px]', writeResult.success ? 'text-emerald-400' : 'text-rose-400')}>
          {writeResult.success ? '✓ ' : '✗ '}{writeResult.message}
        </div>
      )}
    </div>
  );
}

function ParameterCategoryCard({
  category,
  params,
  deviceId,
  telemetry,
  paramByKey,
  temperatureUnit,
}: {
  category: string;
  params: DeviceParameter[];
  deviceId: string;
  telemetry: DeviceTelemetrySnapshot;
  paramByKey: Map<string, DeviceParameter>;
  temperatureUnit: TemperatureUnit;
}) {
  return (
    <Card className='border border-border/80 bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-3'>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <CategoryIcon category={category} />
          {category}
        </CardTitle>
      </CardHeader>
      <CardContent className='pt-3'>
        <div className='grid gap-2'>
          {params.map((param) => (
            <ParameterRow key={param.key} param={param} deviceId={deviceId} telemetry={telemetry} paramByKey={paramByKey} temperatureUnit={temperatureUnit} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** Renders all definition-driven monitor page sections in order. */
function renderDefinitionSections(
  sections: UiSectionDefinition[],
  paramByKey: Map<string, DeviceParameter>,
  telemetry: DeviceTelemetrySnapshot,
  dp: DisplayPrecision,
  cells: CellVoltageSnapshot[],
  selectedCellIndices: number[],
  setSelectedCellIndices: React.Dispatch<React.SetStateAction<number[]>>,
  deviceId: string,
  definition: DeviceDefinition | null,
  temperatureUnit: TemperatureUnit,
) {
  const elements: React.ReactNode[] = [];
  const capacityAh = paramByKey.get('nominal_battery_capacity')?.numericValue;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    switch (section.type) {
      case 'hero-metrics':
        if (section.metrics) {
          const capacityAh = paramByKey.get('nominal_battery_capacity')?.numericValue;
          const chargeState = getRealtimeBatteryState(telemetry, paramByKey);
          elements.push(
            <div key={`section-${i}`} className='grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4'>
              {section.metrics.map((m) => {
                const param = paramByKey.get(m.entity);
                const entity = definition?.entities.find(e => e.id === m.entity) ?? definition?.computedEntities?.find(e => e.id === m.entity);
                const value = param?.numericValue;
                const sourceUnit = param?.unit ?? (entity && 'source' in entity ? entity.source?.unit : undefined) ?? (entity && 'unit' in entity ? (entity as { unit?: string }).unit : '') ?? '';
                const unit = getTemperatureDisplayUnit(sourceUnit, temperatureUnit) ?? '';
                const prec = entity?.display?.precision ?? 2;
                const displayValue = isCelsiusUnit(sourceUnit)
                  ? convertTemperatureValue(value != null ? Number(value) : null, temperatureUnit)
                  : value != null ? Number(value) : null;
                const isSoc = m.entity === 'state_of_charge';
                const isCurrent = m.entity === 'current';
                const isPower = m.entity === 'power';
                const isVoltage = m.entity === 'total_voltage';

                // Dynamic accent colors for current/power based on charge state, blue for voltage
                let accent: string;
                if (isCurrent || isPower) {
                  accent = chargeState === 'CHARGING' ? 'text-emerald-400'
                    : chargeState === 'DISCHARGING' ? 'text-rose-400'
                    : resolveColorClass(m.color);
                } else if (isVoltage) {
                  accent = 'text-sky-400';
                } else {
                  accent = resolveColorClass(m.color);
                }

                // SoC tile: inline state + rate
                let heroSubtitle: React.ReactNode | undefined;
                if (isSoc) {
                  const stateColorCls = chargeState === 'CHARGING' ? 'text-emerald-400'
                    : chargeState === 'DISCHARGING' ? 'text-rose-400'
                    : 'text-muted-foreground';
                  let rateStr = '';
                  const currentAmps = getRealtimeCurrentAmps(telemetry, paramByKey);
                  if (capacityAh && capacityAh > 0 && currentAmps != null) {
                    const rate = (currentAmps / capacityAh) * 100;
                    const sign = rate >= 0 ? '+' : '';
                    rateStr = ` ${sign}${rate.toFixed(0)} %/h`;
                  }
                  heroSubtitle = (
                    <span className={cn('text-[11px] font-semibold', stateColorCls)}>
                      {chargeState}{rateStr}
                    </span>
                  );
                }
                return (
                  <HeroMetric
                    key={m.entity}
                    icon={resolveIcon(m.icon)}
                    label={param?.displayName ?? entity?.name ?? m.entity}
                    value={fmt(displayValue, prec)}
                    unit={unit}
                    accent={accent}
                    subtitle={heroSubtitle}
                  />
                );
              })}
            </div>
          );
        }
        break;

      case 'status-indicators':
        // Status indicator pills remain collapsed into the writable switch rows,
        // now shown as labeled state chips instead of play/pause icons.
        break;

      case 'cell-chart':
        if (cells.length > 0) {
          elements.push(
            <CellVoltageChart
              key={`section-${i}`}
              cells={cells}
              minV={telemetry.minCellVoltageVolts}
              maxV={telemetry.maxCellVoltageVolts}
              avgV={telemetry.averageCellVoltageVolts}
              selectedCellIndices={selectedCellIndices}
              onCellClick={(idx) => setSelectedCellIndices(prev => prev.includes(idx) ? prev.filter(j => j !== idx) : [...prev, idx])}
            />
          );
          // History charts follow the cell chart
          elements.push(
            <HistoryCharts
              key={`section-${i}-history`}
              deviceId={deviceId}
              precision={dp}
              selectedCellIndices={selectedCellIndices}
              onClearCellSelection={() => setSelectedCellIndices([])}
              definition={definition ?? undefined}
              capacityAh={capacityAh}
              temperatureUnit={temperatureUnit}
            />
          );
        }
        break;

      // parameter-table sections are handled separately below the main sections
    }
  }

  // If no cell-chart section, still show history charts
  if (!sections.some(s => s.type === 'cell-chart')) {
    elements.push(
      <HistoryCharts
        key='history-fallback'
        deviceId={deviceId}
        precision={dp}
        selectedCellIndices={selectedCellIndices}
        onClearCellSelection={() => setSelectedCellIndices([])}
        definition={definition ?? undefined}
        capacityAh={capacityAh}
        temperatureUnit={temperatureUnit}
      />
    );
  }

  return <>{elements}</>;
}

/** Maps icon name strings from the device definition to Lucide icon components. */
const iconLookup: Record<string, typeof Zap> = {
  zap: Zap,
  activity: Activity,
  gauge: Gauge,
  battery: Battery,
  'battery-charging': BatteryCharging,
  thermometer: Thermometer,
  shield: Shield,
};

function resolveIcon(name?: string): typeof Zap {
  if (!name) return Activity;
  return iconLookup[name.toLowerCase()] ?? Activity;
}

function DeviceIcon({ name, className }: { name?: string; className?: string }) {
  if (name && (name.startsWith('data:image/') || name.startsWith('/') || name.startsWith('./') || name.startsWith('../'))) {
    return <img src={name} alt='' className={cn(className, 'rounded-md object-cover')} />;
  }

  const Icon = resolveIcon(name);
  return <Icon className={className} />;
}

function StatusGlyph({
  title,
  toneClassName,
  children,
}: {
  title: string;
  toneClassName: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/70 bg-background/45',
        toneClassName
      )}
    >
      {children}
    </span>
  );
}

function resolveConfiguredStatusGlyphs(
  statusGlyphs: UiStatusGlyphDefinition[],
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
  nowMs: number,
  isPassiveAdvertisement: boolean,
): ResolvedStatusGlyph[] {
  return statusGlyphs
    .map((statusGlyph, index) => resolveConfiguredStatusGlyph(statusGlyph, index, telemetry, paramByKey, nowMs, isPassiveAdvertisement))
    .filter((statusGlyph): statusGlyph is ResolvedStatusGlyph => statusGlyph != null);
}

function resolveConfiguredStatusGlyph(
  statusGlyph: UiStatusGlyphDefinition,
  index: number,
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
  nowMs: number,
  isPassiveAdvertisement: boolean,
): ResolvedStatusGlyph | null {
  switch (statusGlyph.type) {
    case 'last-seen':
      return resolveLastSeenStatusGlyph(statusGlyph, index, telemetry.collectedAt, nowMs, isPassiveAdvertisement);
    case 'signal-strength':
      return resolveNumericStatusGlyph(statusGlyph, index, 'Signal', statusGlyph.entity, paramByKey, statusGlyph.icon ?? 'signal');
    case 'battery-level':
      return resolveNumericStatusGlyph(statusGlyph, index, 'Battery', statusGlyph.entity, paramByKey, statusGlyph.icon ?? 'battery');
    case 'state':
      return resolveStateStatusGlyph(statusGlyph, index, telemetry, paramByKey);
    default:
      return null;
  }
}

function resolveLastSeenStatusGlyph(
  statusGlyph: UiStatusGlyphDefinition,
  index: number,
  collectedAt: string | null | undefined,
  nowMs: number,
  isPassiveAdvertisement: boolean,
): ResolvedStatusGlyph {
  const ageSeconds = getRelativeAdvertisementAgeSeconds(collectedAt, nowMs);
  if (ageSeconds == null || !collectedAt) {
    return {
      key: `status-${index}`,
      title: isPassiveAdvertisement ? 'Listening for a first signal' : 'Last seen unavailable',
      toneClassName: 'text-muted-foreground/55',
      icon: renderStatusGlyphIcon(statusGlyph.icon ?? 'pulse'),
    };
  }

  const collectedMs = Date.parse(collectedAt);
  if (Number.isNaN(collectedMs)) {
    return {
      key: `status-${index}`,
      title: 'Last seen unavailable',
      toneClassName: 'text-muted-foreground/55',
      icon: renderStatusGlyphIcon(statusGlyph.icon ?? 'pulse'),
    };
  }

  const matchedLevel = findMatchingAgeLevel(ageSeconds, statusGlyph.levels);
  const ageDescription = matchedLevel?.label ?? describeAdvertisementAge(ageSeconds);

  return {
    key: `status-${index}`,
    title: `Last seen ${ageDescription} (${new Date(collectedMs).toISOString()})`,
    toneClassName: resolveStatusGlyphToneClassName(matchedLevel?.color),
    icon: renderStatusGlyphIcon(statusGlyph.icon ?? 'pulse'),
  };
}

function resolveNumericStatusGlyph(
  statusGlyph: UiStatusGlyphDefinition,
  index: number,
  fallbackLabel: string,
  entityId: string | undefined,
  paramByKey: Map<string, DeviceParameter>,
  iconName: string,
): ResolvedStatusGlyph | null {
  if (!entityId) {
    return null;
  }

  const param = paramByKey.get(entityId);
  const value = param?.numericValue;
  if (value == null || !Number.isFinite(value)) {
    return null;
  }

  const matchedLevel = findMatchingNumericLevel(value, statusGlyph.levels);
  const normalizedPercent = normalizeStatusPercent(value);

  return {
    key: `status-${index}`,
    title: `${param?.displayName ?? fallbackLabel} ${Math.round(value)}%`,
    toneClassName: matchedLevel != null
      ? resolveStatusGlyphToneClassName(matchedLevel.color)
      : iconName === 'battery'
        ? getBatteryStatusToneClassName(value)
        : getSignalStatusToneClassName(value),
    icon: renderStatusGlyphIcon(iconName, normalizedPercent == null ? undefined : { percent: normalizedPercent }),
  };
}

function resolveStateStatusGlyph(
  statusGlyph: UiStatusGlyphDefinition,
  index: number,
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
): ResolvedStatusGlyph | null {
  for (const state of statusGlyph.states ?? []) {
    const entityValue = resolveBooleanStatusEntityValue(state.entity, telemetry, paramByKey);
    const expectedValue = state.equals ?? true;
    if (entityValue !== expectedValue) {
      continue;
    }

    return {
      key: `status-${index}-${state.entity}`,
      title: state.title ?? state.entity,
      toneClassName: resolveStatusGlyphToneClassName(state.color),
      icon: renderStatusGlyphIcon(state.icon ?? statusGlyph.icon ?? 'activity'),
    };
  }

  if (!statusGlyph.defaultIcon && !statusGlyph.defaultTitle) {
    return null;
  }

  return {
    key: `status-${index}`,
    title: statusGlyph.defaultTitle ?? 'Status unavailable',
    toneClassName: resolveStatusGlyphToneClassName(statusGlyph.defaultColor),
    icon: renderStatusGlyphIcon(statusGlyph.defaultIcon ?? statusGlyph.icon ?? 'activity'),
  };
}

function resolveBooleanStatusEntityValue(
  entityId: string,
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
): boolean | null {
  const paramValue = paramByKey.get(entityId)?.booleanValue;
  if (paramValue != null) {
    return paramValue;
  }

  const batteryState = getRealtimeBatteryState(telemetry, paramByKey);

  switch (entityId) {
    case 'charging_active':
      return batteryState == null ? null : batteryState === 'CHARGING';
    case 'discharging_active':
      return batteryState == null ? null : batteryState === 'DISCHARGING';
    case 'charging_enabled':
      return telemetry.chargingEnabled ?? (batteryState === 'CHARGING');
    case 'discharging_enabled':
      return telemetry.dischargingEnabled ?? (batteryState === 'DISCHARGING');
    case 'balancing_enabled':
      return telemetry.balancingEnabled ?? null;
    default:
      return null;
  }
}

function findMatchingNumericLevel(
  value: number,
  levels: UiStatusGlyphLevelDefinition[] | undefined,
): UiStatusGlyphLevelDefinition | null {
  if (!levels || levels.length === 0) {
    return null;
  }

  return levels.find((level) => {
    const matchesMin = level.minValue == null || value >= level.minValue;
    const matchesMax = level.maxValue == null || value <= level.maxValue;
    return matchesMin && matchesMax;
  }) ?? null;
}

function findMatchingAgeLevel(
  ageSeconds: number,
  levels: UiStatusGlyphLevelDefinition[] | undefined,
): UiStatusGlyphLevelDefinition | null {
  if (!levels || levels.length === 0) {
    return null;
  }

  return levels.find((level) => level.maxAgeSeconds == null || ageSeconds <= level.maxAgeSeconds) ?? null;
}

function describeAdvertisementAge(ageSeconds: number) {
  if (ageSeconds < 60) {
    return 'less than a minute ago';
  }

  if (ageSeconds < 300) {
    return 'less than 5 minutes ago';
  }

  return 'more than 5 minutes ago';
}

function resolveStatusGlyphToneClassName(color?: string) {
  return color ? resolveColorClass(color) : 'text-muted-foreground/55';
}

function renderStatusGlyphIcon(
  name: string,
  options?: { percent?: number },
): React.ReactNode {
  switch (name.toLowerCase()) {
    case 'battery':
      return <BatteryStatusGlyph percent={options?.percent} />;
    case 'signal':
      return <SignalStatusGlyph percent={options?.percent} />;
    case 'pulse':
      return <SeenStatusGlyph />;
    case 'battery-discharging':
      return <BatteryDischargingStatusGlyph />;
    default:
      return <DeviceIcon name={name} className='h-4 w-4' />;
  }
}

function getRealtimeCurrentAmps(
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
): number | null {
  if (telemetry.currentAmps != null && Number.isFinite(telemetry.currentAmps)) {
    return telemetry.currentAmps;
  }

  const currentValue = paramByKey.get('current')?.numericValue;
  return currentValue != null && Number.isFinite(currentValue)
    ? currentValue
    : null;
}

function getRealtimeBatteryState(
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
) {
  const currentAmps = getRealtimeCurrentAmps(telemetry, paramByKey);
  return currentAmps == null
    ? 'IDLE'
    : getBatteryStateFromCurrent(currentAmps);
}

function BatteryStatusGlyph({ percent }: { percent: number | null | undefined }) {
  const normalizedPercent = normalizeStatusPercent(percent);
  const activeSegments = normalizedPercent == null
    ? 0
    : normalizedPercent >= 88
      ? 4
      : normalizedPercent >= 63
        ? 3
        : normalizedPercent >= 38
          ? 2
          : normalizedPercent >= 13
            ? 1
            : 0;

  return (
    <svg viewBox='0 0 18 18' className='h-4 w-4 fill-current' aria-hidden='true'>
      <rect x='2.25' y='4.5' width='12' height='9' rx='1.5' fill='none' stroke='currentColor' strokeWidth='1.5' />
      <rect x='14.75' y='7' width='1.75' height='4' rx='0.75' />
      {[0, 1, 2, 3].map((segment) => (
        <rect
          key={segment}
          x={3.5 + (segment * 2.5)}
          y='6'
          width='1.75'
          height='6'
          rx='0.5'
          className={segment < activeSegments ? 'opacity-100' : 'opacity-15'}
        />
      ))}
    </svg>
  );
}

function SignalStatusGlyph({ percent }: { percent: number | null | undefined }) {
  const normalizedPercent = normalizeStatusPercent(percent);
  const activeBars = normalizedPercent == null
    ? 0
    : normalizedPercent >= 75
      ? 4
      : normalizedPercent >= 50
        ? 3
        : normalizedPercent >= 25
          ? 2
          : normalizedPercent > 0
            ? 1
            : 0;

  return (
    <svg viewBox='0 0 18 18' className='h-4 w-4 fill-current' aria-hidden='true'>
      {[0, 1, 2, 3].map((bar) => (
        <rect
          key={bar}
          x={3 + (bar * 3)}
          y={11 - (bar * 2)}
          width='2'
          height={3 + (bar * 2)}
          rx='0.75'
          className={bar < activeBars ? 'opacity-100' : 'opacity-15'}
        />
      ))}
    </svg>
  );
}

function SeenStatusGlyph() {
  return (
    <svg viewBox='0 0 18 18' className='h-4 w-4 fill-none stroke-current' aria-hidden='true'>
      <path
        d='M2.25 9h2.4l1.35-2.6 2.1 5.2 2.15-5.05 1.55 2.45h3.95'
        strokeWidth='1.5'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  );
}

function BatteryDischargingStatusGlyph() {
  return (
    <svg viewBox='0 0 18 18' className='h-4 w-4 fill-none stroke-current' aria-hidden='true'>
      <rect x='2.25' y='4.5' width='12' height='9' rx='1.5' strokeWidth='1.5' />
      <rect x='14.75' y='7' width='1.75' height='4' rx='0.75' fill='currentColor' stroke='none' />
      <path d='M8.25 6.5v4.25' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
      <path d='M6.75 9.5 8.25 11l1.5-1.5' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
    </svg>
  );
}

function normalizeStatusPercent(percent: number | null | undefined) {
  if (percent == null || !Number.isFinite(percent)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

function getBatteryStatusToneClassName(percent: number | null | undefined) {
  const normalizedPercent = normalizeStatusPercent(percent);
  if (normalizedPercent == null) {
    return 'text-muted-foreground/55';
  }

  if (normalizedPercent <= 15) {
    return 'text-rose-400';
  }

  if (normalizedPercent <= 35) {
    return 'text-amber-400';
  }

  return 'text-emerald-400';
}

function getSignalStatusToneClassName(percent: number | null | undefined) {
  const normalizedPercent = normalizeStatusPercent(percent);
  if (normalizedPercent == null) {
    return 'text-muted-foreground/55';
  }

  if (normalizedPercent < 25) {
    return 'text-rose-400';
  }

  if (normalizedPercent < 55) {
    return 'text-amber-400';
  }

  return 'text-sky-400';
}

function getAdvertisementStatusToneClassName(ageSeconds: number | null) {
  if (ageSeconds == null) {
    return 'text-muted-foreground/55';
  }

  if (ageSeconds < 60) {
    return 'text-emerald-400';
  }

  if (ageSeconds < 300) {
    return 'text-amber-400';
  }

  return 'text-rose-400';
}

function formatAdvertisementStatusTitle(collectedAt: string | null | undefined, nowMs: number) {
  const ageSeconds = getRelativeAdvertisementAgeSeconds(collectedAt, nowMs);
  if (ageSeconds == null || !collectedAt) {
    return 'Last seen unavailable';
  }

  const collectedMs = Date.parse(collectedAt);
  if (Number.isNaN(collectedMs)) {
    return 'Last seen unavailable';
  }

  const ageDescription = ageSeconds < 60
    ? 'less than a minute ago'
    : ageSeconds < 300
      ? 'less than 5 minutes ago'
      : 'more than 5 minutes ago';

  return `Last seen ${ageDescription} (${new Date(collectedMs).toISOString()})`;
}

function formatDeviceConnectionDescriptor(
  device: Pick<DeviceRuntimeState, 'deviceId' | 'definitionId' | 'protocolHandler' | 'pollIntervalMilliseconds'>,
  isPassiveAdvertisement: boolean,
) {
  const handler = device.protocolHandler ?? device.definitionId;
  if (isPassiveAdvertisement) {
    return `${device.deviceId} • ${handler} • passive listener`;
  }

  return `${device.deviceId} • ${handler} • ${device.pollIntervalMilliseconds}ms`;
}

/** Maps color name strings from the device definition to Tailwind text-color classes. */
const colorClassLookup: Record<string, string> = {
  emerald: 'text-emerald-400',
  green: 'text-emerald-400',
  blue: 'text-sky-400',
  sky: 'text-sky-400',
  amber: 'text-amber-400',
  yellow: 'text-amber-400',
  red: 'text-rose-400',
  rose: 'text-rose-400',
  purple: 'text-purple-400',
  violet: 'text-violet-400',
  teal: 'text-teal-400',
  orange: 'text-orange-400',
};

function resolveColorClass(name?: string): string {
  if (!name) return 'text-primary';
  return colorClassLookup[name.toLowerCase()] ?? 'text-primary';
}

/** Filters parameters based on a UI section filter definition. */
function filterParams(allParams: DeviceParameter[], section: UiSectionDefinition): DeviceParameter[] {
  let result = allParams;
  const f = section.filter;
  if (f?.writable) result = result.filter(p => p.isWritable);
  if (f?.categories) result = result.filter(p => f.categories!.includes(p.category));
  return result;
}

/** Groups parameters into a map keyed by category. */
function groupByCategory(params: DeviceParameter[]): Map<string, DeviceParameter[]> {
  const map = new Map<string, DeviceParameter[]>();
  for (const p of params) {
    if (!map.has(p.category)) map.set(p.category, []);
    map.get(p.category)!.push(p);
  }
  return map;
}

/** Returns sorted category names. Uses definition entity order when available, otherwise legacy fallback. */
function getSortedCategories(grouped: Map<string, DeviceParameter[]>, definition?: DeviceDefinition | null): string[] {
  if (definition) {
    // Derive order from entity declaration order
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const e of definition.entities) {
      if (!seen.has(e.category) && grouped.has(e.category)) {
        seen.add(e.category);
        ordered.push(e.category);
      }
    }
    if (definition.computedEntities) {
      for (const e of definition.computedEntities) {
        if (!seen.has(e.category) && grouped.has(e.category)) {
          seen.add(e.category);
          ordered.push(e.category);
        }
      }
    }
    // Append any remaining categories not in the definition
    for (const cat of grouped.keys()) {
      if (!seen.has(cat)) ordered.push(cat);
    }
    return ordered;
  }

  // Fallback: alphabetical order when no definition
  return [...grouped.keys()].sort((a, b) => a.localeCompare(b));
}

function CategoryIcon({ category }: { category: string }) {
  switch (category) {
    case 'Pack Status':
      return <Zap className='h-4 w-4 text-sky-400' />;
    case 'Cell Summary':
    case 'Cell Voltages':
      return <Battery className='h-4 w-4 text-emerald-400' />;
    case 'Temperatures':
      return <Thermometer className='h-4 w-4 text-amber-400' />;
    case 'Status':
      return <Activity className='h-4 w-4 text-primary' />;
    case 'Cell Protection':
    case 'Current Protection':
    case 'Thermal Protection':
      return <Shield className='h-4 w-4 text-rose-400' />;
    case 'Balance Settings':
    case 'SOC Settings':
    case 'System':
      return <Activity className='h-4 w-4 text-violet-400' />;
    case 'Charging':
    case 'Discharging':
      return <BatteryCharging className='h-4 w-4 text-sky-400' />;
    case 'Device Info':
      return <Activity className='h-4 w-4 text-teal-400' />;
    default:
      return <Activity className='h-4 w-4 text-muted-foreground' />;
  }
}

function isSwitchSettingParam(key: string): boolean {
  return key === 'charge_switch' || key === 'discharge_switch' || key === 'balancer_switch';
}

function buildSwitchStatusChip(
  isActive: boolean | null | undefined,
  activeLabel: string,
  inactiveLabel: string,
): SwitchStatusChip | null {
  if (isActive == null) return null;

  return {
    label: isActive ? activeLabel : inactiveLabel,
    className: isActive
      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300'
      : 'border-border bg-muted/70 text-muted-foreground',
  };
}

function getSwitchStatusChip(
  param: DeviceParameter,
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
): SwitchStatusChip | null {
  const batteryState = getRealtimeBatteryState(telemetry, paramByKey);

  switch (param.key) {
    case 'charge_switch': {
      const isActive = paramByKey.get('charging_enabled')?.booleanValue
        ?? telemetry.chargingEnabled
        ?? (batteryState === 'CHARGING');
      return buildSwitchStatusChip(isActive, 'Charging now', 'Not charging');
    }
    case 'discharge_switch': {
      const isActive = paramByKey.get('discharging_enabled')?.booleanValue
        ?? telemetry.dischargingEnabled
        ?? (batteryState === 'DISCHARGING');
      return buildSwitchStatusChip(isActive, 'Discharging now', 'Not discharging');
    }
    case 'balancer_switch': {
      const isActive = paramByKey.get('balancing_enabled')?.booleanValue
        ?? telemetry.balancingEnabled
        ?? null;
      return buildSwitchStatusChip(isActive, 'Balancing now', 'Not balancing');
    }
    default:
      return null;
  }
}

function formatParamValue(
  param: DeviceParameter,
  temperatureUnit: TemperatureUnit,
  booleanStyle: 'yes-no' | 'enabled-disabled' = 'yes-no',
): string {
  if (param.booleanValue != null) {
    if (booleanStyle === 'enabled-disabled') {
      return param.booleanValue ? 'Enabled' : 'Disabled';
    }
    return param.booleanValue ? 'Yes' : 'No';
  }
  if (param.numericValue != null) {
    const sourceValue = Number(param.numericValue);
    const displayValue = isCelsiusUnit(param.unit)
      ? convertTemperatureValue(sourceValue, temperatureUnit)
      : sourceValue;
    if (displayValue == null || !Number.isFinite(displayValue)) {
      return nd;
    }

    if (Number.isInteger(displayValue)) return displayValue.toLocaleString();
    return displayValue.toFixed(Math.abs(displayValue) >= 100 ? 1 : 3);
  }
  if (param.stringValue != null) {
    return param.stringValue;
  }
  return nd;
}

function fmt(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return nd;
  return value.toFixed(decimals);
}

function getOutcomeClass(outcome: string): string {
  switch (outcome) {
    case 'Succeeded':
      return 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-300';
    case 'Listening':
      return 'border border-border bg-muted/60 text-muted-foreground';
    case 'PersistFailed':
      return 'border border-amber-500/20 bg-amber-500/10 text-amber-300';
    case 'Failed':
      return 'border border-rose-500/20 bg-rose-500/10 text-rose-300';
    default:
      return 'border border-border bg-muted/70 text-muted-foreground';
  }
}
