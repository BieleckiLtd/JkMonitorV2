import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Battery, BatteryCharging, Check, Edit2, Gauge, LoaderCircle, Shield, Thermometer, X, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { HistoryCharts } from '../components/HistoryCharts';
import { cn } from '../lib/utils';
import { getBatteryStateFromCurrent } from '../lib/batteryStatus';
import { useDeviceDefinition } from '../hooks/useDeviceDefinition';
import type { DeviceDefinition, UiSectionDefinition } from '../types/deviceDefinition';

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
  latestTelemetry?: DeviceTelemetrySnapshot | null;
};

const refreshIntervalMs = 2000;
const nd = 'N/D';

type SwitchStatusChip = {
  label: string;
  className: string;
};

export function MonitorPage() {
  const [devices, setDevices] = useState<DeviceRuntimeState[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let requestInFlight = false;

    const load = async () => {
      if (requestInFlight) return;
      requestInFlight = true;

      try {
        const response = await fetch('/api/devices/current', { cache: 'no-store' });
        if (!response.ok) throw new Error('Unable to load device telemetry.');
        const data = (await response.json()) as DeviceRuntimeState[];
        if (!isMounted) return;
        setDevices(data);
        setLoadError(null);
      } catch (error) {
        if (!isMounted) return;
        setLoadError(error instanceof Error ? error.message : 'Unable to load device telemetry.');
      } finally {
        requestInFlight = false;
        if (isMounted) setIsLoading(false);
      }
    };

    void load();
    const intervalId = window.setInterval(() => { void load(); }, refreshIntervalMs);
    return () => { isMounted = false; window.clearInterval(intervalId); };
  }, []);

  return (
    <div className='space-y-3 pb-4 sm:space-y-6 sm:pb-8'>
      <section data-slot='page-hero-shell' className='page-hero-shell rounded-3xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur sm:p-6 md:p-8'>
        <div className='space-y-3'>
          <div className='inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary'>
            <Activity className='h-3.5 w-3.5' />
            Live Telemetry
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
        <DevicePanel key={device.deviceId} device={device} />
      ))}
    </div>
  );
}

