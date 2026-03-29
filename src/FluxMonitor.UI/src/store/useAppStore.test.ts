import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore';
import type { UpdateProgress } from '../lib/systemUpdate';

const initialState = useAppStore.getState();

describe('useAppStore update restart recovery', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    useAppStore.setState({
      ...initialState,
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });
  });

  afterEach(() => {
    useAppStore.setState({
      ...initialState,
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });

    vi.restoreAllMocks();
  });

  it('keeps the update locked during restart until heartbeat recovery triggers a hard reload', async () => {
    const locationReplace = vi.fn();

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: 'http://localhost/system',
        replace: locationReplace,
      },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    globalThis.fetch = fetchMock as typeof fetch;

    const restartingProgress: UpdateProgress = {
      sessionId: 'abcd1234',
      status: 'restarting',
      isRunning: true,
      stage: 'Restarting Flux Monitor…',
      detail: 'The new version is installed. The service is restarting now.',
      success: null,
      canCancel: false,
      cancelUnavailableReason: 'The update has already been installed and the service is restarting.',
      stepIndex: 9,
      stepCount: 9,
      percentComplete: 100,
      startedAt: '2026-03-29T12:00:00.000Z',
      updatedAt: '2026-03-29T12:00:01.000Z',
    };

    useAppStore.setState({ updateProgress: restartingProgress });

    await useAppStore.getState().fetchUpdateProgress();

    expect(useAppStore.getState().updateProgress).toMatchObject({
      status: 'restarting',
      isRunning: true,
    });
    expect(useAppStore.getState().updateProgress?.stage).not.toBe('Update complete.');
    expect(useAppStore.getState().updateProgress?.detail).toMatch(/heartbeat|Reloading the frontend/i);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(locationReplace).toHaveBeenCalledTimes(1);
    });

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/health?nocache=');
    expect(String(locationReplace.mock.calls[0]?.[0])).toContain('_reload=');
  });
});
