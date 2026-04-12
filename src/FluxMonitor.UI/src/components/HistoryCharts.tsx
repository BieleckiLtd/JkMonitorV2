import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, ReferenceDot,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { cn } from '../lib/utils';
import {
  computeEnergyData,
  computeEnergyGradientStops,
  formatEnergyValue,
  getIntervalHours,
  getIntervalMilliseconds,
  normalizeResolution,
  type Resolution,
} from '../lib/energyUtils';
import { computeBatteryStatus } from '../lib/batteryStatus';
import { TrendingUp } from 'lucide-react';
import type { DeviceDefinition, UiChartDefinition } from '../types/deviceDefinition';
import {
  convertTemperatureValue,
  getTemperatureDisplayUnit,
  isCelsiusUnit,
  type TemperatureUnit,
} from '../lib/temperatureUnits';

type HistoryPoint = Record<string, unknown> & {
  timestamp: string;
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

type SeriesHistoryPoint = {
  timestamp: string;
  values: Record<string, number | null>;
};

type SeriesHistoryResponse = {
  deviceId: string;
  resolution: string;
  from: string;
  to: string;
  entities: string[];
  points: SeriesHistoryPoint[];
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

type HistoryRangeId = '10m' | '1h' | '24h' | '7d';

type DisplayPrecision = {
  voltage: number;
  cellVoltage: number;
  current: number;
  power: number;
  temperature: number;
  soc: number;
  deltaVoltage: number;
};

type ChartDataPoint = Record<string, unknown> & {
  timestamp: string;
  time?: string;
};

type CachedHistoryEntry = {
  points: ChartDataPoint[];
  resolution: Resolution;
};

type CachedCellEntry = {
  points: ChartDataPoint[];
  resolution: Resolution;
};

type HistoryDisplayMode = HistoryRangeId | 'today';

const historyRanges: { id: HistoryRangeId; label: string; hint: string; queryResolution: Resolution; windowMs: number }[] = [
  { id: '10m', label: '10m', hint: 'Last 10 minutes — 1s samples from memory', queryResolution: '1s', windowMs: 600_000 },
  { id: '1h', label: '1h', hint: 'Last hour — 1-minute rollups from memory', queryResolution: '1m', windowMs: 3_600_000 },
  { id: '24h', label: '24h', hint: 'Last 24 hours — persisted averages', queryResolution: '5m', windowMs: 86_400_000 },
  { id: '7d', label: '7d', hint: 'Last 7 days — persisted averages', queryResolution: '5m', windowMs: 604_800_000 },
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

const keyUnitSuffix: Record<string, string> = {
  totalVoltageVolts: 'V',
  currentAmps: 'A',
  powerWatts: 'W',
  stateOfChargePercent: '%',
  minCellVoltageVolts: 'V',
  maxCellVoltageVolts: 'V',
  deltaCellVoltageVolts: 'V',
  mosTemperatureCelsius: '°C',
  batteryTemperatureCelsius: '°C',
};

function formatActiveValues(
  point: Record<string, unknown> | null,
  lines: LineSpec[],
  getDecimalsForKey: (key: string) => number,
  getUnitForKey: (key: string) => string,
): string | null {
  if (!point) return null;
  const parts: string[] = [];
  for (const l of lines) {
    const raw = point[l.key];
    if (raw == null) continue;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(num)) continue;
    const decimals = getDecimalsForKey(l.key);
    const unit = getUnitForKey(l.key);
    parts.push(`${num.toFixed(decimals)}${unit}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

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

function getDefinitionEntity(definition: DeviceDefinition | undefined, entityId: string) {
  return definition?.entities.find((entity) => entity.id === entityId)
    ?? definition?.computedEntities?.find((entity) => entity.id === entityId);
}

function resolveHistoryEntities(definition?: DeviceDefinition) {
  const chartEntities = (definition?.ui?.pages?.history?.charts ?? [])
    .flatMap((chart) => chart.traces?.map((trace) => trace.entity) ?? [])
    .filter((entity): entity is string => Boolean(entity));

  return [...new Set(chartEntities)];
}

function buildLegacyAliases(
  values: Record<string, number | null>,
  definition?: DeviceDefinition,
): Record<string, number | null> {
  const aliases: Record<string, number | null> = {};

  const attachAlias = (entityId: string | undefined, aliasKey: string) => {
    if (!entityId) {
      return;
    }

    const value = values[entityId];
    if (value != null) {
      aliases[aliasKey] = value;
    }
  };

  const roleEntity = (role: string) =>
    definition?.entities.find((entity) => entity.role === role)?.id
    ?? definition?.computedEntities?.find((entity) => entity.role === role)?.id;

  attachAlias(roleEntity('total-voltage') ?? 'total_voltage', 'totalVoltageVolts');
  attachAlias(roleEntity('current') ?? 'current', 'currentAmps');
  attachAlias(roleEntity('power') ?? 'power', 'powerWatts');
  attachAlias(roleEntity('state-of-charge') ?? 'state_of_charge', 'stateOfChargePercent');
  attachAlias('min_cell_voltage', 'minCellVoltageVolts');
  attachAlias('max_cell_voltage', 'maxCellVoltageVolts');
  attachAlias('delta_cell_voltage', 'deltaCellVoltageVolts');
  attachAlias('mos_temperature', 'mosTemperatureCelsius');
  attachAlias('battery_temp_1', 'batteryTemperatureCelsius');

  return aliases;
}

function applyTemperatureUnitToPoint(
  point: Record<string, unknown>,
  definition: DeviceDefinition | undefined,
  temperatureUnit: TemperatureUnit,
): Record<string, unknown> {
  if (temperatureUnit === 'c') {
    return point;
  }

  const converted: Record<string, unknown> = { ...point };
  for (const [key, rawValue] of Object.entries(point)) {
    if (key === 'timestamp' || key === 'time') {
      continue;
    }

    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    if (!Number.isFinite(value)) {
      continue;
    }

    const entity = getDefinitionEntity(definition, key);
    const unit = entity
      ? ('source' in entity ? entity.source?.unit : entity.unit)
      : keyUnitSuffix[key];
    if (isCelsiusUnit(unit)) {
      converted[key] = convertTemperatureValue(value, temperatureUnit);
    }
  }

  return converted;
}

export function HistoryCharts({ deviceId, precision, selectedCellIndices, onClearCellSelection, definition, capacityAh, temperatureUnit = 'c' }: {
  deviceId: string; precision: DisplayPrecision; selectedCellIndices?: number[]; onClearCellSelection?: () => void;
  definition?: DeviceDefinition; capacityAh?: number | null; temperatureUnit?: TemperatureUnit;
}) {
  const [selectedRange, setSelectedRange] = useState<HistoryRangeId>('24h');
  const [data, setData] = useState<ChartDataPoint[]>([]);
  const [multiCellData, setMultiCellData] = useState<ChartDataPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<'range' | 'today'>('today');
  // Shared hover/selection state across all chart sections (synchronised by timestamp)
  const [sharedHoveredTime, setSharedHoveredTime] = useState<string | null>(null);
  const [sharedSelectedTime, setSharedSelectedTime] = useState<string | null>(null);

  const activeRange = historyRanges.find((range) => range.id === selectedRange) ?? historyRanges[2];
  const requestedResolution: Resolution = timeRange === 'today' ? '5m' : activeRange.queryResolution;
  const displayMode: HistoryDisplayMode = timeRange === 'today' ? 'today' : selectedRange;
  const [resolvedResolution, setResolvedResolution] = useState<Resolution>(requestedResolution);

  const selectedCells = selectedCellIndices ?? [];
  const cellKey = selectedCells.join(',');

  // Extract chart definitions from device definition (if available)
  const definitionCharts = definition?.ui?.pages?.history?.charts;
  const definitionHistoryEntities = resolveHistoryEntities(definition);

  // Per-resolution data cache — survives resolution switches so toggling back is instant
  const historyCacheRef = useRef(new Map<string, CachedHistoryEntry>());
  const cellCacheRef = useRef(new Map<string, CachedCellEntry>());

  useEffect(() => {
    setResolvedResolution(requestedResolution);
  }, [requestedResolution]);

  const todayRange = useMemo(() => {
    if (timeRange !== 'today') return null;
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return { from: startOfDay, to: endOfDay };
  }, [timeRange]);

  const getFromIso = useCallback(() => {
    if (timeRange === 'today') {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
    return new Date(Date.now() - activeRange.windowMs).toISOString();
  }, [activeRange.windowMs, timeRange]);

  const load = useCallback(async () => {
    const key = `${deviceId}:${timeRange === 'today' ? 'today' : selectedRange}:${requestedResolution}`;
    const cached = historyCacheRef.current.get(key);
    const cachedPoints = cached?.points ?? [];
    const windowFrom = getFromIso();

    // Incremental: only fetch from the last known timestamp when cache exists
    const fetchFrom = cachedPoints.length > 0
      ? cachedPoints[cachedPoints.length - 1].timestamp
      : windowFrom;

    try {
      const historyUrl = definition && definitionCharts && definitionHistoryEntities.length > 0
        ? `/api/devices/${encodeURIComponent(deviceId)}/history/series?resolution=${requestedResolution}&from=${encodeURIComponent(fetchFrom)}&${definitionHistoryEntities.map((entity) => `entity=${encodeURIComponent(entity)}`).join('&')}`
        : `/api/devices/${encodeURIComponent(deviceId)}/history?resolution=${requestedResolution}&from=${encodeURIComponent(fetchFrom)}`;
      const resp = await fetch(historyUrl);
      if (!resp.ok) return;
      const json = await resp.json() as HistoryResponse | SeriesHistoryResponse;
      const normalizedPoints = 'entities' in json
        ? json.points.map((point) => ({
          timestamp: point.timestamp,
          ...point.values,
          ...buildLegacyAliases(point.values, definition),
        }))
        : json.points;
      const responseResolution = normalizeResolution(json.resolution, requestedResolution);

      let points: ChartDataPoint[];
      if (cachedPoints.length > 0 && fetchFrom !== windowFrom) {
        // Merge: keep cached points still inside the sliding window, add/overwrite new
        const merged = new Map<string, ChartDataPoint>();
        for (const p of cachedPoints) if (p.timestamp >= windowFrom) merged.set(p.timestamp, p);
        for (const p of normalizedPoints) merged.set(String(p.timestamp), p);
        points = [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      } else {
        points = normalizedPoints as ChartDataPoint[];
      }

      historyCacheRef.current.set(key, { points, resolution: responseResolution });
      setResolvedResolution(responseResolution);
      setData(points);
    } catch { /* ignore */ }
    finally { setIsLoading(false); }
  }, [definition, definitionCharts, definitionHistoryEntities, deviceId, getFromIso, requestedResolution, selectedRange, timeRange]);

  const loadCells = useCallback(async () => {
    if (selectedCells.length === 0) { setMultiCellData([]); return; }
    const key = `${deviceId}:${timeRange === 'today' ? 'today' : selectedRange}:${requestedResolution}:${cellKey}`;
    const cached = cellCacheRef.current.get(key);
    const cachedPoints = cached?.points ?? [];
    const windowFrom = getFromIso();

    const lastTs = cachedPoints.length > 0 ? String(cachedPoints[cachedPoints.length - 1].timestamp ?? '') : '';
    const fetchFrom = lastTs || windowFrom;

    try {
      const results = await Promise.all(
        selectedCells.map(async (idx) => {
          const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/history/cell/${idx}?resolution=${requestedResolution}&from=${encodeURIComponent(fetchFrom)}`);
          if (!resp.ok) return null;
          const json = (await resp.json()) as CellHistoryResponse;
          return {
            index: idx,
            points: json.points,
            resolution: normalizeResolution(json.resolution, requestedResolution),
          };
        })
      );
      const responseResolution = results.find((result) => result)?.resolution ?? cached?.resolution ?? requestedResolution;

      const timeMap = new Map<string, ChartDataPoint>();
      // Seed with cached data still within the window
      if (cachedPoints.length > 0 && fetchFrom !== windowFrom) {
        for (const row of cachedPoints) {
          const ts = String(row.timestamp ?? '');
          if (ts >= windowFrom) timeMap.set(ts, { ...row });
        }
      }
      for (const result of results) {
        if (!result) continue;
        for (const point of result.points) {
          if (!timeMap.has(point.timestamp)) {
            timeMap.set(point.timestamp, { timestamp: point.timestamp, time: fmtTime(point.timestamp, responseResolution, displayMode) });
          }
          timeMap.get(point.timestamp)![`cell_${result.index}`] = point.voltageVolts;
        }
      }

      const merged = [...timeMap.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      cellCacheRef.current.set(key, { points: merged, resolution: responseResolution });
      setResolvedResolution(responseResolution);
      setMultiCellData(merged);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellKey, deviceId, displayMode, getFromIso, requestedResolution, selectedRange, timeRange]);

  useEffect(() => {
    // Show cached data instantly on switch; refresh incrementally in background
    const histKey = `${deviceId}:${timeRange === 'today' ? 'today' : selectedRange}:${requestedResolution}`;
    const cached = historyCacheRef.current.get(histKey);
    if (cached && cached.points.length > 0) {
      setData(cached.points);
      setResolvedResolution(cached.resolution);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      setData([]);
      setResolvedResolution(requestedResolution);
    }

    const cellHistKey = `${histKey}:${cellKey}`;
    const cellCached = cellCacheRef.current.get(cellHistKey);
    if (cellCached && cellCached.points.length > 0) {
      setMultiCellData(cellCached.points);
      if (!cached) {
        setResolvedResolution(cellCached.resolution);
      }
    } else {
      setMultiCellData([]);
    }

    void load();
    void loadCells();
    const id = window.setInterval(() => { void load(); void loadCells(); }, requestedResolution === '1s' ? 2000 : 30000);
    return () => window.clearInterval(id);
  }, [cellKey, deviceId, load, loadCells, requestedResolution, selectedRange, timeRange]);

  const getDecimalsForKey = useCallback((key: string) => {
    const entity = getDefinitionEntity(definition, key);
    if (entity?.display?.precision != null) {
      return entity.display.precision;
    }

    const precisionKey = keyPrecisionMap[key];
    return precisionKey != null ? precision[precisionKey] : 2;
  }, [definition, precision]);

  const getUnitForKey = useCallback((key: string) => {
    const entity = getDefinitionEntity(definition, key);
    const sourceUnit = entity
      ? ('source' in entity ? entity.source?.unit : entity.unit)
      : keyUnitSuffix[key];

    return getTemperatureDisplayUnit(sourceUnit, temperatureUnit) ?? '';
  }, [definition, temperatureUnit]);

  const displayData = useMemo(
    () => data.map((point) => applyTemperatureUnitToPoint(point, definition, temperatureUnit) as ChartDataPoint),
    [data, definition, temperatureUnit],
  );

  const formatted: ChartDataPoint[] = displayData.map((p) => ({
    ...p,
    time: fmtTime(p.timestamp, resolvedResolution, displayMode),
  }));

  // For 'today' mode: pad data to cover the full 12am-12am day so the X-axis spans the entire day
  const todayPaddedFormatted = useMemo(() => {
    if (!todayRange) return formatted;
    // Build a set of time labels already in the data
    const existing = new Set(formatted.map(p => String(p.time)));
    const padded = [...formatted];
    const cur = new Date(todayRange.from);
    const stepMs = getIntervalMilliseconds(resolvedResolution);
    while (cur < todayRange.to) {
      const label = fmtTime(cur.toISOString(), resolvedResolution, displayMode);
      if (!existing.has(label)) {
        padded.push({ time: label, timestamp: cur.toISOString() } as typeof formatted[number]);
        existing.add(label);
      }
      cur.setTime(cur.getTime() + stepMs);
    }
    // Sort by timestamp
    padded.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return padded;
  }, [displayMode, todayRange, formatted, resolvedResolution]);

  const chartData = timeRange === 'today' ? todayPaddedFormatted : formatted;

  // Generate evenly-spaced hourly ticks for the today X-axis
  const todayXTicks = useMemo(() => {
    if (!todayRange) return undefined;
    const ticks: string[] = [];
    const cur = new Date(todayRange.from);
    const end = new Date(todayRange.to);
    while (cur <= end) {
      ticks.push(fmtTime(cur.toISOString(), resolvedResolution, displayMode));
      cur.setHours(cur.getHours() + (getIntervalHours(resolvedResolution) >= 1 ? 2 : 3));
    }
    return ticks;
  }, [displayMode, todayRange, resolvedResolution]);

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
      setTimeRange('range');
    } else {
      setTimeRange('today');
    }
  };

  const handleRangeClick = (rangeId: HistoryRangeId) => {
    setSelectedRange(rangeId);
    setTimeRange('range');
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
            {historyRanges.map((r) => (
              <button
                key={r.id}
                onClick={() => handleRangeClick(r.id)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  timeRange === 'range' && selectedRange === r.id
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
              <ChartSection title='Voltage' data={chartData}
                lines={[{ key: 'totalVoltageVolts', color: '#38bdf8', name: 'Pack Voltage' }]}
                getDecimalsForKey={getDecimalsForKey}
                getUnitForKey={getUnitForKey}
                hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                todayXTicks={todayXTicks} />
            )}
            {definitionCharts ? renderDefinitionCharts(definitionCharts, chartData, resolvedResolution, displayMode, sharedHoveredTime, sharedSelectedTime, setSharedHoveredTime, setSharedSelectedTime, todayXTicks, batteryStatusSubtitle, getDecimalsForKey, getUnitForKey) : (
              <>
                <EnergyChartSection data={chartData} resolution={resolvedResolution} displayMode={displayMode}
                  hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                  onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                  todayXTicks={todayXTicks} />
                <ChartSection title='State of Charge' data={chartData}
                  lines={[{ key: 'stateOfChargePercent', color: '#fbbf24', name: 'SOC' }]}
                  getDecimalsForKey={getDecimalsForKey}
                  getUnitForKey={getUnitForKey}
              domain={[0, 100]}
              hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
              onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
              todayXTicks={todayXTicks}
              subtitle={batteryStatusSubtitle} />
            <ChartSection title='Cell Voltage Spread' data={chartData}
              lines={[
                { key: 'minCellVoltageVolts', color: '#f87171', name: 'Min Cell' },
                { key: 'maxCellVoltageVolts', color: '#34d399', name: 'Max Cell' },
              ]}
              getDecimalsForKey={getDecimalsForKey}
              getUnitForKey={getUnitForKey}
              hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
              onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
              todayXTicks={todayXTicks} />
            <ChartSection title='Temperature' data={chartData}
              lines={[
                { key: 'mosTemperatureCelsius', color: '#fb923c', name: 'MOS' },
                { key: 'batteryTemperatureCelsius', color: '#38bdf8', name: 'Battery' },
              ]}
              getDecimalsForKey={getDecimalsForKey}
              getUnitForKey={getUnitForKey}
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
  chartData: ChartDataPoint[],
  resolution: Resolution,
  displayMode: HistoryDisplayMode,
  hoveredTime: string | null,
  selectedTime: string | null,
  onHover: (time: string | null) => void,
  onSelect: (time: string | null) => void,
  todayXTicks?: string[],
  batteryStatusSubtitle?: React.ReactNode,
  getDecimalsForKey?: (key: string) => number,
  getUnitForKey?: (key: string) => string,
): React.ReactNode {
  return charts.filter(c => c.type !== 'multi-cell-chart').map((chart, i) => {
    if (chart.type === 'area-chart' && chart.showEnergyTotals) {
      return (
        <EnergyChartSection
          key={`def-chart-${i}`}
          data={chartData}
          resolution={resolution}
          displayMode={displayMode}
          hoveredTime={hoveredTime}
          selectedTime={selectedTime}
          onHover={onHover}
          onSelect={onSelect}
          todayXTicks={todayXTicks}
        />
      );
    }

    const lines: LineSpec[] = (chart.traces ?? []).map(t => ({
      key: t.entity,
      color: resolveChartColor(t.color),
      name: t.label ?? t.entity,
    }));

    const isSocChart = chart.traces?.some(t => t.entity === 'state_of_charge');

    return (
        <ChartSection
          key={`def-chart-${i}`}
          title={chart.title}
          data={chartData}
          lines={lines}
          getDecimalsForKey={getDecimalsForKey ?? (() => 2)}
          getUnitForKey={getUnitForKey ?? (() => '')}
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

function ChartSection({ title, data, lines, domain, getDecimalsForKey, getUnitForKey, hoveredTime, selectedTime, onHover, onSelect, todayXTicks, subtitle }: {
  title: string; data: ChartDataPoint[]; lines: LineSpec[];
  domain?: [number, number];
  getDecimalsForKey: (key: string) => number;
  getUnitForKey: (key: string) => string;
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
    const decimals = getDecimalsForKey(key);
    const suffix = getUnitForKey(key);
    return [`${num.toFixed(decimals)}${suffix}`, name];
  }, [getDecimalsForKey, getUnitForKey]);

  const activePoint = getActivePoint(data, hoveredTime, selectedTime);
  const activeValueText = lines.length === 1 ? formatActiveValues(activePoint, lines, getDecimalsForKey, getUnitForKey) : null;

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
          {lines.length === 1 && (
            <div className='text-[11px] font-medium text-foreground'>
              {activeValueText ?? 'No data'}
            </div>
          )}
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

export function EnergyChartSection({ data, resolution, displayMode, hoveredTime, selectedTime, onHover, onSelect, todayXTicks }: {
  data: Record<string, unknown>[]; resolution: Resolution; displayMode: HistoryDisplayMode;
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
    if (displayMode === '10m') {
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
    } else if (displayMode === '1h') {
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
    } else {
      // 24h / today / 7d modes: small dot every 1h, bigger dot at 6h boundaries
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
  }, [displayMode, energyData]);

  const activePoint = getActivePoint(energyData, hoveredTime, selectedTime);
  const activeEnergyText = useMemo(() => {
    if (!activePoint) return null;
    const raw = activePoint.displayPowerKw;
    if (raw == null) return null;
    const num = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(num)) return null;
    const fmt = formatEnergyValue(num);
    return fmt.isZero ? '0 W' : `${fmt.text} ${fmt.label}`;
  }, [activePoint]);

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
            {activeEnergyText ?? 'No data'}
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
  const activeCellText = useMemo(() => {
    if (!activePoint) return null;
    const parts: string[] = [];
    for (const l of cellLines) {
      const raw = activePoint[l.key];
      if (raw == null) continue;
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isNaN(num)) continue;
      parts.push(`${num.toFixed(precision.cellVoltage)}V`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [activePoint, cellLines, precision.cellVoltage]);

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
            {activeCellText ?? 'No data'}
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

function fmtTime(iso: string, resolution: Resolution, displayMode: HistoryDisplayMode): string {
  const d = new Date(iso);
  if (resolution === '1s') {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  }
  if (displayMode === '1h') {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  if (getIntervalHours(resolution) >= 1) {
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:00`;
  }
  const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  if (displayMode === 'today') {
    return time;
  }
  if (displayMode === '24h' || displayMode === '7d') {
    const now = new Date();
    if (d.getDate() !== now.getDate() || d.getMonth() !== now.getMonth() || d.getFullYear() !== now.getFullYear()) {
      return `${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getDate().toString().padStart(2, '0')} ${time}`;
    }
    return time;
  }
  return time;
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

  // Find the last point that has actual data (not just padding with time/timestamp).
  for (let i = data.length - 1; i >= 0; i--) {
    const p = data[i];
    const keys = Object.keys(p);
    if (keys.some(k => k !== 'time' && k !== 'timestamp' && p[k] != null)) {
      return p;
    }
  }
  return null;
}
