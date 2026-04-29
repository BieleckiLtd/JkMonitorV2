import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Battery, BatteryCharging, Check, ChevronDown, ChevronUp, Edit2, Gauge, Leaf, LoaderCircle, Shield, Thermometer, X, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { HistoryCharts } from '../components/HistoryCharts';
import { cn } from '../lib/utils';
import { getBatteryStateFromCurrent } from '../lib/batteryStatus';
import { useDeviceDefinition } from '../hooks/useDeviceDefinition';
import type {
  ComputedEntityDefinition,
  DeviceDefinition,
  EntityDefinition,
  UiMetricDefinition,
  UiSectionDefinition,
  UiStatusGlyphDefinition,
  UiStatusGlyphLevelDefinition,
} from '../types/deviceDefinition';
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
  options?: { value: number; label: string }[] | null;
  displayFormatter?: string | null;
  displayPrecision?: number | null;
};

type ParameterWriteResult = {
  success: boolean;
  message: string;
};

type BatchWriteResponse = {
  success?: boolean;
  results?: {
    parameterKey?: string;
    success?: boolean;
    writtenValue?: number;
    readBackValue?: number;
    error?: string | null;
  }[];
  message?: string;
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
const inverterCompactHeroMetrics: UiMetricDefinition[] = [
  { entity: 'grid_power', icon: 'zap', color: 'gray', label: 'Grid', format: 'power-short' },
  { entity: 'battery_power', icon: 'battery', color: 'emerald', label: 'Battery', format: 'power-short' },
  { entity: 'pv_power', icon: 'zap', color: 'amber', label: 'Solar', format: 'power-short' },
  { entity: 'output_active_power', icon: 'gauge', color: 'blue', label: 'Load', format: 'power-short' },
];

function hasCompactInverterPowerMetrics(paramByKey: Map<string, DeviceParameter>) {
  return inverterCompactHeroMetrics.every(metric => paramByKey.has(metric.entity));
}

type DeviceRuntimeState = {
  deviceId: string;
  displayName: string;
  sortOrder?: number;
  definitionId: string;
  protocolHandler?: string | null;
  address?: number | null;
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

function resolveCompactMonitorCardKind(
  device: DeviceRuntimeState,
  definition: DeviceDefinition | null,
): 'environment' | 'inverter' | 'jk-bms' | null {
  const category = definition?.device.category?.toLowerCase();
  if (category === 'environment') {
    return 'environment';
  }

  if (category === 'inverter') {
    return 'inverter';
  }

  if (definition?.device.manufacturer?.toLowerCase() === 'jk') {
    return 'jk-bms';
  }

  const definitionId = device.definitionId.trim().toLowerCase();
  if (!definitionId) {
    return null;
  }

  if (definitionId.includes('thermo') || definitionId.includes('hygrometer') || definitionId.includes('environment')) {
    return 'environment';
  }

  if (definitionId.includes('inverter')) {
    return 'inverter';
  }

  if (definitionId.startsWith('jk') || definitionId.includes('jk-bms')) {
    return 'jk-bms';
  }

  return null;
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
  variant?: 'icon' | 'badge';
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
  const definition = useDeviceDefinition(device.definitionId, device.deviceId);
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
  const compactMonitorCardKind = resolveCompactMonitorCardKind(device, definition);
  const isEnvironment = compactMonitorCardKind === 'environment';
  const isInverter = compactMonitorCardKind === 'inverter';
  const isJkBms = compactMonitorCardKind === 'jk-bms';
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
  if (isEnvironment || ((isInverter || isJkBms) && telemetry)) {
    const compactTelemetry = telemetry ?? emptyTelemetrySnapshot;
    const compactParameters = compactTelemetry.parameters ?? [];
    const compactCells = compactTelemetry.cells ?? [];
    const compactWarnings = compactTelemetry.activeWarnings ?? [];
    const compactParamByKey = new Map(compactParameters.map(p => [p.key, p]));
    const heroSection = monitorSections?.find(s => s.type === 'hero-metrics');
    const heroMetrics = isInverter || hasCompactInverterPowerMetrics(compactParamByKey)
      ? inverterCompactHeroMetrics
      : heroSection?.metrics ?? [];
    const batteryParam = compactParamByKey.get('battery_pct');
    const batteryValue = batteryParam?.numericValue;
    const signalValue = compactParamByKey.get('signal_strength_pct')?.numericValue;
    const capacityAh = compactParamByKey.get('nominal_battery_capacity')?.numericValue;
    const advertisementAgeSeconds = getRelativeAdvertisementAgeSeconds(telemetry?.collectedAt, nowMs);
    const compactSections = monitorSections?.filter(section => section.type !== 'hero-metrics' && section.type !== 'parameter-table') ?? [];
    const statusGlyphDefinitions = definition?.ui?.pages?.monitor?.card?.statusGlyphs;
    const headerStatusGlyphs = isInverter
      ? resolveInverterStatusGlyphs(statusGlyphDefinitions, compactTelemetry, compactParamByKey, nowMs, isPassiveAdvertisement)
      : statusGlyphDefinitions != null
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
                    <StatusGlyph key={glyph.key} title={glyph.title} toneClassName={glyph.toneClassName} variant={glyph.variant}>
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
              {(() => {
                const sharedPowerKilowatts = shouldUseSharedPowerKilowatts(heroMetrics, compactParamByKey, definition);

                return heroMetrics.map((m) => {
                  const param = compactParamByKey.get(m.entity);
                  const entity = findMetricEntity(definition, m.entity);
                  const value = param?.numericValue;
                  const sourceUnit = getMetricSourceUnit(param, entity);
                  const unit = getTemperatureDisplayUnit(sourceUnit, temperatureUnit) ?? '';
                  const prec = entity?.display?.precision ?? 2;
                  const displayValue = isCelsiusUnit(sourceUnit)
                    ? convertTemperatureValue(value != null ? Number(value) : null, temperatureUnit)
                    : value != null ? Number(value) : null;
                  const metricDisplay = formatMetricDisplayValue(displayValue, unit, prec, m, {
                    forcePowerShortKilowatts: sharedPowerKilowatts,
                  });
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
                        {m.label ?? param?.displayName ?? entity?.name ?? m.entity}
                      </div>
                      <div className='mt-1 flex items-baseline gap-1'>
                        <span className={cn('text-xl font-bold tracking-tight tabular-nums sm:text-2xl', accentClass)}>
                          {metricDisplay.valueText}
                        </span>
                        <span className='text-xs font-medium text-muted-foreground/70'>{metricDisplay.unitText}</span>
                      </div>
                    </div>
                  );
                });
              })()}
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
                        definition={definition}
                        temperatureUnit={temperatureUnit}
                      />
                    );
                  })}
                </>
              ) : (
                <>
                  {renderInlineEntityStats(
                    heroSection?.entities,
                    compactParamByKey,
                    definition,
                    temperatureUnit,
                  )}
                  {renderDefinitionSections(compactSections, compactParamByKey, compactTelemetry, dp, compactCells, selectedCellIndices, setSelectedCellIndices, device.deviceId, definition, temperatureUnit)}
                  {paramTableSections && paramTableSections.length > 0 ? (
                    <div className='space-y-3 sm:space-y-4'>
                      {paramTableSections.map((section, idx) => {
                        const params = filterParams(compactParameters, section);
                        if (params.length === 0) return null;
                        if (section.groupBy === 'category') {
                          const catGroups = groupByCategory(params);
                          return Array.from(catGroups.entries()).map(([cat, catParams]) => (
                            <ParameterCategoryCard key={`${idx}-${cat}`} category={cat} params={catParams} deviceId={device.deviceId} telemetry={compactTelemetry} paramByKey={compactParamByKey} definition={definition} temperatureUnit={temperatureUnit} />
                          ));
                        }
                        return (
                          <ParameterCategoryCard key={idx} category={section.title ?? 'Parameters'} params={params} deviceId={device.deviceId} telemetry={compactTelemetry} paramByKey={compactParamByKey} definition={definition} temperatureUnit={temperatureUnit} />
                        );
                      })}
                    </div>
                  ) : (
                    <div className='space-y-3 sm:space-y-4'>
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
                            definition={definition}
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
            <div className='space-y-3 sm:space-y-4'>
              {paramTableSections.map((section, idx) => {
                const params = filterParams(parameters, section);
                if (params.length === 0) return null;
                if (section.groupBy === 'category') {
                  const catGroups = groupByCategory(params);
                  return Array.from(catGroups.entries()).map(([cat, catParams]) => (
                    <ParameterCategoryCard key={`${idx}-${cat}`} category={cat} params={catParams} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} definition={definition} temperatureUnit={temperatureUnit} />
                  ));
                }
                return (
                  <ParameterCategoryCard key={idx} category={section.title ?? 'Parameters'} params={params} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} definition={definition} temperatureUnit={temperatureUnit} />
                );
              })}
            </div>
          ) : (
            <div className='space-y-3 sm:space-y-4'>
              {sortedCategories.filter(c => c !== 'Cell Voltages').map((category) => (
                <ParameterCategoryCard key={category} category={category} params={grouped.get(category)!} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} definition={definition} temperatureUnit={temperatureUnit} />
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

function renderInlineEntityStats(
  entityIds: readonly string[] | undefined,
  paramByKey: Map<string, DeviceParameter>,
  definition: DeviceDefinition | null | undefined,
  temperatureUnit: TemperatureUnit,
) {
  if (!entityIds?.length) {
    return null;
  }

  const items = entityIds
    .map((entityId) => {
      const param = paramByKey.get(entityId);
      if (!param) {
        return null;
      }

      const entity = definition?.entities.find((candidate) => candidate.id === entityId);
      const value = formatParamValue(param, temperatureUnit, 'yes-no', entity?.display?.precision ?? param.displayPrecision);
      const unit = getTemperatureDisplayUnit(param.unit, temperatureUnit) ?? param.unit ?? '';

      return (
        <HeroInlineMetric
          key={entityId}
          label={param.displayName ?? entity?.name ?? entityId}
          value={value}
          unit={unit}
        />
      );
    })
    .filter(Boolean);

  if (items.length === 0) {
    return null;
  }

  return (
    <div className='grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4'>
      {items}
    </div>
  );
}

function HeroInlineMetric({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className='rounded-xl border border-border/70 bg-background/50 px-3 py-2.5'>
      <div className='text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>{label}</div>
      <div className='mt-1 break-words text-sm font-semibold text-foreground sm:text-base'>
        {value}
        {unit ? <span className='ml-1 text-xs font-medium text-muted-foreground'>{unit}</span> : null}
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
  definition,
  temperatureUnit,
}: {
  param: DeviceParameter;
  deviceId: string;
  telemetry: DeviceTelemetrySnapshot;
  paramByKey: Map<string, DeviceParameter>;
  definition?: DeviceDefinition | null;
  temperatureUnit: TemperatureUnit;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [writeResult, setWriteResult] = useState<{ success: boolean; message: string } | null>(null);
  const isSwitchSetting = isSwitchSettingParam(param.key);
  const statusChip = getSwitchStatusChip(param, telemetry, paramByKey);
  const editBlockedReason = getParameterEditBlockedReason(param, telemetry, paramByKey, definition);
  const canEdit = Boolean(param.isWritable) && editBlockedReason == null;
  const entity = definition?.entities.find((candidate) => candidate.id === param.key);
  const value = formatParamValue(
    param,
    temperatureUnit,
    isSwitchSetting ? 'enabled-disabled' : 'yes-no',
    entity?.display?.precision ?? param.displayPrecision,
  );
  const displayUnit = getTemperatureDisplayUnit(param.unit, temperatureUnit) ?? param.unit;
  const editModeLabel = entity ? 'value:' : 'raw:';
  const editValueUnit = entity
    ? getTemperatureDisplayUnit(entity.source.unit ?? param.unit, temperatureUnit) ?? param.unit
    : param.unit;

  const startEdit = useCallback(() => {
    if (!canEdit) return;
    setEditValue(param.options?.length
      ? (param.rawValue?.toString() ?? '')
      : formatEditableParameterInputValue(param, entity, temperatureUnit));
    setIsEditing(true);
    setWriteResult(null);
  }, [canEdit, param, entity, temperatureUnit]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setWriteResult(null);
  }, []);

  const saveValue = useCallback(async () => {
    const parsedRawValue = param.options?.length
      ? parseRawSelectValue(editValue)
      : parseParameterInputValue(editValue, param, entity, temperatureUnit);
    if (!parsedRawValue.success) {
      setWriteResult({ success: false, message: parsedRawValue.message });
      return;
    }
    const rawValue = parsedRawValue.rawValue;

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
        const confirmedValue = data.readBackValue ?? rawValue;
        const confirmationText = param.options?.length
          ? formatSelectParameterValue(param, confirmedValue)
          : formatParameterReadBackValue(confirmedValue, param, entity, temperatureUnit);
        setWriteResult({ success: true, message: `Confirmed: ${confirmationText}` });
        setIsEditing(false);
      } else {
        setWriteResult({ success: false, message: data.error ?? 'Verification failed' });
      }
    } catch {
      setWriteResult({ success: false, message: 'Network error' });
    } finally {
      setIsSaving(false);
    }
  }, [deviceId, editValue, entity, param, temperatureUnit]);

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
              {param.options?.length ? (
                <select
                  className='rounded border border-border bg-background px-2 py-0.5 text-sm font-semibold text-foreground outline-none focus:border-primary'
                  value={editValue}
                  onChange={e => setEditValue(e.target.value)}
                  disabled={isSaving}
                  autoFocus
                >
                  {param.options?.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              ) : (
                <>
                  <span className='text-[10px] text-muted-foreground/60'>{editModeLabel}</span>
                  <input
                    type='number'
                    step={entity ? getEditableDisplayStep(entity, param, temperatureUnit) : 'any'}
                    inputMode='decimal'
                    aria-label={`Set ${param.displayName}`}
                    className='w-24 rounded border border-border bg-background px-2 py-0.5 text-sm font-semibold text-foreground outline-none focus:border-primary'
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void saveValue(); if (e.key === 'Escape') cancelEdit(); }}
                    disabled={isSaving}
                    autoFocus
                  />
                  {editValueUnit && <span className='text-[10px] text-muted-foreground/60'>{editValueUnit}</span>}
                </>
              )}
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
                {displayUnit && <span className='ml-1 text-xs font-normal text-muted-foreground'> {displayUnit}</span>}
              </span>
              {param.isWritable && (
                <button
                  onClick={startEdit}
                  disabled={!canEdit}
                  aria-label={`Edit ${param.displayName}`}
                  className={cn(
                    'rounded p-1 transition-colors',
                    canEdit
                      ? 'text-muted-foreground/60 hover:bg-primary/10 hover:text-primary'
                      : 'cursor-not-allowed text-muted-foreground/30',
                  )}
                  title={editBlockedReason ?? 'Edit parameter'}>
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
      {!writeResult && editBlockedReason && (
        <div className='mt-1 text-[10px] text-muted-foreground'>
          {editBlockedReason}
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
  definition,
  temperatureUnit,
}: {
  category: string;
  params: DeviceParameter[];
  deviceId: string;
  telemetry: DeviceTelemetrySnapshot;
  paramByKey: Map<string, DeviceParameter>;
  definition?: DeviceDefinition | null;
  temperatureUnit: TemperatureUnit;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const combinedClockParams = getCombinedClockParams(params, definition);
  const visibleParams = combinedClockParams == null
    ? params
    : params.filter((param) => !inverterClockParameterKeySet.has(param.key));
  const displayCategory = formatCategoryTitle(category);

  return (
    <Card className='border border-border/80 bg-card/85 shadow-sm'>
      <CardHeader className='pb-0'>
        <button
          type='button'
          onClick={() => setIsExpanded((expanded) => !expanded)}
          className='flex w-full items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/25 px-3 py-3 text-left transition-colors hover:bg-background/40'
          aria-expanded={isExpanded}
          aria-label={`${displayCategory} section`}
        >
          <CardTitle className='flex items-center gap-2 text-sm'>
            <CategoryIcon category={displayCategory} />
            {displayCategory}
          </CardTitle>
          {isExpanded
            ? <ChevronUp className='h-4 w-4 text-muted-foreground' />
            : <ChevronDown className='h-4 w-4 text-muted-foreground' />}
        </button>
      </CardHeader>
      {isExpanded && (
        <CardContent className='pt-3'>
          <div className='grid gap-2'>
            {combinedClockParams != null && (
              <CombinedClockParameterRow
                params={combinedClockParams}
                deviceId={deviceId}
                temperatureUnit={temperatureUnit}
              />
            )}
            {visibleParams.map((param) => (
              <ParameterRow
                key={param.key}
                param={param}
                deviceId={deviceId}
                telemetry={telemetry}
                paramByKey={paramByKey}
                definition={definition}
                temperatureUnit={temperatureUnit}
              />
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function CombinedClockParameterRow({
  params,
  deviceId,
  temperatureUnit,
}: {
  params: DeviceParameter[];
  deviceId: string;
  temperatureUnit: TemperatureUnit;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [writeResult, setWriteResult] = useState<ParameterWriteResult | null>(null);
  const displayValue = formatCombinedClockDisplayValue(params);

  const startEdit = useCallback(() => {
    setEditValue(formatCombinedClockEditValue(params));
    setIsEditing(true);
    setWriteResult(null);
  }, [params]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setWriteResult(null);
  }, []);

  const saveValue = useCallback(async () => {
    const parsedValue = parseCombinedClockEditValue(editValue);
    if (!parsedValue.success) {
      setWriteResult({ success: false, message: parsedValue.message });
      return;
    }

    setIsSaving(true);
    setWriteResult(null);

    try {
      const response = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/parameters/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parameters: inverterClockParameterKeys.map((parameterKey) => ({
            parameterKey,
            rawValue: parsedValue.rawValues[parameterKey],
          })),
        }),
      });

      const data = await response.json().catch(() => ({})) as BatchWriteResponse;
      if (!response.ok) {
        setWriteResult({ success: false, message: data.message ?? 'Write failed' });
        return;
      }

      const results = data.results ?? [];
      const failedResult = results.find((result) => !result.success);
      if (failedResult) {
        setWriteResult({ success: false, message: failedResult.error ?? 'Verification failed' });
        return;
      }

      const confirmedRawValues = buildClockRawValuesFromBatchResults(results, parsedValue.rawValues);
      setWriteResult({
        success: true,
        message: `Confirmed: ${formatCombinedClockDisplayValueFromRawValues(confirmedRawValues, temperatureUnit)}`,
      });
      setIsEditing(false);
    } catch {
      setWriteResult({ success: false, message: 'Network error' });
    } finally {
      setIsSaving(false);
    }
  }, [deviceId, editValue, temperatureUnit]);

  return (
    <div className='rounded-lg border border-border/50 bg-background/40 px-3 py-2'>
      <div className='flex items-center justify-between gap-3'>
        <span className='flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
          <span>Date &amp; Time</span>
        </span>
        <div className='flex items-center gap-2'>
          {isEditing ? (
            <div className='flex items-center gap-1'>
              <input
                type='datetime-local'
                step={1}
                aria-label='Set inverter date and time'
                className='rounded border border-border bg-background px-2 py-0.5 text-sm font-semibold text-foreground outline-none focus:border-primary'
                value={editValue}
                onChange={(event) => setEditValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveValue();
                  if (event.key === 'Escape') cancelEdit();
                }}
                disabled={isSaving}
                autoFocus
              />
              <button onClick={() => void saveValue()} disabled={isSaving}
                aria-label='Save date and time'
                className='rounded p-1 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-50'>
                {isSaving ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : <Check className='h-3.5 w-3.5' />}
              </button>
              <button onClick={cancelEdit} disabled={isSaving}
                aria-label='Cancel date and time edit'
                className='rounded p-1 text-muted-foreground hover:bg-muted/50 disabled:opacity-50'>
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          ) : (
            <>
              <span className='text-sm font-semibold text-foreground'>{displayValue}</span>
              <button onClick={startEdit} className='rounded p-1 text-muted-foreground/60 hover:text-primary hover:bg-primary/10 transition-colors'
                title='Edit date and time'>
                <Edit2 className='h-3 w-3' />
              </button>
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
          const sharedPowerKilowatts = shouldUseSharedPowerKilowatts(section.metrics, paramByKey, definition);
          elements.push(
            <div key={`section-${i}`} className='grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4'>
              {section.metrics.map((m) => {
                const param = paramByKey.get(m.entity);
                const entity = findMetricEntity(definition, m.entity);
                const value = param?.numericValue;
                const sourceUnit = getMetricSourceUnit(param, entity);
                const unit = getTemperatureDisplayUnit(sourceUnit, temperatureUnit) ?? '';
                const prec = entity?.display?.precision ?? 2;
                const displayValue = isCelsiusUnit(sourceUnit)
                  ? convertTemperatureValue(value != null ? Number(value) : null, temperatureUnit)
                  : value != null ? Number(value) : null;
                const metricDisplay = formatMetricDisplayValue(displayValue, unit, prec, m, {
                  forcePowerShortKilowatts: sharedPowerKilowatts,
                });
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
                    label={m.label ?? param?.displayName ?? entity?.name ?? m.entity}
                    value={metricDisplay.valueText}
                    unit={metricDisplay.unitText}
                    accent={accent}
                    subtitle={heroSubtitle}
                  />
                );
              })}
            </div>
          );
        }
        if (section.entities?.length) {
          elements.push(
            <div key={`section-${i}-details`}>
              {renderInlineEntityStats(section.entities, paramByKey, definition, temperatureUnit)}
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
  leaf: Leaf,
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
  variant = 'icon',
  children,
}: {
  title: string;
  toneClassName: string;
  variant?: 'icon' | 'badge';
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      aria-label={title}
      className={cn(
        variant === 'badge'
          ? 'inline-flex min-h-7 items-center justify-center rounded-full border border-border/70 bg-background/45 px-2 text-[10px] font-semibold uppercase tracking-[0.18em]'
          : 'inline-flex h-7 w-7 items-center justify-center rounded-full border border-border/70 bg-background/45',
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

function resolveInverterStatusGlyphs(
  statusGlyphs: UiStatusGlyphDefinition[] | undefined,
  telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
  nowMs: number,
  isPassiveAdvertisement: boolean,
): ResolvedStatusGlyph[] {
  const glyphs: ResolvedStatusGlyph[] = [];
  const lastSeenGlyph = statusGlyphs?.find((glyph) => glyph.type === 'last-seen');

  glyphs.push(resolveLastSeenStatusGlyph(
    lastSeenGlyph ?? { type: 'last-seen', icon: 'pulse' },
    0,
    telemetry.collectedAt,
    nowMs,
    isPassiveAdvertisement,
  ));

  if (isInverterEcoModeEnabled(paramByKey.get('energy_saving_mode'))) {
    glyphs.push({
      key: 'status-eco-mode',
      title: 'Eco mode enabled',
      toneClassName: 'text-emerald-400',
      icon: <Leaf className='h-4 w-4' />,
    });
  }

  const stateOfCharge = paramByKey.get('state_of_charge')?.numericValue;
  if (stateOfCharge != null && Number.isFinite(stateOfCharge)) {
    glyphs.push({
      key: 'status-state-of-charge',
      title: `Battery ${Math.round(stateOfCharge)}%`,
      toneClassName: getBatteryStatusToneClassName(stateOfCharge),
      icon: <BatteryStatusGlyph percent={stateOfCharge} />,
    });
  }

  const outputPriorityGlyph = resolveInverterOutputPriorityGlyph(paramByKey.get('output_priority'));
  if (outputPriorityGlyph != null) {
    glyphs.push(outputPriorityGlyph);
  }

  return glyphs;
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

function isInverterEcoModeEnabled(param: DeviceParameter | undefined) {
  if (!param) {
    return false;
  }

  if (param.booleanValue != null) {
    return param.booleanValue;
  }

  if (param.numericValue != null && Number.isFinite(param.numericValue)) {
    return param.numericValue > 0;
  }

  if (param.rawValue != null && Number.isFinite(param.rawValue)) {
    return param.rawValue > 0;
  }

  return (param.stringValue ?? '').trim().toLowerCase() === 'on';
}

function resolveInverterOutputPriorityGlyph(param: DeviceParameter | undefined): ResolvedStatusGlyph | null {
  if (!param) {
    return null;
  }

  const label = getInverterOutputPriorityLabel(param);
  const badgeText = getInverterOutputPriorityCode(param, label);
  if (!badgeText) {
    return null;
  }

  return {
    key: 'status-output-priority',
    title: label ? `Output priority ${label}` : `Output priority ${badgeText}`,
    toneClassName: 'text-sky-400',
    icon: <span>{badgeText}</span>,
    variant: 'badge',
  };
}

function getInverterOutputPriorityLabel(param: DeviceParameter) {
  if (param.stringValue && param.stringValue.trim().length > 0) {
    return param.stringValue.trim();
  }

  const rawValue = param.rawValue ?? param.numericValue;
  if (rawValue == null || !Number.isFinite(rawValue)) {
    return null;
  }

  const normalizedValue = Math.round(rawValue);
  return normalizedValue === 0
    ? 'Utility first'
    : normalizedValue === 1
      ? 'PV first (SOL)'
      : normalizedValue === 2
        ? 'PV → Battery → Utility (SBU)'
        : normalizedValue === 3
          ? 'PV → Utility → Battery (SUB)'
          : null;
}

function getInverterOutputPriorityCode(param: DeviceParameter, label: string | null) {
  const normalizedLabel = label?.trim() ?? '';
  const lowercaseLabel = normalizedLabel.toLowerCase();

  if (lowercaseLabel.includes('utility first')) {
    return 'SUF';
  }

  const labelCodeMatch = normalizedLabel.match(/\(([A-Z]{3})\)/);
  if (labelCodeMatch) {
    return labelCodeMatch[1];
  }

  const rawValue = param.rawValue ?? param.numericValue;
  if (rawValue == null || !Number.isFinite(rawValue)) {
    return null;
  }

  const normalizedValue = Math.round(rawValue);
  if (normalizedValue === 0) {
    return 'SUF';
  }

  if (normalizedValue === 1) {
    return 'SOL';
  }

  if (normalizedValue === 2) {
    return 'SBU';
  }

  if (normalizedValue === 3) {
    return 'SUB';
  }

  return null;
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

function findMetricEntity(definition: DeviceDefinition | null | undefined, entityId: string) {
  return definition?.entities.find((entity) => entity.id === entityId)
    ?? definition?.computedEntities?.find((entity) => entity.id === entityId);
}

function getMetricSourceUnit(
  param: DeviceParameter | undefined,
  entity: EntityDefinition | ComputedEntityDefinition | undefined,
) {
  return param?.unit
    ?? (entity && 'source' in entity ? entity.source?.unit : undefined)
    ?? (entity && 'unit' in entity ? entity.unit : undefined)
    ?? '';
}

function shouldUseSharedPowerKilowatts(
  metrics: UiMetricDefinition[],
  paramByKey: Map<string, DeviceParameter>,
  definition?: DeviceDefinition | null,
) {
  return metrics.some((metric) => {
    if (metric.format !== 'power-short') {
      return false;
    }

    const param = paramByKey.get(metric.entity);
    const entity = findMetricEntity(definition, metric.entity);
    const sourceUnit = getMetricSourceUnit(param, entity);
    if (!sourceUnit || sourceUnit.toLowerCase() !== 'w') {
      return false;
    }

    const value = param?.numericValue;
    return value != null && Number.isFinite(Number(value)) && Math.abs(Number(value)) > 500;
  });
}

function formatMetricDisplayValue(
  value: number | null | undefined,
  unit: string | null | undefined,
  decimals: number,
  metric?: UiMetricDefinition,
  options?: { forcePowerShortKilowatts?: boolean },
) {
  if (metric?.format === 'power-short' && unit?.toLowerCase() === 'w') {
    const useKilowatts = options?.forcePowerShortKilowatts || (value != null && Number.isFinite(value) && Math.abs(value) > 500);

    if (value == null || !Number.isFinite(value)) {
      return { valueText: nd, unitText: useKilowatts ? 'kW' : 'W' };
    }

    if (useKilowatts) {
      return { valueText: (value / 1000).toFixed(1), unitText: 'kW' };
    }

    return { valueText: Math.round(value).toLocaleString(), unitText: 'W' };
  }

  return {
    valueText: fmt(value, decimals),
    unitText: unit ?? '',
  };
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
  gray: 'text-slate-300',
  grey: 'text-slate-300',
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
  if (section.entities?.length) {
    const order = new Map(section.entities.map((entity, index) => [entity, index]));
    result = result
      .filter(p => order.has(p.key))
      .sort((a, b) => (order.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.key) ?? Number.MAX_SAFE_INTEGER));
  }
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
    case 'Thermal Protection':
      return <Thermometer className='h-4 w-4 text-amber-400' />;
    case 'Status':
      return <Activity className='h-4 w-4 text-primary' />;
    case 'Cell Protection':
    case 'Current Protection':
      return <Shield className='h-4 w-4 text-rose-400' />;
    case 'Balance Settings':
    case 'SOC Settings':
    case 'System':
      return <Activity className='h-4 w-4 text-violet-400' />;
    case 'Charging':
    case 'Discharging':
      return <BatteryCharging className='h-4 w-4 text-sky-400' />;
    case 'F2 Charger':
      return <BatteryCharging className='h-4 w-4 text-sky-400' />;
    case 'Device Info':
      return <Activity className='h-4 w-4 text-teal-400' />;
    default:
      return <Activity className='h-4 w-4 text-muted-foreground' />;
  }
}

function formatCategoryTitle(category: string) {
  return category === 'F2 Battery'
    ? 'F2 Charger'
    : category;
}

function isSwitchSettingParam(key: string): boolean {
  return key === 'charge_switch' || key === 'discharge_switch' || key === 'balancer_switch';
}

function getParameterEditBlockedReason(
  param: DeviceParameter,
  _telemetry: DeviceTelemetrySnapshot,
  paramByKey: Map<string, DeviceParameter>,
  definition?: DeviceDefinition | null,
): string | null {
  if (definition?.device.id !== 'anenji-inverter-rs232') {
    return null;
  }

  if (param.key !== 'output_voltage_setting' && param.key !== 'output_frequency_setting') {
    return null;
  }

  return isAnenjiOutputActive(paramByKey)
    ? 'Turn inverter output off before changing output voltage or frequency.'
    : null;
}

function isAnenjiOutputActive(paramByKey: Map<string, DeviceParameter>): boolean {
  return hasPositiveParameterValue(paramByKey.get('output_active_power')) ||
    hasPositiveParameterValue(paramByKey.get('load_percent')) ||
    hasPositiveParameterValue(paramByKey.get('output_current'));
}

function hasPositiveParameterValue(param: DeviceParameter | undefined): boolean {
  if (!param) {
    return false;
  }

  if (param.booleanValue != null) {
    return param.booleanValue;
  }

  const numericValue = param.numericValue != null && Number.isFinite(Number(param.numericValue))
    ? Number(param.numericValue)
    : param.rawValue != null && Number.isFinite(Number(param.rawValue))
      ? Number(param.rawValue)
      : null;

  return numericValue != null && Math.abs(numericValue) > 0;
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

const inverterClockParameterKeys = [
  'clock_year',
  'clock_month',
  'clock_day',
  'clock_hour',
  'clock_minute',
  'clock_second',
] as const;
const inverterClockParameterKeySet = new Set<string>(inverterClockParameterKeys);

type InverterClockParameterKey = (typeof inverterClockParameterKeys)[number];
type InverterClockRawValues = Record<InverterClockParameterKey, number>;

function getCombinedClockParams(
  params: DeviceParameter[],
  definition?: DeviceDefinition | null,
) {
  if (definition?.device.category !== 'inverter') {
    return null;
  }

  const paramByKey = new Map(params.map((param) => [param.key, param]));
  const combinedParams = inverterClockParameterKeys
    .map((key) => paramByKey.get(key))
    .filter((param): param is DeviceParameter => param != null);

  if (combinedParams.length !== inverterClockParameterKeys.length) {
    return null;
  }

  return combinedParams.every((param) => param.isWritable)
    ? combinedParams
    : null;
}

function buildClockRawValues(params: DeviceParameter[]): InverterClockRawValues | null {
  const paramByKey = new Map(params.map((param) => [param.key, param]));
  const rawValues = {} as InverterClockRawValues;

  for (const key of inverterClockParameterKeys) {
    const param = paramByKey.get(key);
    const rawValue = param?.rawValue ?? param?.numericValue;
    if (rawValue == null || !Number.isFinite(rawValue)) {
      return null;
    }

    rawValues[key] = Math.round(rawValue);
  }

  return rawValues;
}

function formatCombinedClockDisplayValue(params: DeviceParameter[]) {
  const rawValues = buildClockRawValues(params);
  return rawValues == null
    ? nd
    : formatCombinedClockDisplayValueFromRawValues(rawValues);
}

function formatCombinedClockEditValue(params: DeviceParameter[]) {
  const rawValues = buildClockRawValues(params);
  if (rawValues == null) {
    return '';
  }

  return `${padClockValue(rawValues.clock_year, 4)}-${padClockValue(rawValues.clock_month)}-${padClockValue(rawValues.clock_day)}T${padClockValue(rawValues.clock_hour)}:${padClockValue(rawValues.clock_minute)}:${padClockValue(rawValues.clock_second)}`;
}

function formatCombinedClockDisplayValueFromRawValues(rawValues: InverterClockRawValues, _temperatureUnit?: TemperatureUnit) {
  return `${padClockValue(rawValues.clock_year, 4)}-${padClockValue(rawValues.clock_month)}-${padClockValue(rawValues.clock_day)} ${padClockValue(rawValues.clock_hour)}:${padClockValue(rawValues.clock_minute)}:${padClockValue(rawValues.clock_second)}`;
}

function buildClockRawValuesFromBatchResults(
  results: BatchWriteResponse['results'],
  fallbackRawValues: InverterClockRawValues,
): InverterClockRawValues {
  const resolvedRawValues = { ...fallbackRawValues };
  const resultByKey = new Map((results ?? []).map((result) => [result.parameterKey, result]));

  for (const key of inverterClockParameterKeys) {
    const result = resultByKey.get(key);
    const readBackValue = result?.readBackValue;
    if (readBackValue != null && Number.isFinite(readBackValue)) {
      resolvedRawValues[key] = Math.round(readBackValue);
    }
  }

  return resolvedRawValues;
}

function parseCombinedClockEditValue(input: string):
  | { success: true; rawValues: InverterClockRawValues }
  | { success: false; message: string } {
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/);
  if (!match) {
    return { success: false, message: 'Invalid date/time' };
  }

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText = '00',
  ] = match;

  const rawValues: InverterClockRawValues = {
    clock_year: Number.parseInt(yearText, 10),
    clock_month: Number.parseInt(monthText, 10),
    clock_day: Number.parseInt(dayText, 10),
    clock_hour: Number.parseInt(hourText, 10),
    clock_minute: Number.parseInt(minuteText, 10),
    clock_second: Number.parseInt(secondText, 10),
  };

  if (rawValues.clock_year < 2000 || rawValues.clock_year > 2099) {
    return { success: false, message: 'Year must be between 2000 and 2099.' };
  }

  if (rawValues.clock_month < 1 || rawValues.clock_month > 12) {
    return { success: false, message: 'Month must be between 1 and 12.' };
  }

  const daysInMonth = new Date(rawValues.clock_year, rawValues.clock_month, 0).getDate();
  if (rawValues.clock_day < 1 || rawValues.clock_day > daysInMonth) {
    return { success: false, message: 'Day is out of range for the selected month.' };
  }

  if (rawValues.clock_hour < 0 || rawValues.clock_hour > 23) {
    return { success: false, message: 'Hour must be between 0 and 23.' };
  }

  if (rawValues.clock_minute < 0 || rawValues.clock_minute > 59) {
    return { success: false, message: 'Minute must be between 0 and 59.' };
  }

  if (rawValues.clock_second < 0 || rawValues.clock_second > 59) {
    return { success: false, message: 'Second must be between 0 and 59.' };
  }

  return { success: true, rawValues };
}

function padClockValue(value: number, width = 2) {
  return value.toString().padStart(width, '0');
}

function formatParamValue(
  param: DeviceParameter,
  temperatureUnit: TemperatureUnit,
  booleanStyle: 'yes-no' | 'enabled-disabled' = 'yes-no',
  displayPrecision?: number | null,
): string {
  if (param.booleanValue != null) {
    if (booleanStyle === 'enabled-disabled') {
      return param.booleanValue ? 'Enabled' : 'Disabled';
    }
    return param.booleanValue ? 'Yes' : 'No';
  }
  // For select-type entities, prefer the label over the raw number
  if (param.options?.length && param.stringValue != null) {
    return param.stringValue;
  }
  if (param.numericValue != null) {
    const sourceValue = Number(param.numericValue);
    const displayValue = isCelsiusUnit(param.unit)
      ? convertTemperatureValue(sourceValue, temperatureUnit)
      : sourceValue;
    if (displayValue == null || !Number.isFinite(displayValue)) {
      return nd;
    }

    const precision = displayPrecision ?? param.displayPrecision;
    if (precision != null && Number.isInteger(precision) && precision >= 0) {
      return param.displayFormatter === 'plain-number'
        ? displayValue.toFixed(precision)
        : displayValue.toLocaleString(undefined, {
          minimumFractionDigits: precision,
          maximumFractionDigits: precision,
        });
    }

    if (Number.isInteger(displayValue)) {
      return param.displayFormatter === 'plain-number'
        ? displayValue.toFixed(0)
        : displayValue.toLocaleString();
    }
    return displayValue.toFixed(Math.abs(displayValue) >= 100 ? 1 : 3);
  }
  if (param.stringValue != null) {
    return param.stringValue;
  }
  return nd;
}

function formatEditableParameterInputValue(
  param: DeviceParameter,
  entity: EntityDefinition | undefined,
  temperatureUnit: TemperatureUnit,
) {
  if (!entity) {
    return param.rawValue?.toString() ?? '';
  }

  const sourceValue = param.numericValue != null && Number.isFinite(Number(param.numericValue))
    ? Number(param.numericValue)
    : param.rawValue != null && Number.isFinite(Number(param.rawValue))
      ? Number(param.rawValue) * getEntityScale(entity)
      : null;
  if (sourceValue == null) {
    return '';
  }

  const displayValue = isCelsiusUnit(entity.source.unit ?? param.unit)
    ? convertTemperatureValue(sourceValue, temperatureUnit)
    : sourceValue;
  if (displayValue == null || !Number.isFinite(displayValue)) {
    return '';
  }

  return displayValue.toFixed(getEditableParameterPrecision(entity, param, temperatureUnit));
}

function parseParameterInputValue(
  input: string,
  param: DeviceParameter,
  entity: EntityDefinition | undefined,
  temperatureUnit: TemperatureUnit,
): { success: true; rawValue: number } | { success: false; message: string } {
  if (!entity) {
    const rawValue = Number.parseInt(input, 10);
    if (!Number.isInteger(rawValue) || rawValue < 0) {
      return { success: false, message: 'Invalid value' };
    }

    return { success: true, rawValue };
  }

  const parsedValue = Number.parseFloat(input);
  if (!Number.isFinite(parsedValue)) {
    return { success: false, message: 'Invalid value' };
  }

  const normalizedValue = isCelsiusUnit(entity.source.unit ?? param.unit) && temperatureUnit === 'f'
    ? (parsedValue - 32) * 5 / 9
    : parsedValue;
  const scale = getEntityScale(entity);
  const rawValue = normalizedValue / scale;
  const roundedRawValue = Math.round(rawValue);
  const tolerance = Math.max(1e-9, Math.abs(rawValue) * 1e-9);

  if (Math.abs(rawValue - roundedRawValue) > tolerance) {
    return {
      success: false,
      message: `Value must align to ${formatEditableStep(entity, param, temperatureUnit)} steps.`,
    };
  }

  if (roundedRawValue < 0 || roundedRawValue > 0xFFFFFFFF) {
    return { success: false, message: 'Value is outside the supported range.' };
  }

  return { success: true, rawValue: roundedRawValue };
}

function parseRawSelectValue(input: string): { success: true; rawValue: number } | { success: false; message: string } {
  const rawValue = Number.parseInt(input, 10);
  if (!Number.isInteger(rawValue) || rawValue < 0) {
    return { success: false, message: 'Invalid value' };
  }

  return { success: true, rawValue };
}

function formatParameterReadBackValue(
  rawValue: number,
  param: DeviceParameter,
  entity: EntityDefinition | undefined,
  temperatureUnit: TemperatureUnit,
) {
  if (!entity) {
    return rawValue.toString();
  }

  const scaledValue = rawValue * getEntityScale(entity);
  const displayValue = isCelsiusUnit(entity.source.unit ?? param.unit)
    ? convertTemperatureValue(scaledValue, temperatureUnit)
    : scaledValue;
  if (displayValue == null || !Number.isFinite(displayValue)) {
    return rawValue.toString();
  }

  const formattedValue = displayValue.toFixed(getEditableParameterPrecision(entity, param, temperatureUnit));
  const unit = getTemperatureDisplayUnit(entity.source.unit ?? param.unit, temperatureUnit) ?? param.unit;
  return unit ? `${formattedValue} ${unit}` : formattedValue;
}

function formatSelectParameterValue(param: DeviceParameter, rawValue: number) {
  return param.options?.find((option) => option.value === rawValue)?.label ?? rawValue.toString();
}

function getEntityScale(entity: EntityDefinition) {
  return entity.source.scale && Number.isFinite(entity.source.scale) && entity.source.scale !== 0
    ? entity.source.scale
    : 1;
}

function getEditableParameterPrecision(
  entity: EntityDefinition,
  param: DeviceParameter,
  temperatureUnit: TemperatureUnit,
) {
  const displayPrecision = Math.max(0, entity.display?.precision ?? 0);
  const stepPrecision = countFractionDigits(getEditableDisplayStep(entity, param, temperatureUnit));
  return Math.max(displayPrecision, stepPrecision);
}

function getEditableDisplayStep(
  entity: EntityDefinition,
  param: DeviceParameter,
  temperatureUnit: TemperatureUnit,
) {
  const scale = Math.abs(getEntityScale(entity));
  if (isCelsiusUnit(entity.source.unit ?? param.unit) && temperatureUnit === 'f') {
    return scale * 9 / 5;
  }

  return scale;
}

function formatEditableStep(
  entity: EntityDefinition,
  param: DeviceParameter,
  temperatureUnit: TemperatureUnit,
) {
  const step = getEditableDisplayStep(entity, param, temperatureUnit);
  const unit = getTemperatureDisplayUnit(entity.source.unit ?? param.unit, temperatureUnit) ?? param.unit;
  const formattedStep = trimTrailingZeroes(step.toFixed(Math.max(countFractionDigits(step), 0)));
  return unit ? `${formattedStep} ${unit}` : formattedStep;
}

function countFractionDigits(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  const normalized = value.toString().toLowerCase();
  if (normalized.includes('e-')) {
    const [, exponent] = normalized.split('e-');
    return Number.parseInt(exponent ?? '0', 10);
  }

  const [, fraction = ''] = normalized.split('.');
  return fraction.length;
}

function trimTrailingZeroes(value: string) {
  return value.replace(/\.?0+$/, '');
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
