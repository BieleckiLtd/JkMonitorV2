import { useCallback, useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, Legend,
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

type HistoryResponse = {
  deviceId: string;
  resolution: string;
  from: string;
  to: string;
  points: HistoryPoint[];
};

type Resolution = '1s' | '1m' | '5m' | '1h';

const resolutions: { value: Resolution; label: string; hint: string }[] = [
  { value: '1s', label: '1s', hint: 'Last 10 min' },
  { value: '1m', label: '1m', hint: 'Last hour' },
  { value: '5m', label: '5m', hint: 'Last 24h' },
  { value: '1h', label: '1h', hint: 'Last 7d' },
];

export function HistoryCharts({ deviceId }: { deviceId: string }) {
  const [resolution, setResolution] = useState<Resolution>('1m');
  const [data, setData] = useState<HistoryPoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const resp = await fetch(`/api/devices/${encodeURIComponent(deviceId)}/history?resolution=${resolution}`);
      if (!resp.ok) return;
      const json = (await resp.json()) as HistoryResponse;
      setData(json.points);
    } catch { /* ignore */ }
    finally { setIsLoading(false); }
  }, [deviceId, resolution]);

  useEffect(() => {
    setIsLoading(true);
    void load();
    const id = window.setInterval(() => { void load(); }, resolution === '1s' ? 5000 : 30000);
    return () => window.clearInterval(id);
  }, [load, resolution]);

  const formatted = data.map((p) => ({
    ...p,
    time: fmtTime(p.timestamp, resolution),
  }));

  return (
    <Card className='border border-border/80 bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-3'>
        <CardTitle className='flex items-center justify-between text-sm'>
          <div className='flex items-center gap-2'>
            <TrendingUp className='h-4 w-4 text-primary' />
            History
          </div>
          <div className='flex items-center gap-1'>
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
      <CardContent className='pt-4 space-y-6'>
        {isLoading && data.length === 0 ? (
          <div className='flex items-center justify-center py-12 text-sm text-muted-foreground'>Loading history…</div>
        ) : data.length === 0 ? (
          <div className='flex items-center justify-center py-12 text-sm text-muted-foreground'>No history data yet. Samples will appear once the data store collects readings.</div>
        ) : (
          <>
            <ChartSection title='Voltage' unit='V' data={formatted}
              lines={[{ key: 'totalVoltageVolts', color: '#38bdf8', name: 'Pack Voltage' }]} />
            <ChartSection title='Current & Power' unit='' data={formatted}
              lines={[
                { key: 'currentAmps', color: '#34d399', name: 'Current (A)' },
                { key: 'powerWatts', color: '#a78bfa', name: 'Power (W)' },
              ]} />
            <ChartSection title='State of Charge' unit='%' data={formatted}
              lines={[{ key: 'stateOfChargePercent', color: '#fbbf24', name: 'SOC' }]}
              domain={[0, 100]} />
            <ChartSection title='Cell Voltage Spread' unit='V' data={formatted}
              lines={[
                { key: 'minCellVoltageVolts', color: '#f87171', name: 'Min Cell' },
                { key: 'maxCellVoltageVolts', color: '#34d399', name: 'Max Cell' },
              ]} />
            <ChartSection title='Temperature' unit='°C' data={formatted}
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

function ChartSection({ title, data, lines, domain }: {
  title: string; unit: string; data: Record<string, unknown>[]; lines: LineSpec[];
  domain?: [number, number];
}) {
  return (
    <div>
      <div className='mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground'>{title}</div>
      <ResponsiveContainer width='100%' height={180}>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray='3 3' stroke='hsl(var(--border))' opacity={0.4} />
          <XAxis dataKey='time' tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} domain={domain ?? ['auto', 'auto']} />
          <Tooltip
            contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '0.5rem', fontSize: 12 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
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
