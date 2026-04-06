import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateLockOverlay } from './UpdateLockOverlay';
import { useAppStore } from '../store/useAppStore';

const initialState = useAppStore.getState();

describe('UpdateLockOverlay', () => {
  beforeEach(() => {
    useAppStore.setState({
      ...initialState,
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState({
      ...initialState,
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });
  });

  it('renders restart progress with the simplified hierarchy and copy', () => {
    useAppStore.setState({
      updateProgress: {
        sessionId: 'restart123',
        status: 'restarting',
        isRunning: true,
        stage: 'Restarting Flux Monitor…',
        detail: 'The new version is installed. The service is restarting now.',
        success: null,
        canCancel: false,
        cancelUnavailableReason: 'The update has already been installed and the service is restarting.',
        stepIndex: 11,
        stepCount: 11,
        percentComplete: 100,
        startedAt: '2026-04-06T09:00:00.000Z',
        updatedAt: '2026-04-06T09:00:05.000Z',
      },
    });

    render(<UpdateLockOverlay />);

    expect(screen.getByText('Software update in progress')).toBeInTheDocument();
    expect(screen.getByText('Restarting Flux Monitor…')).toBeInTheDocument();
    expect(screen.getByText('Flux Monitor is restarting. The page will reload automatically when it is ready.')).toBeInTheDocument();
    expect(screen.getByText('Step 11 of 11 - Restarting Flux Monitor…')).toBeInTheDocument();
    expect(screen.getByText('Update is now being applied and can no longer be cancelled.')).toBeInTheDocument();
    expect(screen.queryByText(/heartbeat/i)).not.toBeInTheDocument();
  });
});
