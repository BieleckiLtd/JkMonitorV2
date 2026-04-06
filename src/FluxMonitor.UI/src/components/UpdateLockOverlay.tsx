import { AlertTriangle, CheckCircle2, LoaderCircle, ShieldAlert, XCircle } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import { getUpdateCancellationMessage, getUpdateProgressDetail, getUpdateProgressLabel, getUpdateStateTone } from '../lib/systemUpdate';
import { useAppStore } from '../store/useAppStore';

export function UpdateLockOverlay() {
  const progress = useAppStore((state) => state.updateProgress);
  const updateActionPending = useAppStore((state) => state.updateActionPending);
  const cancelSystemUpdate = useAppStore((state) => state.cancelSystemUpdate);
  const dismissUpdateNotice = useAppStore((state) => state.dismissUpdateNotice);

  if (!progress) {
    return null;
  }

  const tone = getUpdateStateTone(progress.status);
  const blocking = progress.isRunning;
  const icon = progress.isRunning
    ? <LoaderCircle className='h-5 w-5 animate-spin' />
    : progress.status === 'succeeded'
      ? <CheckCircle2 className='h-5 w-5' />
      : progress.status === 'cancelled'
        ? <ShieldAlert className='h-5 w-5' />
        : <XCircle className='h-5 w-5' />;

  const panelClassName = tone === 'success'
    ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-100'
    : tone === 'error'
      ? 'border-rose-500/25 bg-rose-500/10 text-rose-100'
      : tone === 'warning'
        ? 'border-amber-500/25 bg-amber-500/10 text-amber-100'
        : 'border-primary/25 bg-card/96 text-foreground';
  const cancellationMessage = getUpdateCancellationMessage(progress);
  const canCancel = progress.isRunning && progress.canCancel;
  const showLockedMessage = progress.isRunning && !progress.canCancel;

  return (
    <div className={cn(
      'fixed inset-0 z-[70] flex items-center justify-center px-4',
      blocking ? 'bg-background/94' : 'bg-background/88',
    )}>
      <div className={cn('w-full max-w-lg rounded-3xl border p-5 shadow-2xl', panelClassName)}>
        <div className='flex items-start gap-3'>
          <div className={cn(
            'mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl',
            tone === 'success'
              ? 'bg-emerald-500/18 text-emerald-200'
              : tone === 'error'
                ? 'bg-rose-500/18 text-rose-200'
                : tone === 'warning'
                  ? 'bg-amber-500/18 text-amber-200'
                  : 'bg-primary/12 text-primary',
          )}>
            {icon}
          </div>
          <div className='min-w-0 flex-1'>
            <div className='text-base font-semibold'>
              {blocking ? 'Software update in progress' : 'Software update status'}
            </div>
            <div className='mt-1 text-sm font-medium text-foreground/90'>
              {progress.stage}
            </div>
            <div className='mt-2 text-sm text-muted-foreground'>
              {getUpdateProgressDetail(progress)}
            </div>
          </div>
        </div>

        {progress.percentComplete != null ? (
          <div className='mt-5'>
            <div className='mb-2 flex items-center justify-between gap-3 text-xs uppercase tracking-[0.18em] text-muted-foreground'>
              <span>{getUpdateProgressLabel(progress)}</span>
              <span>{progress.percentComplete}%</span>
            </div>
            <div className='h-2 overflow-hidden rounded-full bg-background/50'>
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-500 ease-out',
                  tone === 'success'
                    ? 'bg-emerald-400'
                    : tone === 'error'
                      ? 'bg-rose-400'
                      : tone === 'warning'
                        ? 'bg-amber-400'
                        : 'bg-primary',
                )}
                style={{ width: `${Math.max(progress.percentComplete, 6)}%` }}
              />
            </div>
          </div>
        ) : null}

        {blocking && cancellationMessage ? (
          <div className={cn(
            'mt-4 rounded-2xl px-3 py-2 text-xs',
            showLockedMessage
              ? 'border border-border/40 bg-background/20 text-muted-foreground'
              : 'border border-border/60 bg-background/35 text-muted-foreground',
          )}>
            {cancellationMessage}
          </div>
        ) : null}

        <div className='mt-5 flex justify-end gap-2'>
          {canCancel ? (
            <Button
              type='button'
              variant='destructive'
              onClick={() => void cancelSystemUpdate()}
              disabled={updateActionPending === 'cancelling'}
            >
              {updateActionPending === 'cancelling' ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <AlertTriangle className='h-4 w-4' />}
              Cancel update
            </Button>
          ) : null}

          {!blocking ? (
            <Button type='button' onClick={dismissUpdateNotice}>
              Close
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
