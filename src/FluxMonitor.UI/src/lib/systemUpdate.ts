export type UpdateProgressStatus =
  | 'running'
  | 'cancelling'
  | 'restarting'
  | 'cancelled'
  | 'failed'
  | 'succeeded';

export type UpdateProgress = {
  sessionId: string;
  status: UpdateProgressStatus;
  isRunning: boolean;
  stage: string;
  detail: string;
  success?: boolean | null;
  canCancel: boolean;
  cancelUnavailableReason?: string | null;
  stepIndex?: number | null;
  stepCount?: number | null;
  percentComplete?: number | null;
  startedAt: string;
  updatedAt: string;
};

export type UpdateActionResult = {
  ok: boolean;
  error?: string;
};

const defaultCancelableUpdateMessage = 'You can cancel now if you need to stop the update. Flux Monitor will keep the current installed version.';
const defaultLockedUpdateMessage = 'Update is now being applied and can no longer be cancelled.';
const restartingUpdateDetail = 'Flux Monitor is restarting. The page will reload automatically when it is ready.';

export function isTerminalUpdateStatus(status: UpdateProgressStatus): boolean {
  return status === 'cancelled' || status === 'failed' || status === 'succeeded';
}

export function getUpdateStateTone(status: UpdateProgressStatus): 'info' | 'warning' | 'success' | 'error' {
  if (status === 'failed') {
    return 'error';
  }

  if (status === 'cancelled') {
    return 'warning';
  }

  if (status === 'succeeded') {
    return 'success';
  }

  return 'info';
}

export function getUpdateProgressDetail(progress: UpdateProgress): string {
  if (progress.status === 'restarting') {
    return restartingUpdateDetail;
  }

  return progress.detail;
}

export function getUpdateProgressLabel(progress: UpdateProgress): string {
  const prefix = progress.stepIndex && progress.stepCount
    ? `Step ${progress.stepIndex} of ${progress.stepCount}`
    : 'Progress';

  return progress.stage ? `${prefix} - ${progress.stage}` : prefix;
}

export function getUpdateCancellationMessage(progress: UpdateProgress): string | null {
  if (!progress.isRunning) {
    return null;
  }

  if (progress.canCancel) {
    return defaultCancelableUpdateMessage;
  }

  if (progress.status === 'cancelling') {
    return progress.cancelUnavailableReason ?? 'Cancellation is already being processed.';
  }

  return defaultLockedUpdateMessage;
}
