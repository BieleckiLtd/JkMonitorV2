import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, ReferenceDot, ReferenceLine,
  XAxis, YAxis, CartesianGrid,
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

const legacyMillivoltKeys = new Set(['deltaCellVoltageVolts']);
const millivoltFormatters = new Set(['millivolts', 'millivolt', 'mv']);

function formatWithUnit(valueText: string, unit: string) {
  return unit ? `${valueText} ${unit}` : valueText;
}

function isMillivoltFormatter(formatter: string | null | undefined) {
  return formatter != null && millivoltFormatters.has(formatter.toLowerCase());
}

function formatChartValue(
  value: number,
  key: string,
  getDecimalsForKey: (key: string) => number,
  getUnitForKey: (key: string) => string,
  getFormatterForKey: (key: string) => string | null | undefined,
) {
  if (isMillivoltFormatter(getFormatterForKey(key)) || legacyMillivoltKeys.has(key)) {
    return formatWithUnit(Math.round(value * 1000).toString(), 'mV');
  }

  return formatWithUnit(value.toFixed(getDecimalsForKey(key)), getUnitForKey(key));
}

function formatLegendValue(
  point: Record<string, unknown>,
  line: LineSpec,
  getDecimalsForKey: (key: string) => number,
  getUnitForKey: (key: string) => string,
  getFormatterForKey: (key: string) => string | null | undefined,
): string {
  const raw = point[line.key];
  if (raw == null) {
    return 'N/D';
  }

  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(num)
    ? String(raw)
    : formatChartValue(num, line.key, getDecimalsForKey, getUnitForKey, getFormatterForKey);
}

const cellColorPalette = [
  '#a78bfa', '#34d399', '#f87171', '#38bdf8', '#fbbf24', '#fb923c',
  '#ec4899', '#818cf8', '#22d3ee', '#a3e635', '#f472b6', '#c084fc',
  '#2dd4bf', '#facc15', '#f97316', '#64748b',
];

