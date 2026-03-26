import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, ReferenceDot,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { cn } from '../lib/utils';
import { computeEnergyData, computeEnergyGradientStops, formatEnergyValue, type Resolution } from '../lib/energyUtils';
import { computeBatteryStatus } from '../lib/batteryStatus';
import { TrendingUp } from 'lucide-react';
import type { DeviceDefinition, UiChartDefinition } from '../types/deviceDefinition';

type HistoryPoint = {
  timestamp: string;
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  powerWatts?: number | null;
  stateOfChargePercent?: number | null;
  minCellVoltageVolts?: number | null;
  maxCellVoltageVolts?: number | null;
  deltaCellVoltageVolts?: number | null;
  mosTemperatureCelsius?: number | null;
  batteryTemperatureCelsius?: number | null;
};

type CellHistoryPoint = {
  timestamp: string;
  voltageVolts?: number | null;
};

type HistoryResponse = {
  deviceId: string;
  resolution: string;
  from: string;
  to: string;
  points: HistoryPoint[];
};

type CellHistoryResponse = {
  deviceId: string;
  cellIndex: number;
  resolution: string;
  from: string;
  to: string;
  points: CellHistoryPoint[];
};

// Resolution type imported from energyUtils

type DisplayPrecision = {
  voltage: number;
  cellVoltage: number;
  current: number;
  power: number;
  temperature: number;
  soc: number;
  deltaVoltage: number;
};

const resolutions: { value: Resolution; label: string; hint: string }[] = [
  { value: '1s', label: '10m', hint: 'Last 10 minutes — 1s samples' },
  { value: '1m', label: '1h', hint: 'Last hour — 1 min averages' },
  { value: '5m', label: '24h', hint: 'Last 24 hours — 5 min averages' },
  { value: '1h', label: '7d', hint: 'Last 7 days — 1 hour averages' },
];

// Map data keys to the precision field that governs their formatting.
const keyPrecisionMap: Record<string, keyof DisplayPrecision> = {
  totalVoltageVolts: 'voltage',
  currentAmps: 'current',
  powerWatts: 'power',
  stateOfChargePercent: 'soc',
  minCellVoltageVolts: 'cellVoltage',
  maxCellVoltageVolts: 'cellVoltage',
  deltaCellVoltageVolts: 'deltaVoltage',
  mosTemperatureCelsius: 'temperature',
  batteryTemperatureCelsius: 'temperature',
};

const cellColorPalette = [
  '#a78bfa', '#34d399', '#f87171', '#38bdf8', '#fbbf24', '#fb923c',
  '#ec4899', '#818cf8', '#22d3ee', '#a3e635', '#f472b6', '#c084fc',
  '#2dd4bf', '#facc15', '#f97316', '#64748b',
];

/** Maps definition color names to hex values used by Recharts. */
const definitionColorMap: Record<string, string> = {
  emerald: '#34d399', green: '#34d399', blue: '#38bdf8', sky: '#38bdf8',
  amber: '#fbbf24', yellow: '#fbbf24', red: '#f87171', rose: '#f87171',
  purple: '#a78bfa', violet: '#a78bfa', teal: '#2dd4bf', orange: '#fb923c',
};

function resolveChartColor(name: string): string {
  return definitionColorMap[name.toLowerCase()] ?? name;
}

/** Converts definition chart declarations into LineSpec arrays keyed by the snapshot field names.
 *  Entity IDs are mapped to the snake_case→camelCase naming the backend uses for the history response. */
const entityToHistoryKey: Record<string, string> = {
  total_voltage: 'totalVoltageVolts',
  current: 'currentAmps',
  power: 'powerWatts',
  state_of_charge: 'stateOfChargePercent',
  min_cell_voltage: 'minCellVoltageVolts',
  max_cell_voltage: 'maxCellVoltageVolts',
  avg_cell_voltage: 'avgCellVoltageVolts',
  delta_cell_voltage: 'deltaCellVoltageVolts',
  mos_temperature: 'mosTemperatureCelsius',
  battery_temp_1: 'batteryTemperatureCelsius',
  battery_temp_2: 'batteryTemperatureCelsius',
};

