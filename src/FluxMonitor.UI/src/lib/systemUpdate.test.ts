import { describe, expect, it } from 'vitest';
import {
  getUpdateCancellationMessage,
  getUpdateProgressDetail,
  getUpdateProgressLabel,
  type UpdateProgress,
} from './systemUpdate';

function createProgress(overrides: Partial<UpdateProgress> = {}): UpdateProgress {
  return {
    sessionId: 'progress123',
    status: 'running',
    isRunning: true,
    stage: 'Downloading update…',
    detail: 'Downloading the published release package from GitHub.',
    success: null,
    canCancel: true,
    cancelUnavailableReason: null,
    stepIndex: 2,
    stepCount: 11,
    percentComplete: 18,
    startedAt: '2026-04-06T09:00:00.000Z',
    updatedAt: '2026-04-06T09:00:05.000Z',
    ...overrides,
  };
}

describe('systemUpdate display helpers', () => {
  it('simplifies restart detail copy for the UI', () => {
    const progress = createProgress({
      status: 'restarting',
      stage: 'Restarting Flux Monitor…',
      detail: 'Waiting for the heartbeat before reloading the frontend.',
      canCancel: false,
    });

    expect(getUpdateProgressDetail(progress)).toBe(
      'Flux Monitor is restarting. The page will reload automatically when it is ready.',
    );
  });

  it('includes the current stage in the progress label', () => {
    const progress = createProgress({
      stage: 'Restarting Flux Monitor…',
      stepIndex: 11,
      stepCount: 11,
    });

    expect(getUpdateProgressLabel(progress)).toBe('Step 11 of 11 - Restarting Flux Monitor…');
  });

  it('uses an informational lock message once cancellation is no longer available', () => {
    const finalizingProgress = createProgress({
      status: 'restarting',
      stage: 'Restarting Flux Monitor…',
      canCancel: false,
      cancelUnavailableReason: 'The update has already been installed and the service is restarting.',
    });

    const cancellingProgress = createProgress({
      status: 'cancelling',
      stage: 'Cancelling update…',
      canCancel: false,
      cancelUnavailableReason: 'Cancellation is already being processed.',
    });

    expect(getUpdateCancellationMessage(finalizingProgress)).toBe(
      'Update is now being applied and can no longer be cancelled.',
    );
    expect(getUpdateCancellationMessage(cancellingProgress)).toBe('Cancellation is already being processed.');
  });
});
