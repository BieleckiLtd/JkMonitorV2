import { CheckCircle2, CircleAlert, Download, LoaderCircle, Upload, Wifi } from 'lucide-react';
import { cn } from '../../lib/utils';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import { DetailTile, SpeedMetricCard } from './shared';
import type { InternetSpeedTestSnapshot } from './types';

type InternetSpeedMenuItemProps = {
  internetSpeedSectionOpen: boolean;
  hasMeasuredInternetSpeed: boolean;
  downloadSummary: string;
  uploadSummary: string;
  internetSpeedTestLoading: boolean;
  internetSpeedTest: InternetSpeedTestSnapshot | null;
  internetSpeedTestError: string | null;
  internetSpeedPingValue: string;
  internetSpeedPingDialDisplay: string;
  internetSpeedPingCaption?: string;
  internetSpeedPingDialGauge: number;
  internetSpeedPingTone: 'emerald-soft' | 'amber' | 'rose';
  internetSpeedPingIsActive: boolean;
  internetSpeedDownloadValue: string;
  internetSpeedDownloadDialDisplay: string;
  internetSpeedDownloadCaption?: string;
  internetSpeedDownloadDialGauge: number;
  internetSpeedDownloadIsActive: boolean;
  internetSpeedUploadValue: string;
  internetSpeedUploadDialDisplay: string;
  internetSpeedUploadCaption?: string;
  internetSpeedUploadDialGauge: number;
  internetSpeedUploadIsActive: boolean;
  internetSpeedServer: string;
  internetSpeedDistance: string;
  internetSpeedProvider: string;
  internetSpeedIpAddress: string;
  internetSpeedConnectionMode: string;
  internetSpeedMeasuredAt: string;
  internetSpeedTestStarting: boolean;
  onToggleExpanded: () => void;
  onStartTest: () => void | Promise<void>;
};

export function InternetSpeedMenuItem({
  internetSpeedSectionOpen,
  hasMeasuredInternetSpeed,
  downloadSummary,
  uploadSummary,
  internetSpeedTestLoading,
  internetSpeedTest,
  internetSpeedTestError,
  internetSpeedPingValue,
  internetSpeedPingDialDisplay,
  internetSpeedPingCaption,
  internetSpeedPingDialGauge,
  internetSpeedPingTone,
  internetSpeedPingIsActive,
  internetSpeedDownloadValue,
  internetSpeedDownloadDialDisplay,
  internetSpeedDownloadCaption,
  internetSpeedDownloadDialGauge,
  internetSpeedDownloadIsActive,
  internetSpeedUploadValue,
  internetSpeedUploadDialDisplay,
  internetSpeedUploadCaption,
  internetSpeedUploadDialGauge,
  internetSpeedUploadIsActive,
  internetSpeedServer,
  internetSpeedDistance,
  internetSpeedProvider,
  internetSpeedIpAddress,
  internetSpeedConnectionMode,
  internetSpeedMeasuredAt,
  internetSpeedTestStarting,
  onToggleExpanded,
  onStartTest,
}: InternetSpeedMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='Internet speed'
      summary={hasMeasuredInternetSpeed ? (
        <div className='mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          <span className='inline-flex items-center gap-1'>
            <Download className='h-3 w-3' />
            {downloadSummary}
          </span>
          <span className='inline-flex items-center gap-1'>
            <Upload className='h-3 w-3' />
            {uploadSummary}
          </span>
        </div>
      ) : 'Never measured'}
      icon={Wifi}
      expanded={internetSpeedSectionOpen}
      onToggleExpanded={onToggleExpanded}
      fullWidthHeaderButton
    >
      {internetSpeedTestLoading && !internetSpeedTest ? (
        <div className='flex items-center justify-center py-8'>
          <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
        </div>
      ) : (
        <>
          {internetSpeedTestError ? (
            <div className='system-feedback system-feedback-error'>
              {internetSpeedTestError}
            </div>
          ) : null}

          {internetSpeedTest?.statusMessage && !internetSpeedTest.isRunning && (!internetSpeedTest.supported || internetSpeedTest.status === 'failed' || (!hasMeasuredInternetSpeed && internetSpeedTest.status !== 'succeeded')) ? (
            <div className={cn(
              'rounded-2xl border px-4 py-4',
              internetSpeedTest.status === 'failed'
                ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                : 'border-border/70 bg-background/40 text-foreground'
            )}>
              <div className='flex items-start gap-3'>
                {!internetSpeedTest.supported || internetSpeedTest.status === 'failed' ? (
                  <CircleAlert className='mt-0.5 h-4 w-4 shrink-0' />
                ) : (
                  <CheckCircle2 className='mt-0.5 h-4 w-4 shrink-0 text-emerald-400' />
                )}
                <div className='min-w-0'>
                  <div className='text-sm font-semibold'>
                    {!internetSpeedTest.supported
                      ? 'Speed test unavailable'
                      : internetSpeedTest.status === 'failed'
                        ? 'Speed test did not finish'
                        : 'Internet speed ready'}
                  </div>
                  <div className='mt-1 text-xs opacity-85'>
                    {internetSpeedTest.statusMessage}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className='grid gap-3 sm:grid-cols-3'>
            <SpeedMetricCard
              label='Ping'
              value={internetSpeedPingValue}
              dialValue={internetSpeedPingDialDisplay}
              caption={internetSpeedPingCaption}
              gaugePercent={internetSpeedPingDialGauge}
              tone={internetSpeedPingTone}
              isActive={internetSpeedPingIsActive}
            />
            <SpeedMetricCard
              label='Download'
              value={internetSpeedDownloadValue}
              dialValue={internetSpeedDownloadDialDisplay}
              caption={internetSpeedDownloadCaption}
              gaugePercent={internetSpeedDownloadDialGauge}
              tone='emerald'
              isActive={internetSpeedDownloadIsActive}
            />
            <SpeedMetricCard
              label='Upload'
              value={internetSpeedUploadValue}
              dialValue={internetSpeedUploadDialDisplay}
              caption={internetSpeedUploadCaption}
              gaugePercent={internetSpeedUploadDialGauge}
              tone='sky'
              isActive={internetSpeedUploadIsActive}
            />
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <DetailTile label='Server' value={internetSpeedServer} />
            <DetailTile label='Distance' value={internetSpeedDistance} />
            <DetailTile label='Provider' value={internetSpeedProvider} />
            <DetailTile label='IP address' value={internetSpeedIpAddress} />
            <DetailTile label='Connections' value={internetSpeedConnectionMode} />
            <DetailTile label='Measured at' value={internetSpeedMeasuredAt} />
          </div>

          <div>
            <button
              type='button'
              disabled={internetSpeedTestStarting || internetSpeedTest?.isRunning || !internetSpeedTest?.canStart}
              onClick={() => void onStartTest()}
              className='system-button-primary w-full'
            >
              {internetSpeedTestStarting || internetSpeedTest?.isRunning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Wifi className='h-4 w-4' />}
              {internetSpeedTest?.isRunning ? 'Speed test running… please wait' : 'Run internet speed test'}
            </button>
          </div>
        </>
      )}
    </ConnectivityMenuItem>
  );
}
