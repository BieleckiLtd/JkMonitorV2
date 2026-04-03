import { useEffect, useState } from 'react';
import { Activity, CircleAlert, Cpu, Gauge, HardDrive, LoaderCircle, MemoryStick } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { cn } from '../lib/utils';

type DeviceTelemetrySnapshot = {
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  stateOfChargePercent?: number | null;
};

type DeviceRuntimeState = {
  deviceId: string;
  displayName: string;
  protocol: string;
  enabled: boolean;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  lastPollStartedAt?: string | null;
  lastPollCompletedAt?: string | null;
  lastOutcome: string;
  lastError?: string | null;
  lastPersistedAt?: string | null;
  latestTelemetry?: DeviceTelemetrySnapshot | null;
};

type SystemRuntimeMetrics = {
  cpuUtilizationPercent?: number | null;
  cpuCoreCount?: number | null;
  cpuMaxClockSpeedMegahertz?: number | null;
  cpuCurrentClockSpeedMegahertz?: number | null;
  processCount?: number | null;
  systemUptimeSeconds?: number | null;
  memoryAvailableBytes?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  storageUsedBytes?: number | null;
  storageTotalBytes?: number | null;
  mainFanSpeedRpm?: number | null;
  systemTemperatureCelsius?: number | null;
};

type BuildRuntimeInfo = {
  releaseTag?: string | null;
  sourceRevisionId?: string | null;
  informationalVersion?: string | null;
  workflowRunNumber?: string | null;
  workflowRunAttempt?: string | null;
};

type MonitorRuntimeStatus = {
  serviceName: string;
  environmentName: string;
  startupMode: string;
  startedAt: string;
  reportedAt: string;
  configuredDeviceCount: number;
  enabledDeviceCount: number;
  build?: BuildRuntimeInfo | null;
  systemMetrics?: SystemRuntimeMetrics | null;
  devices: DeviceRuntimeState[];
};

const refreshIntervalMs = 5000;
const noDataLabel = 'N/D';