/** Maps definition color names to hex values used by Recharts. */
const definitionColorMap: Record<string, string> = {
  emerald: '#34d399', green: '#34d399', blue: '#38bdf8', sky: '#38bdf8',
  gray: '#94a3b8', grey: '#94a3b8',
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
  const definitionHistoryEntities = useMemo(() => resolveHistoryEntities(definition), [definition]);
  const definitionHistoryQuery = useMemo(
    () => definitionHistoryEntities.map((entity) => `entity=${encodeURIComponent(entity)}`).join('&'),
    [definitionHistoryEntities],
  );

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
      const historyUrl = definition && definitionHistoryQuery.length > 0
        ? `/api/devices/${encodeURIComponent(deviceId)}/history/series?resolution=${requestedResolution}&from=${encodeURIComponent(fetchFrom)}&${definitionHistoryQuery}`
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
  }, [definition, definitionHistoryQuery, deviceId, getFromIso, requestedResolution, selectedRange, timeRange]);

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

  const getFormatterForKey = useCallback((key: string) => {
    return getDefinitionEntity(definition, key)?.display?.formatter;
  }, [definition]);

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
    <Card className='-mx-4 bg-card/85 shadow-sm sm:mx-0'>
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
                onDismiss={onClearCellSelection}
                hoveredTime={sharedHoveredTime}
                selectedTime={sharedSelectedTime}
                onHover={setSharedHoveredTime}
                onSelect={setSharedSelectedTime}
              />
            ) : !definitionCharts ? (
              <ChartSection title='Voltage' data={chartData}
                lines={[{ key: 'totalVoltageVolts', color: '#38bdf8', name: 'Pack Voltage' }]}
                getDecimalsForKey={getDecimalsForKey}
                getUnitForKey={getUnitForKey}
                getFormatterForKey={getFormatterForKey}
                hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                todayXTicks={todayXTicks} />
            ) : null}
            {definitionCharts ? renderDefinitionCharts(definitionCharts, chartData, resolvedResolution, displayMode, sharedHoveredTime, sharedSelectedTime, setSharedHoveredTime, setSharedSelectedTime, todayXTicks, batteryStatusSubtitle, getDecimalsForKey, getUnitForKey, getFormatterForKey) : (
              <>
                <EnergyChartSection data={chartData} resolution={resolvedResolution} displayMode={displayMode}
                  hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                  onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                  todayXTicks={todayXTicks} />
                <StateOfChargeChartSection title='State of Charge' data={chartData}
                  line={{ key: 'stateOfChargePercent', color: '#34d399', name: 'SOC' }}
                  getDecimalsForKey={getDecimalsForKey}
                  getUnitForKey={getUnitForKey}
                  getFormatterForKey={getFormatterForKey}
                  hoveredTime={sharedHoveredTime} selectedTime={sharedSelectedTime}
                  onHover={setSharedHoveredTime} onSelect={setSharedSelectedTime}
                  todayXTicks={todayXTicks}
                  subtitle={batteryStatusSubtitle} />
            <ChartSection title='Cell Voltage Spread' data={chartData}
              lines={[
                { key: 'minCellVoltageVolts', color: '#f87171', name: 'Min Cell' },
                { key: 'maxCellVoltageVolts', color: '#34d399', name: 'Max Cell' },
                { key: 'deltaCellVoltageVolts', color: '#60a5fa', name: 'Delta', dashed: true, secondaryAxis: true },
              ]}
              getDecimalsForKey={getDecimalsForKey}
              getUnitForKey={getUnitForKey}
              getFormatterForKey={getFormatterForKey}
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
              getFormatterForKey={getFormatterForKey}
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

type LineSpec = {
  key: string;
  color: string;
  name: string;
  dashed?: boolean;
  secondaryAxis?: boolean;
};
type ChartInteractionState = {
  activeTooltipIndex?: number;
  activeIndex?: number;
  activeLabel?: string | number;
  activePayload?: ReadonlyArray<{
    payload?: Record<string, unknown>;
  }>;
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
  getFormatterForKey?: (key: string) => string | null | undefined,
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
      dashed: t.dashed,
      secondaryAxis: t.secondaryAxis,
    }));

    const isSocChart = lines.length === 1 && chart.traces?.[0]?.entity === 'state_of_charge';

    if (isSocChart) {
      return (
        <StateOfChargeChartSection
          key={`def-chart-${i}`}
          title={chart.title}
          data={chartData}
          line={lines[0]}
          getDecimalsForKey={getDecimalsForKey ?? (() => 2)}
          getUnitForKey={getUnitForKey ?? (() => '')}
          getFormatterForKey={getFormatterForKey ?? (() => undefined)}
          hoveredTime={hoveredTime}
          selectedTime={selectedTime}
          onHover={onHover}
          onSelect={onSelect}
          todayXTicks={todayXTicks}
          subtitle={batteryStatusSubtitle}
        />
      );
    }

    return (
        <ChartSection
          key={`def-chart-${i}`}
          title={chart.title}
          data={chartData}
          lines={lines}
          getDecimalsForKey={getDecimalsForKey ?? (() => 2)}
          getUnitForKey={getUnitForKey ?? (() => '')}
          getFormatterForKey={getFormatterForKey ?? (() => undefined)}
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
const xTickStyle = { fontSize: 10, fill: 'var(--muted-foreground)', fontWeight: 500 };
const chartHeight = 208;
const chartMargin = { top: 44, right: 0, bottom: 12, left: 0 };
const compactChartMargin = { top: 46, right: 0, bottom: 12, left: 0 };
const chartHeaderGap = 8;
const singleAxisWidth = 48;
const dualAxisWidth = 42;
const compactSingleAxisWidth = 1;
const compactDualAxisWidth = 1;
const cellVoltageDecimals = 3;
const axisLabelShadow = 'drop-shadow(0 1px 2px rgba(5, 8, 15, 0.42))';

type AxisTickRendererProps = {
  x?: number;
  y?: number;
  payload?: {
    value?: string | number;
  };
  formatValue?: (value: string | number) => string;
};

function OverlayAxisLabel({ x, y, value, textAnchor = 'middle' }: {
  x: number;
  y: number;
  value: string;
  textAnchor?: 'start' | 'middle' | 'end';
}) {
  if (value.length === 0) {
    return null;
  }

  return (
    <text
      x={x}
      y={y}
      textAnchor={textAnchor}
      dominantBaseline='middle'
      fill={String(xTickStyle.fill)}
      fontSize={xTickStyle.fontSize}
      fontWeight={xTickStyle.fontWeight}
      fontVariant='tabular-nums'
      stroke='var(--background)'
      strokeOpacity={0.78}
      strokeWidth={3.5}
      strokeLinejoin='round'
      paintOrder='stroke'
      style={{ filter: axisLabelShadow }}
    >
      {value}
    </text>
  );
}

function XAxisOverlayTick({ x = 0, y = 0, payload }: AxisTickRendererProps) {
  return (
    <g>
      <OverlayAxisLabel x={x} y={y - 10} value={String(payload?.value ?? '')} />
    </g>
  );
}

function formatAxisTickPayload(payload: AxisTickRendererProps['payload'], formatValue?: (value: string | number) => string) {
  const rawValue = payload?.value;
  if (rawValue == null) {
    return '';
  }

  return formatValue ? formatValue(rawValue) : String(rawValue);
}

function formatNumericAxisTick(value: string | number, formatter: (value: number) => string) {
  const numericValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numericValue) ? formatter(numericValue) : String(value);
}

