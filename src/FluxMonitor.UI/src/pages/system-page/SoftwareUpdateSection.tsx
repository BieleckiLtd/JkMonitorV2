import { CheckCircle2, CircleAlert, Download, LoaderCircle, XCircle } from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import {
  type UpdateProgress,
  getUpdateCancellationMessage,
  getUpdateProgressDetail,
  getUpdateProgressLabel,
  getUpdateStateTone,
} from '../../lib/systemUpdate';
import { cn } from '../../lib/utils';
import {
  DetailTile,
  UpdateChannelTile,
  formatReleaseChannel,
} from './shared';
import type { UpdateCheckResult } from './types';

type SoftwareUpdateSectionProps = {
  preferredUpdateChannel: string;
  updateChannelSaving: boolean;
  updateChecking: boolean;
  updateProgress: UpdateProgress | null;
  updateCheck: UpdateCheckResult | null;
  installedCommit: string | null;
  workflowRun: string;
  installedReleasePublishedLabel: string;
  updateActionError: string | null;
  updateChannelError: string | null;
  updateActionPending: string | null;
  onSaveUpdateChannel: (value: string | null) => void;
  onInstallUpdate: () => void | Promise<void>;
};

export function SoftwareUpdateSection({
  preferredUpdateChannel,
  updateChannelSaving,
  updateChecking,
  updateProgress,
  updateCheck,
  installedCommit,
  workflowRun,
  installedReleasePublishedLabel,
  updateActionError,
  updateChannelError,
  updateActionPending,
  onSaveUpdateChannel,
  onInstallUpdate,
}: SoftwareUpdateSectionProps) {
  return (
    <Card className='system-section-card'>
      <CardContent className='space-y-4 pt-6'>
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
          <UpdateChannelTile
            value={preferredUpdateChannel}
            disabled={updateChannelSaving || updateChecking || (updateProgress?.isRunning ?? false)}
            pending={updateChannelSaving}
            onChange={onSaveUpdateChannel}
          />
          <DetailTile label='Commit' value={installedCommit ?? 'N/D'} />
          <DetailTile label='Workflow' value={workflowRun} />
          <DetailTile label='Published' value={installedReleasePublishedLabel} />
        </div>

        {updateCheck?.currentChannel && preferredUpdateChannel && updateCheck.currentChannel !== preferredUpdateChannel ? (
          <div className='system-muted-banner'>
            Installed build is on the {formatReleaseChannel(updateCheck.currentChannel)} channel. New update checks use the {formatReleaseChannel(preferredUpdateChannel)} branch.
          </div>
        ) : null}

        {updateChecking && !updateCheck ? (
          <div className='flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground'>
            <LoaderCircle className='h-4 w-4 animate-spin' />
            Checking the current release channel…
          </div>
        ) : null}

        {updateCheck ? (
          <>
            {updateCheck.checkError ? (
              <div className='system-feedback system-feedback-error'>
                Update check failed: {updateCheck.checkError}
              </div>
            ) : updateCheck.updateAvailable && updateProgress?.success !== true ? (
              <div className='rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary'>
                <div className='flex items-center gap-2'>
                  <Download className='h-4 w-4' />
                  A new version is available.
                </div>
                {updateCheck.targetReleaseTag ? (
                  <div className='mt-1 text-xs text-primary/80'>
                    {updateCheck.targetReleaseTag} on the {formatReleaseChannel(updateCheck.targetChannel)} channel
                  </div>
                ) : null}
                {updateCheck.commits && updateCheck.commits.length > 0 ? (
                  <div className='mt-2 space-y-1'>
                    <div className='text-[10px] font-medium uppercase tracking-[0.16em] text-primary/60'>Changes</div>
                    <ul className='space-y-0.5 text-xs text-primary/80'>
                      {updateCheck.commits.map((commit, index) => (
                        <li key={index} className='flex gap-1.5'>
                          <span className='shrink-0 font-mono text-[10px] text-primary/50'>{commit.sha ?? ''}</span>
                          <span>{commit.message ?? ''}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : !updateCheck.updateAvailable ? (
              <div className='flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200'>
                <CheckCircle2 className='h-4 w-4' />
                Installed version is current.
              </div>
            ) : null}

            {!updateCheck.canUpdate ? (
              <div className='system-muted-banner'>
                {updateCheck.reason}
              </div>
            ) : null}

            {updateActionError ? (
              <div className='system-feedback system-feedback-error'>
                {updateActionError}
              </div>
            ) : null}

            {updateChannelError ? (
              <div className='system-feedback system-feedback-error'>
                {updateChannelError}
              </div>
            ) : null}

            {updateProgress ? (
              <div className={cn(
                'rounded-xl border px-3 py-2 text-xs',
                getUpdateStateTone(updateProgress.status) === 'success'
                  ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                  : getUpdateStateTone(updateProgress.status) === 'error'
                    ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                    : getUpdateStateTone(updateProgress.status) === 'warning'
                      ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                      : 'border-primary/20 bg-primary/10 text-primary'
              )}>
                <div className='flex items-center gap-2'>
                  {updateProgress.isRunning ? <LoaderCircle className='h-3.5 w-3.5 animate-spin shrink-0' /> : updateProgress.status === 'succeeded' ? <CheckCircle2 className='h-3.5 w-3.5 shrink-0' /> : updateProgress.status === 'cancelled' ? <CircleAlert className='h-3.5 w-3.5 shrink-0' /> : <XCircle className='h-3.5 w-3.5 shrink-0' />}
                  {updateProgress.stage}
                </div>
                <div className='mt-1.5 opacity-90'>
                  {getUpdateProgressDetail(updateProgress)}
                </div>
                {updateProgress.percentComplete != null ? (
                  <div className='mt-3'>
                    <div className='mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] opacity-70'>
                      <span>{getUpdateProgressLabel(updateProgress)}</span>
                      <span>{updateProgress.percentComplete}%</span>
                    </div>
                    <div className='h-1.5 overflow-hidden rounded-full bg-background/40'>
                      <div className='h-full rounded-full bg-current transition-[width] duration-500 ease-out' style={{ width: `${Math.max(updateProgress.percentComplete, 4)}%` }} />
                    </div>
                  </div>
                ) : null}
                {updateProgress.isRunning && getUpdateCancellationMessage(updateProgress) ? (
                  <div className='mt-2 opacity-80'>
                    {getUpdateCancellationMessage(updateProgress)}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {updateCheck?.canUpdate && updateCheck.updateAvailable ? (
          <div className='pt-2'>
            <button
              type='button'
              disabled={updateActionPending === 'starting' || (updateProgress?.isRunning ?? false)}
              onClick={() => void onInstallUpdate()}
              className='system-button-primary w-full'
            >
              {updateActionPending === 'starting' || updateProgress?.isRunning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Download className='h-4 w-4' />}
              Install update
            </button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