function DevicePanel({ device }: { device: DeviceRuntimeState }) {
  const definition = useDeviceDefinition(device.definitionId);
  const telemetry = device.latestTelemetry;
  const parameters = telemetry?.parameters ?? [];
  const cells = telemetry?.cells ?? [];
  const warnings = telemetry?.activeWarnings ?? [];
  const isHealthy = device.lastOutcome === 'Succeeded';
  const isFailing = device.lastOutcome === 'Failed';
  const dp = device.displayPrecision ?? defaultPrecision;
  const [selectedCellIndices, setSelectedCellIndices] = useState<number[]>([]);

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
              {device.deviceId} &bull; {device.protocolHandler ?? device.definitionId} &bull; {device.pollIntervalMilliseconds}ms
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

      {!telemetry && !device.lastError && (
        <div className='flex items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 py-8 text-sm text-muted-foreground'>
          <LoaderCircle className='mr-2 h-4 w-4 animate-spin' /> Waiting for first reading...
        </div>
      )}

      {telemetry && (
        <>
          {/* Hero metrics — driven by definition */}
          {monitorSections ? (
            renderDefinitionSections(monitorSections, paramByKey, telemetry, dp, cells, selectedCellIndices, setSelectedCellIndices, device.deviceId, definition)
          ) : (
            <>
              {cells.length > 0 && (
                <CellVoltageChart cells={cells} minV={telemetry.minCellVoltageVolts} maxV={telemetry.maxCellVoltageVolts} avgV={telemetry.averageCellVoltageVolts} selectedCellIndices={selectedCellIndices} onCellClick={(idx) => setSelectedCellIndices(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx])} />
              )}

              <HistoryCharts deviceId={device.deviceId} precision={dp} selectedCellIndices={selectedCellIndices} onClearCellSelection={() => setSelectedCellIndices([])} />
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
                    <ParameterCategoryCard key={`${idx}-${cat}`} category={cat} params={catParams} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} />
                  ));
                }
                return (
                  <ParameterCategoryCard key={idx} category={section.title ?? 'Parameters'} params={params} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} />
                );
              })}
            </div>
          ) : (
            <div className='grid gap-3 sm:gap-4 lg:grid-cols-2'>
              {sortedCategories.filter(c => c !== 'Cell Voltages').map((category) => (
                <ParameterCategoryCard key={category} category={category} params={grouped.get(category)!} deviceId={device.deviceId} telemetry={telemetry} paramByKey={paramByKey} />
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
}: {
  param: DeviceParameter;
  deviceId: string;
  telemetry: DeviceTelemetrySnapshot;
  paramByKey: Map<string, DeviceParameter>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [writeResult, setWriteResult] = useState<{ success: boolean; message: string } | null>(null);
  const isSwitchSetting = isSwitchSettingParam(param.key);
  const statusChip = getSwitchStatusChip(param, telemetry, paramByKey);
  const value = formatParamValue(param, isSwitchSetting ? 'enabled-disabled' : 'yes-no');

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
                {param.unit && <span className='ml-1 text-xs font-normal text-muted-foreground'>{param.unit}</span>}
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
}: {
  category: string;
  params: DeviceParameter[];
  deviceId: string;
  telemetry: DeviceTelemetrySnapshot;
  paramByKey: Map<string, DeviceParameter>;
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
            <ParameterRow key={param.key} param={param} deviceId={deviceId} telemetry={telemetry} paramByKey={paramByKey} />
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
) {
  const elements: React.ReactNode[] = [];
  const capacityAh = paramByKey.get('nominal_battery_capacity')?.numericValue;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    switch (section.type) {
      case 'hero-metrics':
        if (section.metrics) {
          const capacityAh = paramByKey.get('nominal_battery_capacity')?.numericValue;
          const chargeState = getBatteryStateFromCurrent(telemetry.currentAmps);
          elements.push(
            <div key={`section-${i}`} className='grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4'>
              {section.metrics.map((m) => {
                const param = paramByKey.get(m.entity);
                const entity = definition?.entities.find(e => e.id === m.entity) ?? definition?.computedEntities?.find(e => e.id === m.entity);
                const value = param?.numericValue;
                const unit = param?.unit ?? (entity && 'source' in entity ? entity.source?.unit : undefined) ?? (entity && 'unit' in entity ? (entity as { unit?: string }).unit : '') ?? '';
                const prec = entity?.display?.precision ?? 2;
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
                  if (capacityAh && capacityAh > 0 && telemetry.currentAmps != null) {
                    const rate = (telemetry.currentAmps / capacityAh) * 100;
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
                    value={fmt(value, prec)}
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
  const Icon = resolveIcon(name);
  return <Icon className={className} />;
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
  const batteryState = telemetry.currentAmps == null || !Number.isFinite(telemetry.currentAmps)
    ? null
    : getBatteryStateFromCurrent(telemetry.currentAmps);

  switch (param.key) {
    case 'charge_switch': {
      const isActive = paramByKey.get('charging_enabled')?.booleanValue
        ?? telemetry.chargingEnabled
        ?? (batteryState == null ? null : batteryState === 'CHARGING');
      return buildSwitchStatusChip(isActive, 'Charging now', 'Not charging');
    }
    case 'discharge_switch': {
      const isActive = paramByKey.get('discharging_enabled')?.booleanValue
        ?? telemetry.dischargingEnabled
        ?? (batteryState == null ? null : batteryState === 'DISCHARGING');
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
  booleanStyle: 'yes-no' | 'enabled-disabled' = 'yes-no',
): string {
  if (param.booleanValue != null) {
    if (booleanStyle === 'enabled-disabled') {
      return param.booleanValue ? 'Enabled' : 'Disabled';
    }
    return param.booleanValue ? 'Yes' : 'No';
  }
  if (param.numericValue != null) {
    const v = param.numericValue;
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toFixed(Math.abs(v) >= 100 ? 1 : 3);
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
    case 'PersistFailed':
      return 'border border-amber-500/20 bg-amber-500/10 text-amber-300';
    case 'Failed':
      return 'border border-rose-500/20 bg-rose-500/10 text-rose-300';
    default:
      return 'border border-border bg-muted/70 text-muted-foreground';
  }
}
