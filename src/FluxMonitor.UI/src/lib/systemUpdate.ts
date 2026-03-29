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
