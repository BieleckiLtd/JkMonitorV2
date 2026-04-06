import type { LucideIcon } from 'lucide-react';
import { Cpu, HardDrive, Leaf, MemoryStick, Thermometer } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { Card, CardContent } from '../../components/ui/card';
import {
  UsagePanel,
  formatBytes,
  formatDecimalValue,
  formatElapsedDuration,
  formatFrequency,
  formatRpm,
  formatUsage,
  formatWholeNumber,
  getDerivedUsedBytes,
  getUsagePercent,
  noDataLabel,
} from './shared';
import type { SystemRuntimeMetrics } from './types';

type ResourceUsageSectionProps = {
  metrics: SystemRuntimeMetrics | null;
  applicationUptime: string;
};

export function ResourceUsageSection({
  metrics,
  applicationUptime,
}: ResourceUsageSectionProps) {
  const cpuUsage = metrics?.cpuUtilizationPercent ?? null;
  const cpuBaseClockSpeed = metrics?.cpuMaxClockSpeedMegahertz ?? null;
  const cpuCurrentClockSpeed = metrics?.cpuCurrentClockSpeedMegahertz ?? null;
  const isCpuThrottled = metrics?.cpuIsThrottled ?? false;
  const isCpuBelowBaseSpeed =
    cpuBaseClockSpeed != null &&
    cpuCurrentClockSpeed != null &&
    Number.isFinite(cpuBaseClockSpeed) &&
    Number.isFinite(cpuCurrentClockSpeed) &&
    cpuCurrentClockSpeed < cpuBaseClockSpeed;
  const cpuStatusIcon: LucideIcon | undefined = isCpuThrottled ? Thermometer : isCpuBelowBaseSpeed ? Leaf : undefined;
  const cpuStatusIconClassName = isCpuThrottled ? 'text-rose-400' : 'text-emerald-400';
  const memoryUsed = metrics?.memoryUsedBytes ?? getDerivedUsedBytes(metrics?.memoryTotalBytes, metrics?.memoryAvailableBytes);
  const memoryTotal = metrics?.memoryTotalBytes ?? null;
  const storageUsed = metrics?.storageUsedBytes ?? null;
  const storageTotal = metrics?.storageTotalBytes ?? null;
  const memoryUsagePercent = getUsagePercent(memoryUsed, memoryTotal);
  const storageUsagePercent = getUsagePercent(storageUsed, storageTotal);

  return (
    <Card className='system-section-card'>
      <PanelHeader
        title='Resource usage'
        description='CPU, memory, and storage capacity on the host running the monitor service.'
        aside={(
          <div className='space-y-1 text-right text-xs text-muted-foreground'>
            <div>Host uptime {formatElapsedDuration(metrics?.systemUptimeSeconds)}</div>
            <div>App uptime {applicationUptime}</div>
          </div>
        )}
      />
      <CardContent className='grid gap-5 pt-5'>
        <UsagePanel
          icon={Cpu}
          label='CPU'
          percent={cpuUsage}
          summary={`Current ${formatFrequency(metrics?.cpuCurrentClockSpeedMegahertz)}`}
          secondary={`Base ${formatFrequency(metrics?.cpuMaxClockSpeedMegahertz)} • ${formatWholeNumber(metrics?.cpuCoreCount)} cores`}
          details={[
            `${formatWholeNumber(metrics?.processCount)} processes`,
            `System temperature ${formatDecimalValue(metrics?.systemTemperatureCelsius, '°C')}`,
            `Fan speed ${formatRpm(metrics?.mainFanSpeedRpm)}`,
          ]}
          labelIcon={cpuStatusIcon}
          labelIconClassName={cpuStatusIconClassName}
        />
        <UsagePanel
          icon={MemoryStick}
          label='Memory'
          percent={memoryUsagePercent}
          summary={formatUsage(memoryUsed, memoryTotal)}
          secondary={metrics?.memoryAvailableBytes != null ? `${formatBytes(metrics.memoryAvailableBytes)} free` : noDataLabel}
        />
        <UsagePanel
          icon={HardDrive}
          label='Storage'
          percent={storageUsagePercent}
          summary={formatUsage(storageUsed, storageTotal)}
          secondary={storageTotal != null && storageUsed != null ? `${formatBytes(Math.max(storageTotal - storageUsed, 0))} free` : noDataLabel}
        />
      </CardContent>
    </Card>
  );
}
