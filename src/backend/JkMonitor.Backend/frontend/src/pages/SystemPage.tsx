import { useEffect, useState, useRef, useCallback } from 'react';
import { Activity, CircleAlert, Cpu, Database, Download, Gauge, HardDrive, Leaf, LoaderCircle, MemoryStick, Upload, RefreshCcw, CheckCircle2, XCircle, Usb } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { cn } from '../lib/utils';
import { LogsPanel } from '../components/LogsPanel';

type DeviceTelemetrySnapshot = {
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  stateOfChargePercent?: number | null;
};

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

type TableSizeInfo = {
  tableName: string;
  sizeBytes: number;
  sizeFormatted: string;
  rowCount: number;
};

type DatabaseSizeInfo = {
  totalSizeBytes: number;
  totalSizeFormatted: string;
  tables: TableSizeInfo[];
};

type UpdateCheckResult = {
  currentReleaseTag?: string | null;
  currentSourceRevision?: string | null;
  currentBuiltAt?: string | null;
  canUpdate: boolean;
  reason?: string | null;
  updateAvailable: boolean;
  remoteReleasePublishedAt?: string | null;
  remoteChecksum?: string | null;
  localChecksum?: string | null;
  checkError?: string | null;
};

type UpdateProgress = {
  isRunning: boolean;
  stage: string;
  success?: boolean | null;
};

type SerialPortInfo = {
  name: string;
  description?: string | null;
};

type BlockDeviceInfo = {
  name: string;
  model?: string | null;
  sizeBytes: number;
  sizeFormatted?: string | null;
  readOnly: boolean;
};

type NetworkInterfaceInfo = {
  name: string;
  description?: string | null;
  type?: string | null;
  status?: string | null;
  macAddress?: string | null;
  addresses: string[];
  speedMbps?: number | null;
};

type SystemInterfacesResponse = {
  serialPorts: SerialPortInfo[];
  blockDevices: BlockDeviceInfo[];
  networkInterfaces: NetworkInterfaceInfo[];
};