export function HistoryCharts({ deviceId, precision, selectedCellIndices, onClearCellSelection, definition, capacityAh }: {
  deviceId: string; precision: DisplayPrecision; selectedCellIndices?: number[]; onClearCellSelection?: () => void;
  definition?: DeviceDefinition; capacityAh?: number | null;
}) {
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [data, setData] = useState<HistoryPoint[]>([]);
  const [multiCellData, setMultiCellData] = useState<Record<string, unknown>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<'default' | 'today'>('today');
  // Shared hover/selection state across all chart sections (synchronised by timestamp)
  const [sharedHoveredTime, setSharedHoveredTime] = useState<string | null>(null);
  const [sharedSelectedTime, setSharedSelectedTime] = useState<string | null>(null);

  const effectiveResolution: Resolution = resolution ?? '5m';

  const selectedCells = selectedCellIndices ?? [];
  const cellKey = selectedCells.join(',');

  // Extract chart definitions from device definition (if available)
  const definitionCharts = definition?.ui?.pages?.history?.charts;

  // Per-resolution data cache — survives resolution switches so toggling back is instant
  const historyCacheRef = useRef(new Map<string, HistoryPoint[]>());
  const cellCacheRef = useRef(new Map<string, Record<string, unknown>[]>());

  const todayRange = useMemo(() => {
    if (timeRange !== 'today') return null;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { from: startOfDay, to: endOfDay };
  }, [timeRange]);

  const getFromIso = useCallback(() => {
    const now = new Date();
    if (timeRange === 'today') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
    const ms: Record<Resolution, number> = { '1s': 600_000, '1m': 3_600_000, '5m': 86_400_000, '1h': 604_800_000 };
    return new Date(now.getTime() - ms[effectiveResolution]).toISOString();
  }, [timeRange, effectiveResolution]);

  const load = useCallback(async () => {
    const key = `${deviceId}:${effectiveResolution}:${timeRange}`;
    const cached = historyCacheRef.current.get(key);
    const windowFrom = getFromIso();

    // Incremental: only fetch from the last known timestamp when cache exists
    const fetchFrom = (cached && cached.length > 0)
      ? cached[cached.length - 1].timestamp
      : windowFrom;

    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/history?resolution=${effectiveResolution}&from=${encodeURIComponent(fetchFrom)}`);
      if (!resp.ok) return;
      const json = (await resp.json()) as HistoryResponse;

      let points: HistoryPoint[];
      if (cached && cached.length > 0 && fetchFrom !== windowFrom) {
        // Merge: keep cached points still inside the sliding window, add/overwrite new
        const merged = new Map<string, HistoryPoint>();
        for (const p of cached) if (p.timestamp >= windowFrom) merged.set(p.timestamp, p);
        for (const p of json.points) merged.set(p.timestamp, p);
        points = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      } else {
        points = json.points;
      }

      historyCacheRef.current.set(key, points);
      setData(points);
    } catch { /* ignore */ }
    finally { setIsLoading(false); }
  }, [deviceId, effectiveResolution, timeRange, getFromIso]);

  const loadCells = useCallback(async () => {
    if (selectedCells.length === 0) { setMultiCellData([]); return; }
    const key = `${deviceId}:${effectiveResolution}:${timeRange}:${cellKey}`;
    const cached = cellCacheRef.current.get(key);
    const windowFrom = getFromIso();

    const lastTs = cached && cached.length > 0 ? String(cached[cached.length - 1].timestamp ?? '') : '';
    const fetchFrom = lastTs || windowFrom;

    try {
      const results = await Promise.all(
        selectedCells.map(async (idx) => {
          const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/history/cell/${idx}?resolution=${effectiveResolution}&from=${encodeURIComponent(fetchFrom)}`);
          if (!resp.ok) return null;
          const json = (await resp.json()) as CellHistoryResponse;
          return { index: idx, points: json.points };
        })
      );

      const timeMap = new Map<string, Record<string, unknown>>();
      // Seed with cached data still within the window
      if (cached && cached.length > 0 && fetchFrom !== windowFrom) {
        for (const row of cached) {
          const ts = String(row.timestamp ?? '');
          if (ts >= windowFrom) timeMap.set(ts, { ...row });
        }
      }
      for (const result of results) {
        if (!result) continue;
        for (const point of result.points) {
          if (!timeMap.has(point.timestamp)) {
            timeMap.set(point.timestamp, { timestamp: point.timestamp, time: fmtTime(point.timestamp, effectiveResolution) });
          }
          timeMap.get(point.timestamp)![`cell_${result.index}`] = point.voltageVolts;
        }
      }

      const merged = [...timeMap.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
      cellCacheRef.current.set(key, merged);
      setMultiCellData(merged);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, effectiveResolution, timeRange, cellKey, getFromIso]);

  useEffect(() => {
    // Show cached data instantly on switch; refresh incrementally in background
    const histKey = `${deviceId}:${effectiveResolution}:${timeRange}`;
    const cached = historyCacheRef.current.get(histKey);
    if (cached && cached.length > 0) {
      setData(cached);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      setData([]);
    }

    const cellHistKey = `${histKey}:${cellKey}`;
    const cellCached = cellCacheRef.current.get(cellHistKey);
    if (cellCached && cellCached.length > 0) {
      setMultiCellData(cellCached);
    } else {
      setMultiCellData([]);
    }

    void load();
    void loadCells();
    const id = window.setInterval(() => { void load(); void loadCells(); }, effectiveResolution === '1s' ? 2000 : 30000);
    return () => window.clearInterval(id);
  }, [load, loadCells, effectiveResolution, timeRange, cellKey, deviceId]);

  const formatted = data.map((p) => ({
    ...p,
    time: fmtTime(p.timestamp, effectiveResolution),
  }));

  // For 'today' mode: pad data to cover the full 12am-12am day so the X-axis spans the entire day
  const todayPaddedFormatted = useMemo(() => {
    if (!todayRange) return formatted;
    // Build a set of time labels already in the data
    const existing = new Set(formatted.map(p => String(p.time)));
    const padded = [...formatted];
    const cur = new Date(todayRange.from);
    const stepMs = effectiveResolution === '1h' ? 3600_000 : effectiveResolution === '5m' ? 300_000 : 60_000;
    while (cur < todayRange.to) {
      const label = fmtTime(cur.toISOString(), effectiveResolution);
      if (!existing.has(label)) {
        padded.push({ time: label, timestamp: cur.toISOString() } as typeof formatted[number]);
        existing.add(label);
      }
      cur.setTime(cur.getTime() + stepMs);
    }
    // Sort by timestamp
    padded.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return padded;
  }, [todayRange, formatted, effectiveResolution]);

  const chartData = timeRange === 'today' ? todayPaddedFormatted : formatted;

  // Generate evenly-spaced hourly ticks for the today X-axis
  const todayXTicks = useMemo(() => {
    if (!todayRange) return undefined;
    const ticks: string[] = [];
    const cur = new Date(todayRange.from);
    const end = new Date(todayRange.to);
    while (cur <= end) {
      ticks.push(fmtTime(cur.toISOString(), effectiveResolution));
      cur.setHours(cur.getHours() + (effectiveResolution === '1h' ? 2 : 3));
    }
    return ticks;
  }, [todayRange, effectiveResolution]);

  const batteryStatus = useMemo(() => computeBatteryStatus(chartData, capacityAh), [chartData, capacityAh]);

  const batteryStatusSubtitle = useMemo(() => {
    const colorClass = batteryStatus.state === 'CHARGING' ? 'text-sky-400'
      : batteryStatus.state === 'DISCHARGING' ? 'text-amber-400'
      : 'text-muted-foreground';
    return (
      <span className={cn('text-[11px] font-medium', colorClass)}>
        {batteryStatus.label}
      </span>
    );
  }, [batteryStatus]);

  const handleTodayClick = () => {
    if (timeRange === 'today') {
      setTimeRange('default');
      if (resolution == null) setResolution('5m');
    } else {
      setTimeRange('today');
      setResolution(null);
    }
  };

  const handleResolutionClick = (r: Resolution) => {
    setResolution(r);
    setTimeRange('default');
  };

  return (
    <Card className='bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-3'>
        <CardTitle className='flex items-center justify-between text-sm'>
          <div className='flex items-center gap-2'>
            <TrendingUp className='h-4 w-4 text-primary' />
            History
          </div>
          <div className='flex items-center gap-1'>
            <button
              onClick={handleTodayClick}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                timeRange === 'today'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              )}
              title='Show today&apos;s data'
            >
              Today
            </button>
            <div className='mx-0.5 h-4 w-px bg-border/60' />
            {resolutions.map((r) => (
              <button
                key={r.value}
                onClick={() => handleResolutionClick(r.value)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  resolution === r.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                )}
                title={r.hint}
              >
                {r.label}
              </button>
            ))}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className='px-0 pt-4 space-y-6'>
        {isLoading && data.length === 0 ? (
          <div className='flex items-center justify-center py-12 text-sm text-muted-foreground'>Loading history…</div>
        ) : data.length === 0 ? (
          <div className='flex items-center justify-center py-12 text-sm text-muted-foreground'>No history data yet. Samples will appear once the data store collects readings.</div>
        ) : (
          <>
            {selectedCells.length > 0 ? (
              <MultiCellChartSection
                selectedCells={selectedCells}
                data={multiCellData}
                precision={precision}
                onDismiss={onClearCellSelection}
                hoveredTime={sharedHoveredTime}
                selectedTime={sharedSelectedTime}
                onHover={setSharedHoveredTime}
                onSelect={setSharedSelectedTime}
              />
            ) : (
              <ChartSection title='Voltage' unit='V' data={chartData} precision={precision}
                lines={[{ key: 'totalVoltageVolts', color: '#38bdf8', name: 'Pack Voltage' }]}
                hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                todayXTicks={todayXTicks} />
            )}
            {definitionCharts ? renderDefinitionCharts(definitionCharts, chartData, precision, effectiveResolution, sharedHoveredTime, sharedSelectedTime, setSharedHoveredTime, setSharedSelectedTime, todayXTicks, batteryStatusSubtitle) : (
              <>
                <EnergyChartSection data={chartData} resolution={effectiveResolution}
                  hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                  onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                  todayXTicks={todayXTicks} />
                <ChartSection title='State of Charge' unit='%' data={chartData} precision={precision}
                  lines={[{ key: 'stateOfChargePercent', color: '#fbbf24', name: 'SOC' }]}
              domain={[0, 100]}
              hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
              onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
              todayXTicks={todayXTicks}
              subtitle={batteryStatusSubtitle} />
            <ChartSection title='Cell Voltage Spread' unit='V' data={chartData} precision={precision}
              lines={[
                { key: 'minCellVoltageVolts', color: '#f87171', name: 'Min Cell' },
                { key: 'maxCellVoltageVolts', color: '#34d399', name: 'Max Cell' },
              ]}
              hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
              onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
              todayXTicks={todayXTicks} />
            <ChartSection title='Temperature' unit='°C' data={chartData} precision={precision}
              lines={[
                { key: 'mosTemperatureCelsius', color: '#fb923c', name: 'MOS' },
                { key: 'batteryTemperatureCelsius', color: '#38bdf8', name: 'Battery' },
              ]}
              hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
              onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
              todayXTicks={todayXTicks} />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

type LineSpec = { key: string; color: string; name: string };
type ChartInteractionState = {
  activeTooltipIndex?: number;
  activeIndex?: number;
};

/** Renders history charts from the device definition's chart declarations. */
function renderDefinitionCharts(
  charts: UiChartDefinition[],
  chartData: Record<string, unknown>[],
  precision: DisplayPrecision,
  resolution: Resolution,
  hoveredTime: string | null,
  selectedTime: string | null,
  onHover: (time: string | null) => void,
  onSelect: (time: string | null) => void,
  todayXTicks?: string[],
  batteryStatusSubtitle?: React.ReactNode,
): React.ReactNode {
  return charts.filter(c => c.type !== 'multi-cell-chart').map((chart, i) => {
    if (chart.type === 'area-chart' && chart.showEnergyTotals) {
      return (
        <EnergyChartSection
          key={`def-chart-${i}`}
          data={chartData}
          resolution={resolution}
          hoveredTime={hoveredTime}
          selectedTime={selectedTime}
          onHover={onHover}
          onSelect={onSelect}
          todayXTicks={todayXTicks}
        />
      );
    }

    const lines: LineSpec[] = (chart.traces ?? []).map(t => ({
      key: entityToHistoryKey[t.entity] ?? t.entity,
      color: resolveChartColor(t.color),
      name: t.label ?? t.entity,
    }));

    const isSocChart = chart.traces?.some(t => t.entity === 'state_of_charge');

    return (
      <ChartSection
        key={`def-chart-${i}`}
        title={chart.title}
        unit={chart.yAxis?.unit ?? ''}
        data={chartData}
        precision={precision}
        lines={lines}
        domain={chart.yAxis?.domain}
        hoveredTime={hoveredTime}
        selectedTime={selectedTime}
        onHover={onHover}
        onSelect={onSelect}
        todayXTicks={todayXTicks}
        subtitle={isSocChart ? batteryStatusSubtitle : undefined}
      />
    );
  });
}

/** Shared theme-aware style constants for Recharts */
const xTickStyle = { fontSize: 10, fill: 'var(--muted-foreground)' };
const yTickStyle = { fontSize: 9, fill: 'var(--muted-foreground)' };
const tooltipContentStyle = { backgroundColor: 'var(--card)', border: '1px solid var(--border)', borderRadius: '0.5rem', fontSize: 12, color: 'var(--foreground)' };
const tooltipLabelStyle = { color: 'var(--muted-foreground)' };
const legendStyle = { fontSize: 11, paddingTop: 4, color: 'var(--muted-foreground)' };

function ChartSection({ title, data, lines, domain, precision, hoveredTime, selectedTime, onHover, onSelect, todayXTicks, subtitle }: {
  title: string; unit: string; data: Record<string, unknown>[]; lines: LineSpec[];
  domain?: [number, number]; precision: DisplayPrecision;
  hoveredTime: string | null; selectedTime: string | null;
  onHover: (time: string | null) => void; onSelect: (time: string | null) => void;
  todayXTicks?: string[];
  subtitle?: React.ReactNode;
}) {
  // Build a formatter that rounds tooltip values based on precision config.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tooltipFormatter: any = useCallback((value: unknown, name: string, props: { dataKey?: string | number }) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) return [String(value), name];
    const key = String(props.dataKey ?? '');
    const precKey = keyPrecisionMap[key];
    const decimals = precKey != null ? precision[precKey] : 2;
    const suffix = key === 'stateOfChargePercent' ? ' %' : '';
    return [`${num.toFixed(decimals)}${suffix}`, name];
  }, [precision]);

  const activePoint = getActivePoint(data, hoveredTime, selectedTime);
  const activeTime = activePoint != null ? formatSummaryTime(activePoint.timestamp) : null;
  const isShowingLatest = hoveredTime == null && selectedTime == null;

  const handleChartMove = useCallback((state: unknown) => {
    const idx = extractActiveIndex(state);
    if (idx != null && data[idx]) {
      onHover(String(data[idx].timestamp ?? ''));
    } else {
      onHover(null);
    }
  }, [data, onHover]);

  const handleChartLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleChartClick = useCallback((state: unknown) => {
    const idx = extractActiveIndex(state);
    if (idx != null && data[idx]) {
      onSelect(String(data[idx].timestamp ?? ''));
    } else {
      onSelect(null);
    }
  }, [data, onSelect]);

  return (
    <div>
      <div className='mb-2 flex items-start justify-between gap-3 px-2 sm:px-0'>
        <div>
          <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>{title}</div>
          {subtitle && <div className='mt-1'>{subtitle}</div>}
        </div>
        <div className='text-right'>
          <div className='text-[11px] font-medium text-foreground'>
            {activeTime ?? 'No data'}
          </div>
          {selectedTime != null && (
            <button
              onClick={() => onSelect(null)}
              className='mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground'
            >
              Show latest
            </button>
          )}
        </div>
      </div>
      <ResponsiveContainer width='100%' height={180}>
        <LineChart
          data={data}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' opacity={0.4} />
          <XAxis dataKey='time' tick={xTickStyle} tickLine={false} axisLine={false} {...(todayXTicks ? { ticks: todayXTicks } : {})} />
          <YAxis orientation='right' width={32} tick={yTickStyle} tickLine={false} axisLine={false} domain={domain ?? ['auto', 'auto']} />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={{ color: 'var(--foreground)' }}
            formatter={tooltipFormatter}
          />
          <Legend wrapperStyle={legendStyle} />
          {lines.map((l) => (
            <Line
              key={l.key}
              type='monotone'
              dataKey={l.key}
              stroke={l.color}
              name={l.name}
              dot={false}
              strokeWidth={1.5}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function EnergyChartSection({ data, resolution, hoveredTime, selectedTime, onHover, onSelect, todayXTicks }: {
  data: Record<string, unknown>[]; resolution: Resolution;
  hoveredTime: string | null; selectedTime: string | null;
  onHover: (time: string | null) => void; onSelect: (time: string | null) => void;
  todayXTicks?: string[];
}) {
  const { energyData, dischargedKwh, chargedKwh, yDomain, zeroOffset } = useMemo(
    () => computeEnergyData(data, resolution),
    [data, resolution],
  );

  const baselineMarkers = useMemo(() => {
    const result: { time: string; isMajor: boolean }[] = [];
    if (resolution === '1s') {
      // 10-minute mode: small dot every minute
      let lastMin = -1;
      for (const p of energyData) {
        const ts = typeof p.timestamp === 'string' ? new Date(p.timestamp as string) : null;
        if (!ts || isNaN(ts.getTime())) continue;
        const min = ts.getMinutes();
        if (min !== lastMin) {
          result.push({ time: String(p.time), isMajor: false });
          lastMin = min;
        }
      }
    } else if (resolution === '1m') {
      // 1h mode: small dot every 10 minutes
      let lastSlot = -1;
      for (const p of energyData) {
        const ts = typeof p.timestamp === 'string' ? new Date(p.timestamp as string) : null;
        if (!ts || isNaN(ts.getTime())) continue;
        const slot = Math.floor(ts.getMinutes() / 10);
        if (slot !== lastSlot) {
          result.push({ time: String(p.time), isMajor: false });
          lastSlot = slot;
        }
      }
    } else if (resolution === '5m') {
      // 24h / today mode: small dot every 1h, bigger dot at 6h boundaries
      let lastHour = -1;
      for (const p of energyData) {
        const ts = typeof p.timestamp === 'string' ? new Date(p.timestamp as string) : null;
        if (!ts || isNaN(ts.getTime())) continue;
        const hour = ts.getHours();
        if (hour !== lastHour) {
          result.push({ time: String(p.time), isMajor: hour % 6 === 0 });
          lastHour = hour;
        }
      }
    } else {
      // today / 7d (1h resolution): small dot every 1h, bigger dot at 6h boundaries
      let lastHour = -1;
      for (const p of energyData) {
        const ts = typeof p.timestamp === 'string' ? new Date(p.timestamp as string) : null;
        if (!ts || isNaN(ts.getTime())) continue;
        const hour = ts.getHours();
        if (hour !== lastHour) {
          result.push({ time: String(p.time), isMajor: hour % 6 === 0 });
          lastHour = hour;
        }
      }
    }
    return result;
  }, [energyData, resolution]);

  const activePoint = getActivePoint(energyData, hoveredTime, selectedTime);
  const activeTime = activePoint != null ? formatSummaryTime(activePoint.timestamp) : null;
  const isShowingLatest = hoveredTime == null && selectedTime == null;

  const handleChartMove = useCallback((state: unknown) => {
    const idx = extractActiveIndex(state);
    if (idx != null && energyData[idx]) {
      onHover(String(energyData[idx].timestamp ?? ''));
    } else {
      onHover(null);
    }
  }, [energyData, onHover]);
  const handleChartLeave = useCallback(() => { onHover(null); }, [onHover]);
  const handleChartClick = useCallback((state: unknown) => {
    const idx = extractActiveIndex(state);
    if (idx != null && energyData[idx]) {
      onSelect(String(energyData[idx].timestamp ?? ''));
    } else {
      onSelect(null);
    }
  }, [energyData, onSelect]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tooltipFormatter: any = useCallback((value: unknown) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) return [String(value), 'Power'];
    const fmt = formatEnergyValue(num);
    return [fmt.text, fmt.label];
  }, []);

  // Show absolute values on Y-axis (no negatives)
  const yTickFormatter = useCallback((v: number) => `${Math.abs(v).toFixed(1)}`, []);

  return (
    <div>
      <div className='mb-2 flex items-start justify-between gap-3 px-2 sm:px-0'>
        <div>
          <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Energy</div>
          <div className='mt-1.5 flex flex-wrap gap-x-3 gap-y-1'>
            <span className='flex items-center gap-1 text-xs text-emerald-400'>
              <span className='text-[10px]'>↑</span> Charged: <span className='font-semibold'>{chargedKwh.toFixed(1)} kWh</span>
            </span>
            <span className='flex items-center gap-1 text-xs text-rose-400'>
              <span className='text-[10px]'>↓</span> Discharged: <span className='font-semibold'>{dischargedKwh.toFixed(1)} kWh</span>
            </span>
          </div>
        </div>
        <div className='text-right'>
          <div className='text-[11px] font-medium text-foreground'>
            {activeTime ?? 'No data'}
          </div>
          {selectedTime != null && (
            <button
              onClick={() => onSelect(null)}
              className='mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground'
            >
              Show latest
            </button>
          )}
        </div>
      </div>
      <ResponsiveContainer width='100%' height={180}>
        <AreaChart
          data={energyData}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <defs>
            <linearGradient id='energyGradient' x1='0' y1='0' x2='0' y2='1'>
              {computeEnergyGradientStops(zeroOffset).map((s, i) => (
                <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
              ))}
            </linearGradient>
            <linearGradient id='energyStrokeGradient' x1='0' y1='0' x2='0' y2='1'>
              {computeEnergyGradientStops(zeroOffset, 1, 1).map((s, i) => (
                <stop key={i} offset={s.offset} stopColor={s.color} />
              ))}
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' opacity={0.4} />
          <XAxis dataKey='time' tick={xTickStyle} tickLine={false} axisLine={false} {...(todayXTicks ? { ticks: todayXTicks } : {})} />
          <YAxis orientation='right' width={32} tick={yTickStyle} tickLine={false} axisLine={false} domain={yDomain} tickFormatter={yTickFormatter} />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={{ color: 'var(--foreground)' }}
            formatter={tooltipFormatter}
          />
          {baselineMarkers.map(({ time, isMajor }, i) => (
            <ReferenceDot key={`bm-${i}`} x={time} y={0} r={isMajor ? 3 : 1.5} fill={isMajor ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.2)'} stroke='none' />
          ))}
          <Area type='monotone' dataKey='signedPowerKw' stroke='url(#energyStrokeGradient)' fill='url(#energyGradient)' strokeWidth={1.5} dot={false} isAnimationActive={false} baseValue={0} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MultiCellChartSection({ selectedCells, data, precision, onDismiss, hoveredTime, selectedTime, onHover, onSelect }: {
  selectedCells: number[]; data: Record<string, unknown>[]; precision: DisplayPrecision; onDismiss?: () => void;
  hoveredTime: string | null; selectedTime: string | null;
  onHover: (time: string | null) => void; onSelect: (time: string | null) => void;
}) {
  const cellLines = selectedCells.map((idx, i) => ({
    key: `cell_${idx}`,
    color: cellColorPalette[i % cellColorPalette.length],
    name: `Cell ${idx}`,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tooltipFormatter: any = useCallback((value: unknown, name: string) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) return [String(value), name];
    return [`${num.toFixed(precision.cellVoltage)}V`, name];
  }, [precision.cellVoltage]);

  const activePoint = getActivePoint(data, hoveredTime, selectedTime);
  const activeTime = activePoint != null ? formatSummaryTime(activePoint.timestamp) : null;
  const isShowingLatest = hoveredTime == null && selectedTime == null;

  const handleChartMove = useCallback((state: unknown) => {
    const idx = extractActiveIndex(state);
    if (idx != null && data[idx]) {
      onHover(String(data[idx].timestamp ?? ''));
    } else {
      onHover(null);
    }
  }, [data, onHover]);
  const handleChartLeave = useCallback(() => { onHover(null); }, [onHover]);
  const handleChartClick = useCallback((state: unknown) => {
    const idx = extractActiveIndex(state);
    if (idx != null && data[idx]) {
      onSelect(String(data[idx].timestamp ?? ''));
    } else {
      onSelect(null);
    }
  }, [data, onSelect]);

  return (
    <div>
      <div className='mb-2 flex items-start justify-between gap-3 px-2 sm:px-0'>
        <div className='flex items-center gap-2'>
          <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>
            Cell Voltage{selectedCells.length > 1 ? 's' : ''}
          </div>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className='rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground'
            >
              ✕ Show Pack
            </button>
          )}
        </div>
        <div className='text-right'>
          <div className='text-[11px] font-medium text-foreground'>
            {activeTime ?? 'No data'}
          </div>
          {selectedTime != null && (
            <button
              onClick={() => onSelect(null)}
              className='mt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground'
            >
              Show latest
            </button>
          )}
        </div>
      </div>
      <ResponsiveContainer width='100%' height={180}>
        <LineChart
          data={data}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' opacity={0.4} />
          <XAxis dataKey='time' tick={xTickStyle} tickLine={false} axisLine={false} />
          <YAxis orientation='right' width={32} tick={yTickStyle} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={tooltipContentStyle}
            labelStyle={tooltipLabelStyle}
            itemStyle={{ color: 'var(--foreground)' }}
            formatter={tooltipFormatter}
          />
          <Legend wrapperStyle={legendStyle} />
          {cellLines.map((l) => (
            <Line key={l.key} type='monotone' dataKey={l.key} stroke={l.color} name={l.name} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function fmtTime(iso: string, resolution: Resolution): string {
  const d = new Date(iso);
  if (resolution === '1h') {
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:00`;
  }
  const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  if (resolution === '5m') {
    const now = new Date();
    if (d.getDate() !== now.getDate() || d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) {
      return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${time}`;
    }
    return time;
  }
  if (resolution === '1m') {
    return time;
  }
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function extractActiveIndex(state: unknown): number | null {
  if (typeof state !== 'object' || state == null) {
    return null;
  }

  const chartState = state as ChartInteractionState;
  const candidate = chartState.activeTooltipIndex ?? chartState.activeIndex;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function getActivePoint(data: Record<string, unknown>[], hoveredTime: string | null, selectedTime: string | null) {
  const ts = hoveredTime ?? selectedTime;
  if (ts != null) {
    return data.find(p => p.timestamp === ts) ?? data.at(-1) ?? null;
  }

  return data.at(-1) ?? null;
}

function formatSummaryTime(value: unknown) {
  if (typeof value !== 'string') {
    return 'Latest sample';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'Latest sample';
  }

  return parsed.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
