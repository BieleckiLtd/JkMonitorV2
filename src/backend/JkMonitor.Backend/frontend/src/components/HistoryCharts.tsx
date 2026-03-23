import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, ReferenceLine,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { cn } from '../lib/utils';
import { Clock, TrendingUp } from 'lucide-react';

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

type Resolution = '1s' | '1m' | '5m' | '1h';

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
  { value: '1s', label: '1s', hint: 'Last 10 min' },
  { value: '1m', label: '1m', hint: 'Last hour' },
  { value: '5m', label: '5m', hint: 'Last 24h' },
  { value: '1h', label: '1h', hint: 'Last 7d' },
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

function getIntervalHours(resolution: Resolution): number {
  switch (resolution) {
    case '1s': return 1 / 3600;
    case '1m': return 1 / 60;
    case '5m': return 5 / 60;
    case '1h': return 1;
  }
}

export function HistoryCharts({ deviceId, precision, selectedCellIndices, onClearCellSelection }: {
  deviceId: string; precision: DisplayPrecision; selectedCellIndices?: number[]; onClearCellSelection?: () => void;
}) {
  const [resolution, setResolution] = useState<Resolution>('1m');
  const [data, setData] = useState<HistoryPoint[]>([]);
  const [multiCellData, setMultiCellData] = useState<Record<string, unknown>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<'default' | 'today'>('default');

  const selectedCells = selectedCellIndices ?? [];
  const cellKey = selectedCells.join(',');

  const fromParam = useMemo(() => {
    if (timeRange !== 'today') return '';
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return `&from=${midnight.toISOString()}`;
  }, [timeRange]);

  const load = useCallback(async () => {
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/history?resolution=${resolution}${fromParam}`);
      if (!resp.ok) return;
      const json = (await resp.json()) as HistoryResponse;
      setData(json.points);
    } catch { /* ignore */ }
    finally { setIsLoading(false); }
  }, [deviceId, resolution, fromParam]);

  const loadCells = useCallback(async () => {
    if (selectedCells.length === 0) { setMultiCellData([]); return; }
    try {
      const results = await Promise.all(
        selectedCells.map(async (idx) => {
          const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/history/cell/${idx}?resolution=${resolution}${fromParam}`);
          if (!resp.ok) return null;
          const json = (await resp.json()) as CellHistoryResponse;
          return { index: idx, points: json.points };
        })
      );
      const timeMap = new Map<string, Record<string, unknown>>();
      for (const result of results) {
        if (!result) continue;
        for (const point of result.points) {
          if (!timeMap.has(point.timestamp)) {
            timeMap.set(point.timestamp, { timestamp: point.timestamp, time: fmtTime(point.timestamp, resolution) });
          }
          timeMap.get(point.timestamp)![`cell_${result.index}`] = point.voltageVolts;
        }
      }
      setMultiCellData([...timeMap.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))));
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, resolution, cellKey, fromParam]);

  useEffect(() => {
    setIsLoading(true);
    void load();
    void loadCells();
    const id = window.setInterval(() => { void load(); void loadCells(); }, resolution === '1s' ? 5000 : 30000);
    return () => window.clearInterval(id);
  }, [load, loadCells, resolution]);

  const formatted = data.map((p) => ({
    ...p,
    time: fmtTime(p.timestamp, resolution),
  }));

  const handleTodayClick = () => {
    if (timeRange === 'today') {
      setTimeRange('default');
    } else {
      setTimeRange('today');
      if (resolution === '1s') setResolution('1m');
    }
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
            <Clock className='mr-1 h-3.5 w-3.5 text-muted-foreground' />
            {resolutions.map((r) => (
              <button
                key={r.value}
                onClick={() => setResolution(r.value)}
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
      <CardContent className='px-2 pt-4 space-y-6 sm:px-4'>
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
              />
            ) : (
              <ChartSection title='Voltage' unit='V' data={formatted} precision={precision}
                lines={[{ key: 'totalVoltageVolts', color: '#38bdf8', name: 'Pack Voltage' }]} />
            )}
            <EnergyChartSection data={formatted} resolution={resolution} />
            <ChartSection title='State of Charge' unit='%' data={formatted} precision={precision}
              lines={[{ key: 'stateOfChargePercent', color: '#fbbf24', name: 'SOC' }]}
              domain={[0, 100]} />
            <ChartSection title='Cell Voltage Spread' unit='V' data={formatted} precision={precision}
              lines={[
                { key: 'minCellVoltageVolts', color: '#f87171', name: 'Min Cell' },
                { key: 'maxCellVoltageVolts', color: '#34d399', name: 'Max Cell' },
              ]} />
            <ChartSection title='Temperature' unit='°C' data={formatted} precision={precision}
              lines={[
                { key: 'mosTemperatureCelsius', color: '#fb923c', name: 'MOS' },
                { key: 'batteryTemperatureCelsius', color: '#38bdf8', name: 'Battery' },
              ]} />
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

function ChartSection({ title, data, lines, domain, precision }: {
  title: string; unit: string; data: Record<string, unknown>[]; lines: LineSpec[];
  domain?: [number, number]; precision: DisplayPrecision;
}) {
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  // Build a formatter that rounds tooltip values based on precision config.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tooltipFormatter: any = useCallback((value: unknown, name: string, props: { dataKey?: string | number }) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) return [String(value), name];
    const key = String(props.dataKey ?? '');
    const precKey = keyPrecisionMap[key];
    const decimals = precKey != null ? precision[precKey] : 2;
    return [num.toFixed(decimals), name];
  }, [precision]);

  const activePoint = getActivePoint(data, hoveredPointIndex, selectedPointIndex);
  const activeTime = activePoint != null ? formatSummaryTime(activePoint.timestamp) : null;
  const isPinned = hoveredPointIndex == null && selectedPointIndex != null;

  const handleChartMove = useCallback((state: unknown) => {
    const activeIndex = extractActiveIndex(state);
    setHoveredPointIndex(activeIndex);
  }, []);

  const handleChartLeave = useCallback(() => {
    setHoveredPointIndex(null);
  }, []);

  const handleChartClick = useCallback((state: unknown) => {
    setSelectedPointIndex(extractActiveIndex(state));
  }, []);

  return (
    <div>
      <div className='mb-2 flex items-start justify-between gap-3'>
        <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>{title}</div>
        <div className='max-w-[60%] text-right'>
          <div className='text-[11px] font-medium text-foreground'>
            {activeTime ?? 'No data'}
            {isPinned && <span className='ml-2 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground'>Pinned</span>}
          </div>
          <div className='mt-1 flex flex-wrap justify-end gap-1.5'>
            {lines.map((line) => {
              const rawValue = activePoint?.[line.key];
              const formattedValue = formatLineSummaryValue(rawValue, line.key, precision);

              return (
                <span
                  key={line.key}
                  className='rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] font-medium text-foreground'
                >
                  <span className='mr-1 inline-block h-2 w-2 rounded-full align-middle' style={{ backgroundColor: line.color }} />
                  {line.name}: {formattedValue}
                </span>
              );
            })}
          </div>
          {selectedPointIndex != null && (
            <button
              onClick={() => setSelectedPointIndex(null)}
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
          margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' opacity={0.4} />
          <XAxis dataKey='time' tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} domain={domain ?? ['auto', 'auto']} />
          <Tooltip
            contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '0.5rem', fontSize: 12 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={tooltipFormatter}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
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

function EnergyChartSection({ data, resolution }: {
  data: Record<string, unknown>[]; resolution: Resolution;
}) {
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

  const { energyData, dischargedKwh, chargedKwh, zeroOffset } = useMemo(() => {
    const intervalHours = getIntervalHours(resolution);
    let discharged = 0, charged = 0;
    let dMax = 0, dMin = 0;

    const processed = data.map(p => {
      const power = typeof p.powerWatts === 'number' ? p.powerWatts : null;
      const current = typeof p.currentAmps === 'number' ? p.currentAmps : null;
      if (power == null || current == null) return { ...p, signedPowerKw: null };
      const signedKw = current >= 0 ? power / 1000 : -power / 1000;
      if (signedKw > dMax) dMax = signedKw;
      if (signedKw < dMin) dMin = signedKw;
      if (current >= 0) discharged += power * intervalHours;
      else charged += power * intervalHours;
      return { ...p, signedPowerKw: signedKw };
    });

    const range = dMax - dMin || 1;
    return {
      energyData: processed,
      dischargedKwh: discharged / 1000,
      chargedKwh: charged / 1000,
      zeroOffset: Math.max(0, Math.min(1, dMax / range)),
    };
  }, [data, resolution]);

  const activePoint = getActivePoint(energyData, hoveredPointIndex, selectedPointIndex);
  const activeTime = activePoint != null ? formatSummaryTime(activePoint.timestamp) : null;
  const isPinned = hoveredPointIndex == null && selectedPointIndex != null;
  const activeKw = typeof activePoint?.signedPowerKw === 'number' ? activePoint.signedPowerKw : null;
  const formattedKw = activeKw != null ? activeKw.toFixed(2) : 'N/D';

  const handleChartMove = useCallback((state: unknown) => { setHoveredPointIndex(extractActiveIndex(state)); }, []);
  const handleChartLeave = useCallback(() => { setHoveredPointIndex(null); }, []);
  const handleChartClick = useCallback((state: unknown) => { setSelectedPointIndex(extractActiveIndex(state)); }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tooltipFormatter: any = useCallback((value: unknown) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(num)) return [String(value), 'Power'];
    return [`${num.toFixed(2)} kW`, num >= 0 ? 'Discharge' : 'Charge'];
  }, []);

  return (
    <div>
      <div className='mb-2 flex items-start justify-between gap-3'>
        <div>
          <div className='text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>Energy</div>
          <div className='mt-1.5 flex flex-wrap gap-x-3 gap-y-1'>
            <span className='flex items-center gap-1 text-xs text-emerald-400'>
              <span className='text-[10px]'>↑</span> Discharged: <span className='font-semibold'>{dischargedKwh.toFixed(1)} kWh</span>
            </span>
            <span className='flex items-center gap-1 text-xs text-sky-400'>
              <span className='text-[10px]'>↓</span> Charged: <span className='font-semibold'>{chargedKwh.toFixed(1)} kWh</span>
            </span>
          </div>
        </div>
        <div className='max-w-[40%] text-right'>
          <div className='text-[11px] font-medium text-foreground'>
            {activeTime ?? 'No data'}
            {isPinned && <span className='ml-2 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground'>Pinned</span>}
          </div>
          <div className='mt-1'>
            <span className='rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] font-medium text-foreground'>
              <span className='mr-1 inline-block h-2 w-2 rounded-full align-middle' style={{ backgroundColor: '#34d399' }} />
              {formattedKw} kW
            </span>
          </div>
          {selectedPointIndex != null && (
            <button
              onClick={() => setSelectedPointIndex(null)}
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
          margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <defs>
            <linearGradient id='energyGradient' x1='0' y1='0' x2='0' y2='1'>
              <stop offset='0%' stopColor='#34d399' stopOpacity={0.5} />
              <stop offset={`${zeroOffset * 100}%`} stopColor='#34d399' stopOpacity={0.03} />
              <stop offset={`${zeroOffset * 100}%`} stopColor='#34d399' stopOpacity={0.03} />
              <stop offset='100%' stopColor='#34d399' stopOpacity={0.5} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' opacity={0.4} />
          <XAxis dataKey='time' tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
          <Tooltip
            contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '0.5rem', fontSize: 12 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={tooltipFormatter}
          />
          <ReferenceLine y={0} stroke='hsl(var(--muted-foreground))' strokeOpacity={0.5} strokeDasharray='3 3' />
          <Area type='monotone' dataKey='signedPowerKw' stroke='#34d399' fill='url(#energyGradient)' strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} baseValue={0} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function MultiCellChartSection({ selectedCells, data, precision, onDismiss }: {
  selectedCells: number[]; data: Record<string, unknown>[]; precision: DisplayPrecision; onDismiss?: () => void;
}) {
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null);
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);

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

  const activePoint = getActivePoint(data, hoveredPointIndex, selectedPointIndex);
  const activeTime = activePoint != null ? formatSummaryTime(activePoint.timestamp) : null;
  const isPinned = hoveredPointIndex == null && selectedPointIndex != null;

  const handleChartMove = useCallback((state: unknown) => { setHoveredPointIndex(extractActiveIndex(state)); }, []);
  const handleChartLeave = useCallback(() => { setHoveredPointIndex(null); }, []);
  const handleChartClick = useCallback((state: unknown) => { setSelectedPointIndex(extractActiveIndex(state)); }, []);

  return (
    <div>
      <div className='mb-2 flex items-start justify-between gap-3'>
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
        <div className='max-w-[60%] text-right'>
          <div className='text-[11px] font-medium text-foreground'>
            {activeTime ?? 'No data'}
            {isPinned && <span className='ml-2 rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground'>Pinned</span>}
          </div>
          <div className='mt-1 flex flex-wrap justify-end gap-1.5'>
            {cellLines.map((line) => {
              const rawValue = activePoint?.[line.key];
              const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
              const formatted = Number.isNaN(num) ? 'N/D' : `${num.toFixed(precision.cellVoltage)}V`;
              return (
                <span key={line.key} className='rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] font-medium text-foreground'>
                  <span className='mr-1 inline-block h-2 w-2 rounded-full align-middle' style={{ backgroundColor: line.color }} />
                  {line.name}: {formatted}
                </span>
              );
            })}
          </div>
          {selectedPointIndex != null && (
            <button
              onClick={() => setSelectedPointIndex(null)}
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
          margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
          onMouseMove={handleChartMove}
          onMouseLeave={handleChartLeave}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' opacity={0.4} />
          <XAxis dataKey='time' tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
          <Tooltip
            contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '0.5rem', fontSize: 12 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={tooltipFormatter}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
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
  if (resolution === '5m') {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
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

function getActivePoint(data: Record<string, unknown>[], hoveredPointIndex: number | null, selectedPointIndex: number | null) {
  if (hoveredPointIndex != null) {
    return data[hoveredPointIndex] ?? null;
  }

  if (selectedPointIndex != null) {
    return data[selectedPointIndex] ?? null;
  }

  return data.at(-1) ?? null;
}

function formatLineSummaryValue(value: unknown, key: string, precision: DisplayPrecision) {
  const num = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(num)) {
    return 'N/D';
  }

  const precisionKey = keyPrecisionMap[key];
  const decimals = precisionKey != null ? precision[precisionKey] : 2;
  return num.toFixed(decimals);
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