export function SystemPage() {
  const [status, setStatus] = useState<MonitorRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dbSize, setDbSize] = useState<DatabaseSizeInfo | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [interfaces, setInterfaces] = useState<SystemInterfacesResponse | null>(null);

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

  const loadDbSize = async () => {
    setDbLoading(true);
    try {
      const response = await fetch('/api/database/size', { cache: 'no-store' });
      if (response.ok) {
        setDbSize(await response.json() as DatabaseSizeInfo);
      }
    } catch {
      // Silently ignore — the card will show a loading state.
    } finally {
      setDbLoading(false);
    }
  };

  useEffect(() => {
    void loadDbSize();
    const id = window.setInterval(() => void loadDbSize(), 30000);
    return () => window.clearInterval(id);
  }, []);

  const checkForUpdate = useCallback(async () => {
    setUpdateChecking(true);
    try {
      const response = await fetch('/api/system/update/check', { cache: 'no-store' });
      if (response.ok) {
        setUpdateCheck(await response.json() as UpdateCheckResult);
      }
    } catch {
      // Silently ignore.
    } finally {
      setUpdateChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

  const installUpdate = async () => {
    setUpdateInstalling(true);
    try {
      const response = await fetch('/api/system/update/install', { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setUpdateProgress({ isRunning: false, stage: body?.error ?? 'Failed to start update.', success: false });
        return;
      }
      // Poll progress
      const pollProgress = async () => {
        for (let i = 0; i < 120; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const resp = await fetch('/api/system/update/progress', { cache: 'no-store' });
            if (resp.ok) {
              const progress = await resp.json() as UpdateProgress;
              setUpdateProgress(progress);
              if (!progress.isRunning) return;
            }
          } catch {
            // Service might be restarting
            setUpdateProgress({ isRunning: false, stage: 'Service restarting — refresh the page in a moment.', success: true });
            return;
          }
        }
      };
      void pollProgress();
    } catch {
      setUpdateProgress({ isRunning: false, stage: 'Network error starting update.', success: false });
    } finally {
      setUpdateInstalling(false);
    }
  };

  useEffect(() => {
    const loadInterfaces = async () => {
      try {
        const response = await fetch('/api/system/interfaces', { cache: 'no-store' });
        if (response.ok) {
          setInterfaces(await response.json() as SystemInterfacesResponse);
        }
      } catch {
        // Silently ignore.
      }
    };
    void loadInterfaces();
    const id = window.setInterval(() => void loadInterfaces(), 30000);
    return () => window.clearInterval(id);
  }, []);

  const handleExport = () => {
    window.location.href = '/api/database/export';
  };

  const handleImport = async (file: File) => {
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/database/import', { method: 'POST', body: formData });
      if (response.ok) {
        setImportResult('Import completed successfully.');
        void loadDbSize();
      } else {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setImportResult(body?.error ?? 'Import failed.');
      }
    } catch {
      setImportResult('Import failed — network error.');
    } finally {
      setImporting(false);
    }
  };

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
  const releaseTag = formatReleaseDisplay(status?.build);
  const sourceRevisionId = status?.build?.sourceRevisionId ?? noDataLabel;
  const workflowRun = formatWorkflowRun(status?.build?.workflowRunNumber, status?.build?.workflowRunAttempt);

  return (
    <div className='space-y-6 pb-8'>
      <section className='rounded-3xl border border-border bg-card/80 p-6 shadow-sm backdrop-blur md:p-8'>
        <div className='flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between'>
          <div className='space-y-3'>
            <div className='inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.24em] text-primary'>
              <Activity className='h-3.5 w-3.5' />
              System overview
            </div>
            <div>
              <h2 className='text-3xl font-bold tracking-tight text-foreground md:text-4xl'>System resources and logs</h2>
              <p className='mt-2 max-w-2xl text-sm leading-6 text-muted-foreground'>
                Runtime telemetry from the active JK Monitor host, including CPU, memory, storage, device polling health, and application logs.
              </p>
            </div>
          </div>

          <div className='grid gap-3 sm:grid-cols-3 lg:grid-cols-5'>
            <StatusChip label='Environment' value={status?.environmentName ?? 'Loading'} />
            <StatusChip label='Mode' value={status?.startupMode ?? 'Loading'} />
            <StatusChip label='Release' value={releaseTag} />
            <StatusChip label='Commit' value={formatCommit(sourceRevisionId)} />
            <StatusChip label='Workflow' value={workflowRun} />
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
          icon={isCpuBelowBaseSpeed ? Leaf : Cpu}
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
                <div className='flex items-center gap-2'>
                  <RefreshCcw className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Software update</CardTitle>
                    <CardDescription>Check for new releases and install updates from GitHub.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='space-y-4 pt-5'>
                {updateChecking && !updateCheck ? (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                ) : updateCheck ? (
                  <>
                    <DetailTile label='Installed release' value={updateCheck.currentReleaseTag ?? noDataLabel} />
                    <DetailTile label='Installed commit' value={formatCommit(updateCheck.currentSourceRevision)} />
                    {updateCheck.currentBuiltAt ? <DetailTile label='Built at' value={formatTimestamp(updateCheck.currentBuiltAt)} /> : null}

                    {updateCheck.checkError ? (
                      <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                        Update check failed: {updateCheck.checkError}
                      </div>
                    ) : updateCheck.updateAvailable ? (
                      <div className='rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary'>
                        <div className='flex items-center gap-2'>
                          <Download className='h-4 w-4' />
                          A new version is available.
                        </div>
                        {updateCheck.remoteReleasePublishedAt ? (
                          <div className='mt-1 text-xs text-primary/80'>Published {formatTimestamp(updateCheck.remoteReleasePublishedAt)}</div>
                        ) : null}
                      </div>
                    ) : updateCheck.localChecksum && updateCheck.remoteChecksum ? (
                      <div className='rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2'>
                        <CheckCircle2 className='h-4 w-4' />
                        You are running the latest version.
                      </div>
                    ) : null}

                    {!updateCheck.canUpdate ? (
                      <div className='rounded-xl border border-border bg-muted/70 px-3 py-2 text-xs text-muted-foreground'>
                        {updateCheck.reason}
                      </div>
                    ) : null}

                    {updateProgress ? (
                      <div className={cn(
                        'rounded-xl border px-3 py-2 text-xs flex items-center gap-2',
                        updateProgress.success === true ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                          : updateProgress.success === false ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                          : 'border-primary/20 bg-primary/10 text-primary'
                      )}>
                        {updateProgress.isRunning ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : updateProgress.success ? <CheckCircle2 className='h-3.5 w-3.5' /> : <XCircle className='h-3.5 w-3.5' />}
                        {updateProgress.stage}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className='text-sm text-muted-foreground'>Unable to check for updates.</div>
                )}

                <div className='flex gap-2 pt-2'>
                  <button
                    type='button'
                    disabled={updateChecking}
                    onClick={() => void checkForUpdate()}
                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                  >
                    {updateChecking ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
                    Check for updates
                  </button>

                  {updateCheck?.canUpdate && updateCheck?.updateAvailable ? (
                    <button
                      type='button'
                      disabled={updateInstalling || (updateProgress?.isRunning ?? false)}
                      onClick={() => void installUpdate()}
                      className='inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
                    >
                      {updateInstalling || updateProgress?.isRunning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Download className='h-4 w-4' />}
                      Install update
                    </button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className='space-y-6'>
            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex items-center gap-2'>
                  <Usb className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Connected interfaces</CardTitle>
                    <CardDescription>Serial ports, block devices, and network adapters detected on this host.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='space-y-4 pt-5'>
                {interfaces ? (
                  <>
                    {interfaces.serialPorts.length > 0 ? (
                      <div className='space-y-2'>
                        <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Serial ports</div>
                        {interfaces.serialPorts.map((port) => (
                          <div key={port.name} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                            <div className='text-sm font-semibold text-foreground font-mono'>{port.name}</div>
                            {port.description ? <div className='mt-1 text-xs text-muted-foreground'>{port.description}</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className='rounded-2xl border border-dashed border-border bg-background/40 px-4 py-3 text-center text-xs text-muted-foreground'>
                        No serial ports detected.
                      </div>
                    )}

                    {interfaces.blockDevices.length > 0 ? (
                      <div className='space-y-2'>
                        <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Block devices</div>
                        {interfaces.blockDevices.map((dev) => (
                          <div key={dev.name} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                            <div className='flex items-center justify-between'>
                              <div className='text-sm font-semibold text-foreground font-mono'>{dev.name}</div>
                              <div className='text-xs text-muted-foreground'>{dev.sizeFormatted}</div>
                            </div>
                            {dev.model ? <div className='mt-1 text-xs text-muted-foreground'>{dev.model}</div> : null}
                            {dev.readOnly ? <div className='mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400'>Read-only</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {interfaces.networkInterfaces.length > 0 ? (
                      <div className='space-y-2'>
                        <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Network adapters</div>
                        {interfaces.networkInterfaces.map((ni) => (
                          <div key={ni.name} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                            <div className='flex items-center justify-between'>
                              <div className='text-sm font-semibold text-foreground font-mono'>{ni.name}</div>
                              <div className={cn('text-[10px] font-semibold uppercase tracking-[0.18em]', ni.status === 'Up' ? 'text-emerald-400' : 'text-muted-foreground')}>
                                {ni.status}
                              </div>
                            </div>
                            {ni.type ? <div className='mt-1 text-xs text-muted-foreground'>{ni.type}{ni.speedMbps ? ` • ${ni.speedMbps} Mbps` : ''}</div> : null}
                            {ni.macAddress ? <div className='mt-0.5 text-xs text-muted-foreground font-mono'>{ni.macAddress.replace(/(.{2})(?=.)/g, '$1:')}</div> : null}
                            {ni.addresses.length > 0 ? (
                              <div className='mt-1 space-y-0.5'>
                                {ni.addresses.map((addr) => (
                                  <div key={addr} className='text-xs text-foreground font-mono'>{addr}</div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex items-center gap-2'>
                  <Database className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Database</CardTitle>
                    <CardDescription>TimescaleDB storage size, backup, and restore.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='space-y-4 pt-5'>
                {dbLoading && !dbSize ? (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                ) : dbSize ? (
                  <>
                    <DetailTile label='Total database size' value={dbSize.totalSizeFormatted} />
                    <div className='space-y-2'>
                      {dbSize.tables.map((t) => (
                        <div key={t.tableName} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                          <div className='flex items-center justify-between'>
                            <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground font-mono'>{t.tableName}</div>
                            <div className='text-xs text-muted-foreground'>{t.rowCount.toLocaleString()} rows</div>
                          </div>
                          <div className='mt-1 text-sm font-semibold text-foreground'>{t.sizeFormatted}</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className='text-sm text-muted-foreground'>Unable to load database info.</div>
                )}

                <div className='flex flex-col gap-2 pt-2'>
                  <button
                    type='button'
                    onClick={handleExport}
                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
                  >
                    <Download className='h-4 w-4' />
                    Export database
                  </button>

                  <input
                    ref={fileInputRef}
                    type='file'
                    accept='.csv,.sql'
                    className='hidden'
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImport(file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type='button'
                    disabled={importing}
                    onClick={() => fileInputRef.current?.click()}
                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                  >
                    {importing ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Upload className='h-4 w-4' />}
                    {importing ? 'Importing…' : 'Import database'}
                  </button>

                  {importResult ? (
                    <div className={cn('rounded-xl border px-3 py-2 text-xs', importResult.includes('successfully') ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200')}>
                      {importResult}
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      ) : null}

      {/* Application Logs */}
      <LogsPanel />
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
    <div className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
      <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>{label}</div>
      <div className='mt-2 text-sm font-semibold text-foreground'>{value}</div>
    </div>
  );
}

function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-2xl border border-border/70 bg-background/70 px-4 py-3'>
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
