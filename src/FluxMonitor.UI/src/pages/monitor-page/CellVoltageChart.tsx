import { Battery } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { cn } from '../../lib/utils';
import type { CellVoltageSnapshot } from './types';

type CellVoltageChartProps = {
  cells: CellVoltageSnapshot[];
  minV?: number | null;
  maxV?: number | null;
  avgV?: number | null;
  selectedCellIndices?: number[];
  onCellClick?: (index: number) => void;
};

function formatCellVoltage(value: number) {
  return `${value.toFixed(3)} V`;
}

function formatCellSpread(value: number) {
  return `${Math.round(value * 1000)} mV`;
}

export function CellVoltageChart({
  cells,
  minV,
  maxV,
  avgV,
  selectedCellIndices,
  onCellClick,
}: CellVoltageChartProps) {
  const sorted = [...cells].sort((a, b) => a.index - b.index);
  const voltages = sorted.map(c => c.voltageVolts);
  const absMin = Math.min(...voltages);
  const absMax = Math.max(...voltages);
  const spread = Math.max(absMax - absMin, 0.001);
  const basePct = 55;
  const detailPct = 100 - basePct;
  const detailFloor = Math.max(absMin - spread * 2, 0);
  const detailCeil = absMax + spread * 0.5;
  const detailRange = Math.max(detailCeil - detailFloor, 0.001);

  function barPct(v: number): number {
    if (v <= detailFloor) return Math.max((v / Math.max(detailFloor, 0.001)) * basePct, 4);
    const t = (v - detailFloor) / detailRange;
    return basePct + Math.pow(t, 3) * detailPct;
  }

  return (
    <Card className='bg-card/85 shadow-sm'>
      <CardHeader className='border-b border-border/60 pb-3'>
        <CardTitle className='flex flex-col gap-3 text-sm lg:flex-row lg:items-center lg:justify-between'>
          <div className='flex flex-wrap items-center gap-3'>
            <div className='flex items-center gap-2' title='Cell voltages are smoothed using an Exponential Moving Average (EMA) with output hysteresis. The EMA dampens +/-2mV measurement noise while tracking real trends. Hysteresis holds the reported millivolt value until the smoothed average has moved at least 1mV, preventing rounding oscillation at millivolt boundaries. A breakout threshold snaps to raw readings when sudden genuine voltage changes exceed 5mV.'>
              <Battery className='h-4 w-4 text-muted-foreground' />
              Cell Voltages
            </div>
          </div>
          <div className='flex flex-wrap gap-x-4 gap-y-1 text-xs font-normal text-muted-foreground'>
            {minV != null && <span>Min: <span className='font-semibold text-foreground'>{formatCellVoltage(minV)}</span></span>}
            {avgV != null && <span>Avg: <span className='font-semibold text-foreground'>{formatCellVoltage(avgV)}</span></span>}
            {maxV != null && <span>Max: <span className='font-semibold text-foreground'>{formatCellVoltage(maxV)}</span></span>}
            {minV != null && maxV != null && <span>Delta: <span className='font-semibold text-foreground'>{formatCellSpread(maxV - minV)}</span></span>}
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
                  className='flex h-full min-w-0 cursor-pointer flex-col items-center justify-end'
                  onClick={(e) => { e.stopPropagation(); onCellClick?.(cell.index); }}
                >
                  <div
                    className={cn(
                      'w-full rounded-t transition-all duration-500',
                      isSelected ? 'bg-violet-500/90' :
                      isMin ? 'bg-rose-500/80' : isMax ? 'bg-emerald-500/80' : 'bg-primary/60',
                    )}
                    style={{ height: `${pct}%`, minHeight: '4px' }}
                  />
                  <div className='mt-0.5 text-[7px] leading-none text-muted-foreground sm:text-[9px]'>{cell.index}</div>
                  <div className='whitespace-nowrap text-[6px] font-semibold leading-none text-muted-foreground/80 tabular-nums sm:text-[8px]'>
                    {formatCellVoltage(cell.voltageVolts)}
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