export function DashboardPage() {
  const [status, setStatus] = useState<MonitorRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    let requestInFlight = false;

    const loadStatus = async () => {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const response = await fetch('/api/health', { cache: 'no-store' });

        if (!response.ok) {
          throw new Error('Unable to load runtime status.');
        }

        const data = (await response.json()) as MonitorRuntimeStatus;

        if (!isMounted) {
          return;
        }

        setStatus(data);
        setLoadError(null);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : 'Unable to load runtime status.');
      } finally {
        requestInFlight = false;

        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadStatus();

    const intervalId = window.setInterval(() => {
      void loadStatus();
    }, refreshIntervalMs);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const metrics = status?.systemMetrics ?? null;
  const cpuUsage = metrics?.cpuUtilizationPercent ?? null;
  const cpuBaseClockSpeed = metrics?.cpuMaxClockSpeedMegahertz ?? null;
  const cpuCurrentClockSpeed = metrics?.cpuCurrentClockSpeedMegahertz ?? null;
  const isCpuBelowBaseSpeed =
    cpuBaseClockSpeed != null &&
    cpuCurrentClockSpeed != null &&
    Number.isFinite(cpuBaseClockSpeed) &&
    Number.isFinite(cpuCurrentClockSpeed) &&
    cpuCurrentClockSpeed < cpuBaseClockSpeed;
  const memoryUsed = metrics?.memoryUsedBytes ?? getDerivedUsedBytes(metrics?.memoryTotalBytes, metrics?.memoryAvailableBytes);
  const memoryTotal = metrics?.memoryTotalBytes ?? null;
  const storageUsed = metrics?.storageUsedBytes ?? null;
  const storageTotal = metrics?.storageTotalBytes ?? null;
  const memoryUsagePercent = getUsagePercent(memoryUsed, memoryTotal);
  const storageUsagePercent = getUsagePercent(storageUsed, storageTotal);
  const applicationUptime = status ? formatDuration(status.startedAt, status.reportedAt) : noDataLabel;
  const deviceCount = status?.devices.length ?? 0;
  const healthyDevices = status?.devices.filter((device) => device.lastOutcome === 'Succeeded').length ?? 0;
  const failingDevices = status?.devices.filter((device) => device.lastOutcome === 'Failed' || device.lastOutcome === 'PersistFailed').length ?? 0;
  const latestReport = status?.reportedAt ? formatTimestamp(status.reportedAt) : 'Waiting for first sample';
  const releaseTag = formatReleaseDisplay(status?.build);
  const sourceRevisionId = status?.build?.sourceRevisionId ?? noDataLabel;
  const workflowRun = formatWorkflowRun(status?.build?.workflowRunNumber, status?.build?.workflowRunAttempt);

  return (
    <div className='space-y-6 pb-8'>
      <section data-slot='page-hero-shell' className='page-hero-shell rounded-3xl border border-border bg-card/80 p-6 shadow-sm backdrop-blur md:p-8'>
        <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
          <div className='space-y-3'>
            <div className='inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary'>
              <Activity className='h-3.5 w-3.5' />
              Live system monitor
            </div>
            <div>
              <h2 className='text-3xl font-bold tracking-tight text-foreground md:text-4xl'>Host health and capacity</h2>
              <p className='mt-2 max-w-2xl text-sm leading-6 text-muted-foreground'>
                Runtime telemetry from the active Flux Monitor host, including CPU, memory, storage, and device polling health.
              </p>
            </div>
          </div>

          <div className='grid gap-3 sm:grid-cols-3'>
            <StatusChip label='Environment' value={status?.environmentName ?? 'Loading'} />
            <StatusChip label='Mode' value={status?.startupMode ?? 'Loading'} />
            <StatusChip label='Release' value={releaseTag} />
          </div>
        </div>
      </section>

      {loadError ? (
        <div className='flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-4 text-sm text-destructive'>
          <CircleAlert className='mt-0.5 h-5 w-5 shrink-0' />
          <div>
            <div className='font-semibold'>Status feed unavailable</div>
            <div className='mt-1 text-destructive/90'>{loadError}</div>
          </div>
        </div>
      ) : null}

      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
        <MetricCard
          icon={Cpu}
          title='CPU Utilisation'
          value={formatPercent(cpuUsage)}
          accentClass={isCpuBelowBaseSpeed ? 'text-emerald-400' : 'text-sky-400'}
          iconClassName={isCpuBelowBaseSpeed ? 'text-emerald-400' : 'text-muted-foreground'}
          detail={`Current speed ${formatFrequency(cpuCurrentClockSpeed)}`}
          detailLines={[
            `Base speed ${formatFrequency(cpuBaseClockSpeed)}`,
            `${formatWholeNumber(metrics?.cpuCoreCount)} cores`,
            `${formatWholeNumber(metrics?.processCount)} processes`,
            `System temperature ${formatDecimalValue(metrics?.systemTemperatureCelsius, '°C')}`,
            `Fan speed ${formatRpm(metrics?.mainFanSpeedRpm)}`,
            `Host uptime ${formatElapsedDuration(metrics?.systemUptimeSeconds)}`,
            `App uptime ${applicationUptime}`,
          ]}
        />
        <MetricCard
          icon={MemoryStick}
          title='Memory Used'
          value={formatPercent(memoryUsagePercent)}
          accentClass='text-emerald-400'
          detail={formatUsage(memoryUsed, memoryTotal)}
        />
        <MetricCard
          icon={HardDrive}
          title='Storage Used'
          value={formatPercent(storageUsagePercent)}
          accentClass='text-amber-400'
          detail={formatUsage(storageUsed, storageTotal)}
        />
        <MetricCard
          icon={Gauge}
          title='Device Polling'
          value={`${healthyDevices}/${status?.enabledDeviceCount ?? 0}`}
          accentClass={failingDevices > 0 ? 'text-rose-400' : 'text-primary'}
          detail={failingDevices > 0 ? `${failingDevices} attention needed` : `${deviceCount} configured devices tracked`}
        />
      </div>

      {isLoading && !status ? (
        <div className='flex min-h-64 items-center justify-center rounded-2xl border border-border bg-card/60'>
          <LoaderCircle className='h-6 w-6 animate-spin text-primary' />
        </div>
      ) : null}

      {status ? (
        <div className='grid gap-6 xl:grid-cols-[1.35fr_1fr]'>
          <div className='space-y-6'>
            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <CardTitle>Resource usage</CardTitle>
                <CardDescription>CPU, memory, and storage capacity on the host running the monitor service.</CardDescription>
              </CardHeader>
              <CardContent className='grid gap-5 pt-5'>
                <UsagePanel
                  label='CPU'
                  percent={cpuUsage}
                  summary={`Current ${formatFrequency(metrics?.cpuCurrentClockSpeedMegahertz)}`}
                  secondary={`Base ${formatFrequency(metrics?.cpuMaxClockSpeedMegahertz)} • ${formatWholeNumber(metrics?.cpuCoreCount)} cores`}
                />
                <UsagePanel
                  label='Memory'
                  percent={memoryUsagePercent}
                  summary={formatUsage(memoryUsed, memoryTotal)}
                  secondary={metrics?.memoryAvailableBytes != null ? `${formatBytes(metrics.memoryAvailableBytes)} free` : noDataLabel}
                />
                <UsagePanel
                  label='Storage'
                  percent={storageUsagePercent}
                  summary={formatUsage(storageUsed, storageTotal)}
                  secondary={storageTotal != null && storageUsed != null ? `${formatBytes(Math.max(storageTotal - storageUsed, 0))} free` : noDataLabel}
                />
              </CardContent>
            </Card>

            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <CardTitle>Device activity</CardTitle>
                <CardDescription>Latest polling outcome for each configured BMS definition.</CardDescription>
              </CardHeader>
              <CardContent className='space-y-3 pt-5'>
                {status.devices.length > 0 ? status.devices.map((device) => (
                  <article key={device.deviceId} className='rounded-2xl border border-border/70 bg-background/60 p-4'>
                    <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
                      <div>
                        <div className='flex flex-wrap items-center gap-2'>
                          <h3 className='text-sm font-semibold text-foreground'>{device.displayName}</h3>
                          {!device.enabled ? <span className='rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground'>Disabled</span> : null}
                        </div>
                        <div className='mt-1 text-xs font-mono text-muted-foreground'>{device.deviceId} • {device.protocol}</div>
                      </div>
                      <div className={cn('inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em]', getOutcomeClassName(device.lastOutcome))}>
                        {device.lastOutcome}
                      </div>
                    </div>

                    <div className='mt-4 grid gap-3 md:grid-cols-3'>
                      <DetailTile label='Last poll' value={formatTimestamp(device.lastPollCompletedAt)} />
                      <DetailTile label='Persisted' value={formatTimestamp(device.lastPersistedAt)} />
                      <DetailTile label='Interval' value={`${device.pollIntervalMilliseconds.toLocaleString()} ms`} />
                    </div>

                    <div className='mt-4 grid gap-3 md:grid-cols-3'>
                      <DetailTile label='Voltage' value={formatDecimalValue(device.latestTelemetry?.totalVoltageVolts, 'V')} />
                      <DetailTile label='Current' value={formatDecimalValue(device.latestTelemetry?.currentAmps, 'A')} />
                      <DetailTile label='State of charge' value={formatDecimalValue(device.latestTelemetry?.stateOfChargePercent, '%')} />
                    </div>

                    {device.lastError ? (
                      <div className='mt-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                        {device.lastError}
                      </div>
                    ) : null}
                  </article>
                )) : (
                  <div className='rounded-2xl border border-dashed border-border bg-background/40 px-5 py-10 text-center text-sm text-muted-foreground'>
                    No devices configured yet.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className='space-y-6'>
            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <CardTitle>Host profile</CardTitle>
                <CardDescription>Static runtime details and hardware characteristics for the current machine.</CardDescription>
              </CardHeader>
              <CardContent className='grid gap-4 pt-5'>
                <DetailTile label='Service' value={status.serviceName} />
                <DetailTile label='Environment' value={status.environmentName} />
                <DetailTile label='Startup mode' value={status.startupMode} />
                <DetailTile label='Release tag' value={releaseTag} />
                <DetailTile label='Commit' value={formatCommit(sourceRevisionId)} />
                <DetailTile label='Workflow run' value={workflowRun} />
                <DetailTile label='Last report' value={latestReport} />
                <DetailTile label='Service uptime' value={formatDuration(status.startedAt, status.reportedAt)} />
                <DetailTile label='CPU current speed' value={formatFrequency(metrics?.cpuCurrentClockSpeedMegahertz)} />
                <DetailTile label='CPU max speed' value={formatFrequency(metrics?.cpuMaxClockSpeedMegahertz)} />
                <DetailTile label='CPU cores' value={formatWholeNumber(metrics?.cpuCoreCount)} />
                <DetailTile label='Fan speed' value={formatRpm(metrics?.mainFanSpeedRpm)} />
                <DetailTile label='Temperature' value={formatDecimalValue(metrics?.systemTemperatureCelsius, '°C')} />
              </CardContent>
            </Card>

            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <CardTitle>Polling summary</CardTitle>
                <CardDescription>Quick view of how many configured devices are active and reporting.</CardDescription>
              </CardHeader>
              <CardContent className='grid gap-3 pt-5'>
                <DetailTile label='Configured devices' value={status.configuredDeviceCount.toLocaleString()} />
                <DetailTile label='Enabled devices' value={status.enabledDeviceCount.toLocaleString()} />
                <DetailTile label='Healthy devices' value={healthyDevices.toLocaleString()} />
                <DetailTile label='Devices needing attention' value={failingDevices.toLocaleString()} />
              </CardContent>
            </Card>

          </div>
        </div>
      ) : null}
    </div>
  );
}

function MetricCard({
  icon: Icon,
  title,
  value,
  detail,
  detailLines,
  accentClass,
  iconClassName,
}: {
  icon: typeof Cpu;
  title: string;
  value: string;
  detail: string;
  detailLines?: string[];
  accentClass: string;
  iconClassName?: string;
}) {
  return (
    <Card className='border border-border/80 bg-card/85 shadow-sm'>
      <CardContent className='p-6'>
        <div className='flex items-start justify-between gap-3'>
          <div>
            <div className='text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground'>{title}</div>
            <div className={cn('mt-3 text-4xl font-bold tracking-tight', accentClass)}>{value}</div>
            <div className='mt-2 text-sm text-muted-foreground'>{detail}</div>
            {detailLines?.length ? (
              <div className='mt-3 space-y-1 text-sm text-muted-foreground'>
                {detailLines.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            ) : null}
          </div>
          <div className={cn('rounded-2xl border border-border/70 bg-background/60 p-3', iconClassName ?? 'text-muted-foreground')}>
            <Icon className='h-5 w-5' />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function UsagePanel({ label, percent, summary, secondary }: { label: string; percent: number | null; summary: string; secondary: string }) {
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-3'>
        <div>
          <div className='text-sm font-semibold text-foreground'>{label}</div>
          <div className='text-sm text-muted-foreground'>{summary}</div>
        </div>
        <div className='text-sm font-semibold text-foreground'>{formatPercent(percent)}</div>
      </div>
      <div className='h-2 overflow-hidden rounded-full bg-muted'>
        <div className='h-full rounded-full bg-primary transition-[width] duration-500 ease-out' style={{ width: `${Math.max(percent ?? 0, 4)}%` }} />
      </div>
      <div className='text-xs text-muted-foreground'>{secondary}</div>
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div data-slot='data-tile' className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
      <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>{label}</div>
      <div className='mt-2 text-sm font-semibold text-foreground'>{value}</div>
    </div>
  );
}

function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <div data-slot='data-tile' className='rounded-2xl border border-border/70 bg-background/70 px-4 py-3'>
      <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>{label}</div>
      <div className='mt-1 text-sm font-semibold text-foreground'>{value}</div>
    </div>
  );
}

function formatReleaseDisplay(build?: BuildRuntimeInfo | null) {
  const releaseTag = build?.releaseTag?.trim();
  if (releaseTag) {
    return releaseTag;
  }

  const informationalVersion = build?.informationalVersion?.trim();
  if (!informationalVersion) {
    return noDataLabel;
  }

  const revisionMatch = /^(.*)\+([0-9a-f]{12,40})$/i.exec(informationalVersion);
  if (!revisionMatch) {
    return informationalVersion;
  }

  const [, versionLabel, revision] = revisionMatch;
  return `${versionLabel}+${revision.slice(0, 7)}`;
}

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let currentValue = value;

  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }

  const digits = currentValue >= 100 || unitIndex === 0 ? 0 : 1;
  return `${currentValue.toFixed(digits)} ${units[unitIndex]}`;
}