function RightYAxisOverlayTick({ x = 0, y = 0, payload, formatValue }: AxisTickRendererProps) {
  return (
    <g>
      <OverlayAxisLabel x={x - 6} y={y} value={formatAxisTickPayload(payload, formatValue)} textAnchor='end' />
    </g>
  );
}

function LeftYAxisOverlayTick({ x = 0, y = 0, payload, formatValue }: AxisTickRendererProps) {
  return (
    <g>
      <OverlayAxisLabel x={x + 6} y={y} value={formatAxisTickPayload(payload, formatValue)} textAnchor='start' />
    </g>
  );
}

function useCompactChartLayout() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const media = window.matchMedia('(max-width: 640px)');
    const update = () => setCompact(media.matches);
    update();

    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return compact;
}

function useChartHeaderLayout(isCompactChart: boolean) {
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const baseTop = isCompactChart ? compactChartMargin.top : chartMargin.top;
  const top = Math.max(baseTop, Math.ceil(headerHeight) + chartHeaderGap);
  const height = chartHeight + Math.max(0, top - baseTop);

  useEffect(() => {
    const element = headerRef.current;
    if (!element) {
      return;
    }

    const update = () => setHeaderHeight(element.getBoundingClientRect().height);
    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { headerRef, top, height };
}

function ChartLegendOverlay({
  lines,
  activePoint,
  getDecimalsForKey,
  getUnitForKey,
  getFormatterForKey,
}: {
  lines: LineSpec[];
  activePoint?: Record<string, unknown> | null;
  getDecimalsForKey?: (key: string) => number;
  getUnitForKey?: (key: string) => string;
  getFormatterForKey?: (key: string) => string | null | undefined;
}) {
  if (lines.length === 0) {
    return null;
  }

  return (
    <div className='flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1.5'>
      {lines.map((line) => (
        <span
          key={line.key}
          className='inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-foreground/85'
          style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.42)' }}
        >
          <span className='h-2 w-2 rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.06)]' style={{ backgroundColor: line.color }} />
          <span>{line.name}</span>
          {activePoint && getDecimalsForKey && getUnitForKey && getFormatterForKey ? (
            <span className='normal-case tracking-normal text-foreground'>
              {formatLegendValue(activePoint, line, getDecimalsForKey, getUnitForKey, getFormatterForKey)}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

function ChartHeaderOverlay({
  headerRef,
  title,
  activeTimeText,
  subtitle,
  meta,
  valueText,
  valueClassName,
  selectedTime,
  onClearSelection,
  action,
}: {
  headerRef?: React.Ref<HTMLDivElement>;
  title: string;
  activeTimeText?: string | null;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  valueText?: React.ReactNode;
  valueClassName?: string;
  selectedTime: string | null;
  onClearSelection: () => void;
  action?: React.ReactNode;
}) {
  const hasRightContent = valueText != null || selectedTime != null;

  return (
    <div ref={headerRef} className='pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-4 bg-gradient-to-b from-background/80 via-background/28 to-transparent px-3 pt-3 pb-3 sm:px-4'>
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2'>
          <div className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1'>
            <div
              className='text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground'
              style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.45)' }}
            >
              {title}
            </div>
            {activeTimeText ? (
              <div
                className='text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground'
                style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.45)' }}
              >
                {activeTimeText}
              </div>
            ) : null}
          </div>
          {meta && <div className='min-w-0'>{meta}</div>}
        </div>
        {subtitle && <div className='mt-1'>{subtitle}</div>}
        {action && <div className='pointer-events-auto mt-2'>{action}</div>}
      </div>
      {hasRightContent ? (
        <div className='pointer-events-auto shrink-0 text-right'>
          {valueText != null && (
            <div className={cn(
              'rounded-full bg-background/55 px-2.5 py-1 text-[11px] font-medium text-foreground shadow-[0_10px_24px_rgba(0,0,0,0.22)] backdrop-blur-[3px]',
              valueClassName,
            )}>
              {valueText}
            </div>
          )}
          {selectedTime != null && (
            <button
              onClick={onClearSelection}
              className='mt-2 rounded-full bg-background/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground shadow-[0_8px_18px_rgba(0,0,0,0.18)] backdrop-blur-[2px] transition-colors hover:text-foreground'
            >
              Show latest
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ChartSection({ title, data, lines, domain, getDecimalsForKey, getUnitForKey, getFormatterForKey, hoveredTime, selectedTime, onHover, onSelect, todayXTicks, subtitle }: {
  title: string; data: ChartDataPoint[]; lines: LineSpec[];
  domain?: [number, number];
  getDecimalsForKey: (key: string) => number;
  getUnitForKey: (key: string) => string;
  getFormatterForKey: (key: string) => string | null | undefined;
  hoveredTime: string | null; selectedTime: string | null;
  onHover: (time: string | null) => void; onSelect: (time: string | null) => void;
  todayXTicks?: string[];
  subtitle?: React.ReactNode;
}) {
  const isCompactChart = useCompactChartLayout();
  const chartHeader = useChartHeaderLayout(isCompactChart);
  const activeChartMargin = { ...(isCompactChart ? compactChartMargin : chartMargin), top: chartHeader.top };
  const activeSingleAxisWidth = isCompactChart ? compactSingleAxisWidth : singleAxisWidth;
  const activeDualAxisWidth = isCompactChart ? compactDualAxisWidth : dualAxisWidth;
  const activePoint = getActivePoint(data, hoveredTime, selectedTime, lines.map((line) => line.key));
  const interactionX = getInteractionX(data, hoveredTime, selectedTime);
  const hasSecondaryAxis = lines.some((line) => line.secondaryAxis);
  const activeTimeText = formatActiveTime(activePoint);
  const primaryAxisLine = lines.find((line) => !line.secondaryAxis) ?? lines[0];
  const secondaryAxisLine = lines.find((line) => line.secondaryAxis);
  const primaryTickFormatter = useCallback((value: number) => (
    primaryAxisLine ? formatChartValue(value, primaryAxisLine.key, getDecimalsForKey, getUnitForKey, getFormatterForKey) : String(value)
  ), [getDecimalsForKey, getFormatterForKey, getUnitForKey, primaryAxisLine]);
  const secondaryTickFormatter = useCallback((value: number) => (
    secondaryAxisLine ? formatChartValue(value, secondaryAxisLine.key, getDecimalsForKey, getUnitForKey, getFormatterForKey) : String(value)
  ), [getDecimalsForKey, getFormatterForKey, getUnitForKey, secondaryAxisLine]);
  const handleChartMove = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, data);
    if (timestamp != null) {
      onHover(timestamp);
    } else {
      onHover(null);
    }
  }, [data, onHover]);

  const handleChartLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleChartClick = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, data);
    if (timestamp != null) {
      onSelect(timestamp);
    } else {
      onSelect(null);
    }
  }, [data, onSelect]);

  return (
    <div className='relative overflow-hidden'>
      <ChartHeaderOverlay
        headerRef={chartHeader.headerRef}
        title={title}
        activeTimeText={activeTimeText}
        subtitle={subtitle}
        meta={<ChartLegendOverlay
          lines={lines}
          activePoint={activePoint}
          getDecimalsForKey={getDecimalsForKey}
          getUnitForKey={getUnitForKey}
          getFormatterForKey={getFormatterForKey}
        />}
        valueText={undefined}
        selectedTime={selectedTime}
        onClearSelection={() => onSelect(null)}
      />
      <ResponsiveContainer width='100%' height={chartHeader.height}>
        <LineChart
          data={data}
          margin={activeChartMargin}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' opacity={0.4} />
          <XAxis
            dataKey='time'
            height={20}
            mirror
            tick={<XAxisOverlayTick />}
            tickLine={false}
            axisLine={false}
            {...(todayXTicks ? { ticks: todayXTicks } : {})}
          />
          {hasSecondaryAxis ? (
            <>
              <YAxis
                yAxisId='primary'
                orientation='left'
                width={activeDualAxisWidth}
                mirror
                tick={<LeftYAxisOverlayTick formatValue={(value) => formatNumericAxisTick(value, primaryTickFormatter)} />}
                tickLine={false}
                axisLine={false}
                domain={domain ?? ['auto', 'auto']}
                tickFormatter={primaryTickFormatter}
              />
              <YAxis
                yAxisId='secondary'
                orientation='right'
                width={activeDualAxisWidth}
                mirror
                tick={<RightYAxisOverlayTick formatValue={(value) => formatNumericAxisTick(value, secondaryTickFormatter)} />}
                tickLine={false}
                axisLine={false}
                domain={['auto', 'auto']}
                tickFormatter={secondaryTickFormatter}
              />
            </>
          ) : (
            <YAxis
              yAxisId='primary'
              orientation='right'
              width={activeSingleAxisWidth}
              mirror
              tick={<RightYAxisOverlayTick formatValue={(value) => formatNumericAxisTick(value, primaryTickFormatter)} />}
              tickLine={false}
              axisLine={false}
              domain={domain ?? ['auto', 'auto']}
              tickFormatter={primaryTickFormatter}
            />
          )}
          {lines.map((l) => (
            <Line
              key={l.key}
              type='monotone'
              dataKey={l.key}
              yAxisId={l.secondaryAxis ? 'secondary' : 'primary'}
              stroke={l.color}
              name={l.name}
              dot={false}
              strokeWidth={1.5}
              strokeDasharray={l.dashed ? '4 4' : undefined}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          {renderInteractionReferenceLine(interactionX, 'primary')}
          {renderActiveReferenceDots(activePoint, lines, (line) => line.secondaryAxis ? 'secondary' : 'primary')}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function StateOfChargeChartSection({ title, data, line, getDecimalsForKey, getUnitForKey, getFormatterForKey, hoveredTime, selectedTime, onHover, onSelect, todayXTicks, subtitle }: {
  title: string;
  data: ChartDataPoint[];
  line: LineSpec;
  getDecimalsForKey: (key: string) => number;
  getUnitForKey: (key: string) => string;
  getFormatterForKey: (key: string) => string | null | undefined;
  hoveredTime: string | null;
  selectedTime: string | null;
  onHover: (time: string | null) => void;
  onSelect: (time: string | null) => void;
  todayXTicks?: string[];
  subtitle?: React.ReactNode;
}) {
  const gradientId = useId().replace(/:/g, '');
  const isCompactChart = useCompactChartLayout();
  const chartHeader = useChartHeaderLayout(isCompactChart);
  const activeChartMargin = { ...(isCompactChart ? compactChartMargin : chartMargin), top: chartHeader.top };
  const activeSingleAxisWidth = isCompactChart ? compactSingleAxisWidth : singleAxisWidth;
  const activePoint = getActivePoint(data, hoveredTime, selectedTime, [line.key]);
  const interactionX = getInteractionX(data, hoveredTime, selectedTime);
  const activeTimeText = formatActiveTime(activePoint);

  const handleChartMove = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, data);
    if (timestamp != null) {
      onHover(timestamp);
    } else {
      onHover(null);
    }
  }, [data, onHover]);

  const handleChartLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleChartClick = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, data);
    if (timestamp != null) {
      onSelect(timestamp);
    } else {
      onSelect(null);
    }
  }, [data, onSelect]);

  return (
    <div className='relative overflow-hidden'>
      <ChartHeaderOverlay
        headerRef={chartHeader.headerRef}
        title={title}
        activeTimeText={activeTimeText}
        subtitle={subtitle}
        meta={<ChartLegendOverlay
          lines={[line]}
          activePoint={activePoint}
          getDecimalsForKey={getDecimalsForKey}
          getUnitForKey={getUnitForKey}
          getFormatterForKey={getFormatterForKey}
        />}
        valueText={undefined}
        selectedTime={selectedTime}
        onClearSelection={() => onSelect(null)}
      />
      <ResponsiveContainer width='100%' height={chartHeader.height}>
        <AreaChart
          data={data}
          margin={activeChartMargin}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <defs>
            <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
              <stop offset='0%' stopColor={line.color} stopOpacity={0.32} />
              <stop offset='100%' stopColor={line.color} stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' opacity={0.4} />
          <XAxis
            dataKey='time'
            height={20}
            mirror
            tick={<XAxisOverlayTick />}
            tickLine={false}
            axisLine={false}
            {...(todayXTicks ? { ticks: todayXTicks } : {})}
          />
          <YAxis
            orientation='right'
            width={activeSingleAxisWidth}
            mirror
            tick={<RightYAxisOverlayTick />}
            tickLine={false}
            axisLine={false}
            domain={[0, 100]}
          />
          <Area
            type='monotone'
            dataKey={line.key}
            stroke={line.color}
            fill={`url(#${gradientId})`}
            name={line.name}
            dot={false}
            strokeWidth={1.75}
            connectNulls
            isAnimationActive={false}
          />
          {renderInteractionReferenceLine(interactionX)}
          {renderActiveReferenceDots(activePoint, [line])}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function buildEnergyPowerAxisScale(data: Record<string, unknown>[]) {
  const values = data
    .map((point) => point.signedPowerKw)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const dataMin = values.length > 0 ? Math.min(...values) : 0;
  const dataMax = values.length > 0 ? Math.max(...values) : 0;
  const rawMin = Math.min(dataMin, 0);
  const rawMax = Math.max(dataMax, 0);
  const maxAbs = Math.max(Math.abs(rawMin), Math.abs(rawMax));
  const useWatts = maxAbs < 1;
  const minimumStep = useWatts ? 0.05 : 0.1;
  const targetIntervals = 5;
  const rawSpan = rawMax - rawMin;
  const step = Math.max(
    minimumStep,
    Math.ceil((rawSpan || minimumStep) / targetIntervals / minimumStep) * minimumStep,
  );
  let domainMin = Math.floor((rawMin + Number.EPSILON) / step) * step;
  let domainMax = Math.ceil((rawMax - Number.EPSILON) / step) * step;

  if (domainMin === domainMax) {
    domainMin -= step;
    domainMax += step;
  }

  const precision = useWatts ? 3 : 1;
  const normalize = (value: number) => Number(value.toFixed(precision));
  const ticks: number[] = [];
  for (let tick = domainMin; tick <= domainMax + step / 2; tick += step) {
    ticks.push(normalize(tick));
  }

  const formatTick = (value: string | number) => {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      return String(value);
    }

    const absValue = Math.abs(numericValue);
    if (useWatts) {
      return String(Math.round(absValue * 1000 / 50) * 50);
    }

    return absValue.toFixed(1);
  };

  return {
    domain: [normalize(domainMin), normalize(domainMax)] as [number, number],
    ticks,
    formatTick,
  };
}

export function EnergyChartSection({ data, resolution, displayMode, hoveredTime, selectedTime, onHover, onSelect, todayXTicks }: {
  data: Record<string, unknown>[]; resolution: Resolution; displayMode: HistoryDisplayMode;
  hoveredTime: string | null; selectedTime: string | null;
  onHover: (time: string | null) => void; onSelect: (time: string | null) => void;
  todayXTicks?: string[];
}) {
  const { energyData, dischargedKwh, chargedKwh, zeroOffset } = useMemo(
    () => computeEnergyData(data, resolution),
    [data, resolution],
  );
  const energyPowerAxisScale = useMemo(() => buildEnergyPowerAxisScale(energyData), [energyData]);

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

  const isCompactChart = useCompactChartLayout();
  const chartHeader = useChartHeaderLayout(isCompactChart);
  const activeChartMargin = { ...(isCompactChart ? compactChartMargin : chartMargin), top: chartHeader.top };
  const activeSingleAxisWidth = isCompactChart ? compactSingleAxisWidth : singleAxisWidth;
  const activePoint = getActivePoint(energyData, hoveredTime, selectedTime, ['displayPowerKw', 'signedPowerKw']);
  const interactionX = getInteractionX(energyData, hoveredTime, selectedTime);
  const activeTimeText = formatActiveTime(activePoint);
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
    const timestamp = extractActiveTimestamp(state, energyData);
    if (timestamp != null) {
      onHover(timestamp);
    } else {
      onHover(null);
    }
  }, [energyData, onHover]);
  const handleChartLeave = useCallback(() => { onHover(null); }, [onHover]);
  const handleChartClick = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, energyData);
    if (timestamp != null) {
      onSelect(timestamp);
    } else {
      onSelect(null);
    }
  }, [energyData, onSelect]);

  // Show absolute values on Y-axis (no negatives).
  const yTickFormatter = useCallback((v: number) => energyPowerAxisScale.formatTick(v), [energyPowerAxisScale]);
  const powerLegend = activeEnergyText ? (
    <span
      data-testid='energy-power-legend'
      className='inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-foreground/85'
      style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.42)' }}
    >
      <span className='h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_0_1px_rgba(255,255,255,0.06)]' />
      <span>Power</span>
      <span className='normal-case tracking-normal text-foreground'>{activeEnergyText}</span>
    </span>
  ) : null;

  const energyTotalsLegend = (
    <div data-testid='energy-totals-legend' className='flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1.5'>
      <span className='flex items-center gap-1 text-xs text-emerald-400' style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.38)' }}>
        <span className='text-[10px]'>↑</span> Charged: <span className='font-semibold'>{chargedKwh.toFixed(1)} kWh</span>
      </span>
      <span className='flex items-center gap-1 text-xs text-rose-400' style={{ textShadow: '0 1px 2px rgba(0, 0, 0, 0.38)' }}>
        <span className='text-[10px]'>↓</span> Discharged: <span className='font-semibold'>{dischargedKwh.toFixed(1)} kWh</span>
      </span>
    </div>
  );

  return (
    <div className='relative overflow-hidden'>
      <ChartHeaderOverlay
        headerRef={chartHeader.headerRef}
        title='Energy'
        activeTimeText={activeTimeText}
        meta={powerLegend}
        subtitle={energyTotalsLegend}
        valueText={undefined}
        selectedTime={selectedTime}
        onClearSelection={() => onSelect(null)}
      />
      <ResponsiveContainer width='100%' height={chartHeader.height}>
        <AreaChart
          data={energyData}
          margin={activeChartMargin}
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
          <XAxis
            dataKey='time'
            height={20}
            mirror
            tick={<XAxisOverlayTick />}
            tickLine={false}
            axisLine={false}
            {...(todayXTicks ? { ticks: todayXTicks } : {})}
          />
          <YAxis
            orientation='right'
            width={activeSingleAxisWidth}
            mirror
            tick={<RightYAxisOverlayTick formatValue={energyPowerAxisScale.formatTick} />}
            tickLine={false}
            axisLine={false}
            domain={energyPowerAxisScale.domain}
            ticks={energyPowerAxisScale.ticks}
            tickFormatter={yTickFormatter}
          />
          {baselineMarkers.map(({ time, isMajor }, i) => (
            <ReferenceDot key={`bm-${i}`} x={time} y={0} r={isMajor ? 3 : 1.5} fill={isMajor ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.2)'} stroke='none' />
          ))}
          <Area type='monotone' dataKey='signedPowerKw' stroke='url(#energyStrokeGradient)' fill='url(#energyGradient)' strokeWidth={1.5} dot={false} isAnimationActive={false} baseValue={0} />
          {renderInteractionReferenceLine(interactionX)}
          {renderActiveReferenceDots(activePoint, [{ key: 'signedPowerKw', color: '#38bdf8', name: 'Power' }])}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MultiCellChartSection({ selectedCells, data, onDismiss, hoveredTime, selectedTime, onHover, onSelect }: {
  selectedCells: number[]; data: Record<string, unknown>[]; onDismiss?: () => void;
  hoveredTime: string | null; selectedTime: string | null;
  onHover: (time: string | null) => void; onSelect: (time: string | null) => void;
}) {
  const cellLines = selectedCells.map((idx, i) => ({
    key: `cell_${idx}`,
    color: cellColorPalette[i % cellColorPalette.length],
    name: `Cell ${idx}`,
  }));

  const isCompactChart = useCompactChartLayout();
  const chartHeader = useChartHeaderLayout(isCompactChart);
  const activeChartMargin = { ...(isCompactChart ? compactChartMargin : chartMargin), top: chartHeader.top };
  const activeSingleAxisWidth = isCompactChart ? compactSingleAxisWidth : singleAxisWidth;
  const activePoint = getActivePoint(data, hoveredTime, selectedTime, cellLines.map((line) => line.key));
  const interactionX = getInteractionX(data, hoveredTime, selectedTime);
  const activeTimeText = formatActiveTime(activePoint);

  const yTickFormatter = useCallback((value: number) => formatWithUnit(value.toFixed(cellVoltageDecimals), 'V'), []);

  const handleChartMove = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, data);
    if (timestamp != null) {
      onHover(timestamp);
    } else {
      onHover(null);
    }
  }, [data, onHover]);
  const handleChartLeave = useCallback(() => { onHover(null); }, [onHover]);
  const handleChartClick = useCallback((state: unknown) => {
    const timestamp = extractActiveTimestamp(state, data);
    if (timestamp != null) {
      onSelect(timestamp);
    } else {
      onSelect(null);
    }
  }, [data, onSelect]);

  return (
    <div className='relative overflow-hidden'>
      <ChartHeaderOverlay
        headerRef={chartHeader.headerRef}
        title={`Cell Voltage${selectedCells.length > 1 ? 's' : ''}`}
        activeTimeText={activeTimeText}
        meta={<ChartLegendOverlay
          lines={cellLines}
          activePoint={activePoint}
          getDecimalsForKey={() => cellVoltageDecimals}
          getUnitForKey={() => 'V'}
          getFormatterForKey={() => undefined}
        />}
        valueText={undefined}
        selectedTime={selectedTime}
        onClearSelection={() => onSelect(null)}
        action={onDismiss ? (
          <button
            onClick={onDismiss}
            className='rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground transition-colors hover:text-foreground'
          >
            ✕ Show Pack
          </button>
        ) : null}
      />
      <ResponsiveContainer width='100%' height={chartHeader.height}>
        <LineChart
          data={data}
          margin={activeChartMargin}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' opacity={0.4} />
          <XAxis dataKey='time' height={20} mirror tick={<XAxisOverlayTick />} tickLine={false} axisLine={false} />
          <YAxis orientation='right' width={activeSingleAxisWidth} mirror tick={<RightYAxisOverlayTick formatValue={(value) => formatNumericAxisTick(value, yTickFormatter)} />} tickLine={false} axisLine={false} domain={['auto', 'auto']} tickFormatter={yTickFormatter} />
          {cellLines.map((l) => (
            <Line key={l.key} type='monotone' dataKey={l.key} stroke={l.color} name={l.name} dot={false} strokeWidth={1.5} connectNulls isAnimationActive={false} />
          ))}
          {renderInteractionReferenceLine(interactionX)}
          {renderActiveReferenceDots(activePoint, cellLines)}
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

function extractActiveTimestamp(state: unknown, data: Record<string, unknown>[]): string | null {
  if (typeof state !== 'object' || state == null) {
    return null;
  }

  const chartState = state as ChartInteractionState;
  const candidate = chartState.activeTooltipIndex ?? chartState.activeIndex;
  if (typeof candidate === 'number' && Number.isFinite(candidate) && data[candidate]) {
    return getPointTimestamp(data[candidate]);
  }

  const payloadTimestamp = getPointTimestamp(chartState.activePayload?.[0]?.payload ?? null);
  if (payloadTimestamp != null) {
    return payloadTimestamp;
  }

  const activeLabel = chartState.activeLabel;
  if (activeLabel != null) {
    const label = String(activeLabel);
    const labelPoint = data.find((point) => String(point.time ?? '') === label);
    return getPointTimestamp(labelPoint ?? null);
  }

  return null;
}

function getPointTimestamp(point: Record<string, unknown> | null | undefined): string | null {
  const timestamp = point?.timestamp;
  return typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : null;
}

function formatActiveTime(point: Record<string, unknown> | null): string | null {
  if (!point) {
    return null;
  }

  const time = point.time;
  if (time != null) {
    return String(time);
  }

  const timestamp = getPointTimestamp(point);
  if (!timestamp) {
    return null;
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

function getActivePoint(data: Record<string, unknown>[], hoveredTime: string | null, selectedTime: string | null, keys?: string[]) {
  const candidateKeys = resolveCandidateKeys(data, keys);
  const ts = hoveredTime ?? selectedTime;
  if (ts != null) {
    const exact = data.find(p => p.timestamp === ts) ?? null;
    if (exact && hasAnyValue(exact, candidateKeys)) {
      return exact;
    }

    const cutoff = exact ? getPointTimeMs(exact) : Date.parse(ts);
    return findLatestPointWithValues(data, candidateKeys, Number.isNaN(cutoff) ? null : cutoff)
      ?? findLatestPointWithValues(data, candidateKeys)
      ?? exact;
  }

  // Find the last point that has actual data (not just padding with time/timestamp).
  return findLatestPointWithValues(data, candidateKeys);
}

function resolveCandidateKeys(data: Record<string, unknown>[], keys?: string[]) {
  if (keys && keys.length > 0) {
    return keys;
  }

  const lastPoint = data.at(-1);
  return lastPoint
    ? Object.keys(lastPoint).filter(k => k !== 'time' && k !== 'timestamp')
    : [];
}

function findLatestPointWithValues(data: Record<string, unknown>[], keys: string[], latestAt?: number | null) {
  for (let i = data.length - 1; i >= 0; i--) {
    const p = data[i];
    const pointTime = getPointTimeMs(p);
    if (latestAt != null && pointTime != null && pointTime > latestAt) {
      continue;
    }

    if (hasAnyValue(p, keys)) {
      return p;
    }
  }

  return null;
}

function hasAnyValue(point: Record<string, unknown>, keys: string[]) {
  return keys.some(key => point[key] != null);
}

function getPointTimeMs(point: Record<string, unknown>) {
  const timestamp = getPointTimestamp(point);
  if (!timestamp) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function getInteractionX(data: Record<string, unknown>[], hoveredTime: string | null, selectedTime: string | null): string | null {
  const timestamp = hoveredTime ?? selectedTime;
  if (!timestamp) {
    return null;
  }

  const point = data.find(p => p.timestamp === timestamp);
  const time = point?.time;
  return time != null ? String(time) : null;
}

function renderInteractionReferenceLine(x: string | null, yAxisId?: string) {
  if (!x) {
    return null;
  }

  return (
    <ReferenceLine
      x={x}
      yAxisId={yAxisId}
      stroke='var(--foreground)'
      strokeOpacity={0.55}
      strokeWidth={1.35}
      ifOverflow='extendDomain'
    />
  );
}

function renderActiveReferenceDots(
  activePoint: Record<string, unknown> | null,
  lines: LineSpec[],
  getYAxisId?: (line: LineSpec) => string,
) {
  if (!activePoint) {
    return null;
  }

  const x = activePoint.time;
  if (x == null) {
    return null;
  }

  return lines.map((line) => {
    const raw = activePoint[line.key];
    if (raw == null) {
      return null;
    }

    const y = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isNaN(y)) {
      return null;
    }

    return (
      <ReferenceDot
        key={`active-dot-${line.key}`}
        x={String(x)}
        y={y}
        yAxisId={getYAxisId?.(line)}
        r={5}
        fill={line.color}
        stroke='var(--background)'
        strokeWidth={2.25}
      />
    );
  });
}
