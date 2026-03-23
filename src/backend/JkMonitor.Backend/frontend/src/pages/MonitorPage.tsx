import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Battery, BatteryCharging, Check, Edit2, LoaderCircle, Shield, Thermometer, X, Zap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import { HistoryCharts } from '../components/HistoryCharts';
import { cn } from '../lib/utils';

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
  profileId: string;
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
type CellVoltageChartMode = 'absolute' | 'delta';

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
      <section className='rounded-3xl border border-border bg-card/80 p-4 shadow-sm backdrop-blur sm:p-6 md:p-8'>
        <div className='space-y-3'>
          <div className='inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary'>
            <Activity className='h-3.5 w-3.5' />
            Live Telemetry
          </div>
          <div>
            <h2 className='text-3xl font-bold tracking-tight text-foreground md:text-4xl'>Device Monitor</h2>
            <p className='mt-2 max-w-2xl text-sm leading-6 text-muted-foreground'>
              Real-time data from all connected devices. Parameters are driven by the device profile configuration.
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
  const telemetry = device.latestTelemetry;
  const parameters = telemetry?.parameters ?? [];
  const cells = telemetry?.cells ?? [];
  const warnings = telemetry?.activeWarnings ?? [];
  const isHealthy = device.lastOutcome === 'Succeeded';
  const isFailing = device.lastOutcome === 'Failed';
  const dp = device.displayPrecision ?? defaultPrecision;
  const [selectedCellIndices, setSelectedCellIndices] = useState<number[]>([]);

  // Group parameters by category
  const grouped = new Map<string, DeviceParameter[]>();
  for (const param of parameters) {
    const cat = param.category;
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(param);
  }

  // Category rendering order
  const categoryOrder = ['Pack Status', 'Cell Summary', 'Cell Voltages', 'Temperatures', 'Status',
    'Cell Protection', 'Current Protection', 'Thermal Protection', 'Charging', 'Discharging',
    'Balance Settings', 'SOC Settings', 'System', 'Device Info',
    'Protection Settings', 'Balance Settings', 'Settings', 'Calibration'];
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    const aIdx = categoryOrder.indexOf(a);
    const bIdx = categoryOrder.indexOf(b);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

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
            <Battery className='h-5 w-5' />
          </div>
          <div>
            <div className='flex flex-wrap items-center gap-2'>
              <h3 className='text-lg font-semibold text-foreground'>{device.displayName}</h3>
              {device.isMaster && <span className='rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary'>Master</span>}
              <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em]', getOutcomeClass(device.lastOutcome))}>
                {device.lastOutcome}
              </span>
            </div>
            <div className='mt-1 text-xs font-mono text-muted-foreground'>
              {device.deviceId} &bull; {device.protocolHandler ?? device.profileId} &bull; {device.pollIntervalMilliseconds}ms
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
          {/* Hero metrics (highlighted) */}
          <div className='grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4'>
            <HeroMetric
              icon={Zap}
              label='Voltage'
              value={fmt(telemetry.totalVoltageVolts, dp.voltage)}
              unit='V'
              accent='text-sky-400'
            />
            <HeroMetric
              icon={Activity}
              label='Current'
              value={fmt(telemetry.currentAmps, dp.current)}
              unit='A'
              accent={telemetry.currentAmps != null && telemetry.currentAmps > 0 ? 'text-emerald-400' : telemetry.currentAmps != null && telemetry.currentAmps < 0 ? 'text-amber-400' : 'text-muted-foreground'}
            />
            <HeroMetric
              icon={Zap}
              label='Power'
              value={fmt(telemetry.powerWatts, dp.power)}
              unit='W'
              accent='text-purple-400'
            />
            <HeroMetric
              icon={BatteryCharging}
              label='SoC'
              value={fmt(telemetry.stateOfChargePercent, dp.soc)}
              unit='%'
              accent={telemetry.stateOfChargePercent != null && telemetry.stateOfChargePercent > 50 ? 'text-emerald-400' : telemetry.stateOfChargePercent != null && telemetry.stateOfChargePercent > 20 ? 'text-amber-400' : 'text-rose-400'}
            />
          </div>

          {/* Cell voltages visualization */}
          {cells.length > 0 && (
            <CellVoltageChart cells={cells} minV={telemetry.minCellVoltageVolts} maxV={telemetry.maxCellVoltageVolts} avgV={telemetry.averageCellVoltageVolts} selectedCellIndices={selectedCellIndices} onCellClick={(idx) => setSelectedCellIndices(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx])} />
          )}

          {/* Time-series history charts */}
          <HistoryCharts deviceId={device.deviceId} precision={dp} selectedCellIndices={selectedCellIndices} onClearCellSelection={() => setSelectedCellIndices([])} />

          {/* All parameter categories */}
          <div className='grid gap-3 sm:gap-4 lg:grid-cols-2'>
            {sortedCategories.filter(c => c !== 'Cell Voltages').map((category) => {
              const params = grouped.get(category)!;
              return (
                <Card key={category} className='border border-border/80 bg-card/85 shadow-sm'>
                  <CardHeader className='border-b border-border/60 pb-3'>
                    <CardTitle className='flex items-center gap-2 text-sm'>
                      <CategoryIcon category={category} />
                      {category}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='pt-3'>
                    <div className='grid gap-2'>
                      {params.map((param) => (
                        <ParameterRow key={param.key} param={param} deviceId={device.deviceId} />
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function HeroMetric({ icon: Icon, label, value, unit, accent }: { icon: typeof Zap; label: string; value: string; unit: string; accent: string }) {
  return (
    <div className='rounded-2xl border border-border/80 bg-card/85 p-3 shadow-sm sm:p-5'>
      <div className='flex items-start justify-between'>
        <div>
          <div className='text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground'>{label}</div>
          <div className={cn('mt-1.5 text-[1.35rem] font-bold tracking-tight sm:mt-2 sm:text-3xl', accent)}>
            {value}<span className='ml-1 text-base font-medium text-muted-foreground'>{unit}</span>
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
  const [mode, setMode] = useState<CellVoltageChartMode>('delta');
  const sorted = [...cells].sort((a, b) => a.index - b.index);
  const voltages = sorted.map(c => c.voltageVolts);
  const absMin = Math.min(...voltages);
  const absMax = Math.max(...voltages);
  const spread = Math.max(absMax - absMin, 0.001);
  const rangeMin = mode === 'delta' ? absMin - spread * 0.5 : 0;
  const rangeMax = mode === 'delta' ? absMax + spread * 0.5 : Math.max(absMax * 1.02, 0.1);
  const toggleTitle = mode === 'delta'
    ? 'Delta view enabled. Bars are zoomed around the cell spread to make balancing differences clearer. Toggle to switch to absolute 0V scale.'
    : 'Absolute view enabled. Bars start at 0V so each cell shows full height. Toggle to switch to delta zoom.';

  return (
    <Card className='bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-3'>
        <CardTitle className='flex flex-col gap-3 text-sm lg:flex-row lg:items-center lg:justify-between'>
          <div className='flex flex-wrap items-center gap-3'>
            <div className='flex items-center gap-2'>
              <Battery className='h-4 w-4 text-muted-foreground' />
              Cell Voltages
            </div>
            <div
              className='flex items-center gap-1.5 rounded-full border border-border/70 bg-background/50 px-2 py-1'
              title={toggleTitle}
            >
              <span className={cn('text-[9px] font-medium', mode === 'absolute' ? 'text-foreground' : 'text-muted-foreground/60')}>Total</span>
              <Switch
                size='sm'
                checked={mode === 'delta'}
                onCheckedChange={(checked) => setMode(checked ? 'delta' : 'absolute')}
                aria-label='Toggle between delta and absolute cell voltage view'
                title={toggleTitle}
              />
              <span className={cn('text-[9px] font-medium', mode === 'delta' ? 'text-foreground' : 'text-muted-foreground/60')}>Δ</span>
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
      <CardContent className='px-2 pt-4 sm:px-4'>
        <div className='pb-1 sm:pb-2'>
          <div
            className='grid items-end gap-1 pt-5 sm:gap-2 sm:pt-6'
            style={{ height: '164px', gridTemplateColumns: `repeat(${sorted.length}, minmax(0, 1fr))` }}
          >
          {sorted.map((cell) => {
            const pct = Math.max(((cell.voltageVolts - rangeMin) / (rangeMax - rangeMin)) * 100, mode === 'delta' ? 8 : 4);
            const isMin = cell.voltageVolts === absMin && absMin !== absMax;
            const isMax = cell.voltageVolts === absMax && absMin !== absMax;
            const isSelected = selectedCellIndices?.includes(cell.index) ?? false;

            return (
              <div
                key={cell.index}
                className='relative flex h-full min-w-0 flex-col items-center justify-end cursor-pointer'
                onClick={(e) => { e.stopPropagation(); onCellClick?.(cell.index); }}
              >
                <div className='absolute -top-3.5 left-1/2 -translate-x-1/2 rounded border border-border bg-popover px-0.5 py-0.5 text-[7px] font-semibold tabular-nums whitespace-nowrap text-foreground shadow sm:-top-5 sm:px-1.5 sm:text-[10px]'>
                  {cell.voltageVolts.toFixed(3)}
                </div>
                <div
                  className={cn(
                    'w-full rounded-t transition-all duration-500',
                    isSelected ? 'bg-violet-500/90' :
                    isMin ? 'bg-rose-500/80' : isMax ? 'bg-emerald-500/80' : 'bg-primary/60'
                  )}
                  style={{ height: `${pct}%`, minHeight: '4px' }}
                />
                <div className='mt-1 text-[7px] text-muted-foreground leading-none sm:text-[9px]'>{cell.index}</div>
              </div>
            );
          })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ParameterRow({ param, deviceId }: { param: DeviceParameter; deviceId: string }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [writeResult, setWriteResult] = useState<{ success: boolean; message: string } | null>(null);
  const value = formatParamValue(param);

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

      const data = await response.json() as { success?: boolean; writtenValue?: number; readBackValue?: number; error?: string; message?: string };

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
      <div className='flex items-center justify-between'>
        <span className='text-xs text-muted-foreground'>{param.displayName}</span>
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

function formatParamValue(param: DeviceParameter): string {
  if (param.booleanValue != null) {
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