function formatUsage(usedBytes: number | null, totalBytes: number | null) {
  if (usedBytes == null || totalBytes == null) {
    return noDataLabel;
  }

  return `${formatBytes(usedBytes)} of ${formatBytes(totalBytes)}`;
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatWholeNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return Math.round(value).toLocaleString();
}

function formatFrequency(megahertz: number | null | undefined) {
  if (megahertz == null || !Number.isFinite(megahertz)) {
    return noDataLabel;
  }

  if (megahertz >= 1000) {
    return `${(megahertz / 1000).toFixed(2)} GHz`;
  }

  return `${Math.round(megahertz).toLocaleString()} MHz`;
}

function formatDecimalValue(value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)} ${unit}`;
}

function formatRpm(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${Math.round(value).toLocaleString()} RPM`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return noDataLabel;
  }

  return new Date(value).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCommit(value: string | null | undefined) {
  if (!value) {
    return noDataLabel;
  }

  return value.slice(0, 12);
}

function formatWorkflowRun(runNumber: string | null | undefined, runAttempt: string | null | undefined) {
  if (!runNumber) {
    return noDataLabel;
  }

  if (!runAttempt) {
    return `#${runNumber}`;
  }

  return `#${runNumber} · attempt ${runAttempt}`;
}

function formatDuration(startedAt: string, reportedAt: string) {
  if (!startedAt || !reportedAt) {
    return noDataLabel;
  }

  const elapsedMilliseconds = Math.max(new Date(reportedAt).getTime() - new Date(startedAt).getTime(), 0);
  const totalSeconds = Math.floor(elapsedMilliseconds / 1000);

  return formatElapsedDuration(totalSeconds);
}

function formatElapsedDuration(totalSeconds: number | null | undefined) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) {
    return noDataLabel;
  }

  const wholeSeconds = Math.max(Math.floor(totalSeconds), 0);
  const days = Math.floor(wholeSeconds / 86400);
  const hours = Math.floor((wholeSeconds % 86400) / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return '<1m';
}

function getUsagePercent(usedBytes: number | null, totalBytes: number | null) {
  if (usedBytes == null || totalBytes == null || totalBytes <= 0) {
    return null;
  }

  return Math.min(Math.max((usedBytes / totalBytes) * 100, 0), 100);
}

function getDerivedUsedBytes(totalBytes: number | null | undefined, availableBytes: number | null | undefined) {
  if (totalBytes == null || availableBytes == null) {
    return null;
  }

  return Math.max(totalBytes - availableBytes, 0);
}

function getOutcomeClassName(outcome: string) {
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
