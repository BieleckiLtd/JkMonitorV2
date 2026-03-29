import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore';
import type { UpdateProgress } from '../lib/systemUpdate';

const initialState = useAppStore.getState();

describe('useAppStore update restart recovery', () => {
  const originalLocation = window.location;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    useAppStore.setState({
      ...initialState,
      updateProgress: null,
      updateActionPending: null,
      dismissedUpdateSessionId: null,
    });
  });

  afterEach(() => {
    useAppStore.getState().disconnectUpdateProgressStream();

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

    if (originalEventSource) {
      globalThis.EventSource = originalEventSource;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as typeof globalThis & { EventSource?: typeof EventSource }).EventSource;
    }

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

  it('treats a missing final progress snapshot as restart recovery instead of clearing the overlay', async () => {
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

    const finalizingProgress: UpdateProgress = {
      sessionId: 'final123',
      status: 'running',
      isRunning: true,
      stage: 'Starting Flux Monitor…',
      detail: 'Starting the updated service and checking that it comes back online.',
      success: null,
      canCancel: false,
      cancelUnavailableReason: 'Cancellation is no longer available because Flux Monitor is already switching to the new version.',
      stepIndex: 11,
      stepCount: 11,
      percentComplete: 99,
      startedAt: '2026-03-29T12:00:00.000Z',
      updatedAt: '2026-03-29T12:00:01.000Z',
    };

    useAppStore.setState({ updateProgress: finalizingProgress });

    await useAppStore.getState().fetchUpdateProgress();

    expect(useAppStore.getState().updateProgress).toMatchObject({
      sessionId: 'final123',
      status: 'restarting',
      isRunning: true,
    });
    expect(useAppStore.getState().updateProgress?.detail).toMatch(/heartbeat|Reloading the frontend/i);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(locationReplace).toHaveBeenCalledTimes(1);
    });
  });

  it('applies pushed update progress from the event stream immediately', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];

      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
      }

      close() {
      }

      emit(payload: unknown) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
      }
    }

    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

    useAppStore.getState().connectUpdateProgressStream();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe('/api/system/update/stream');

    FakeEventSource.instances[0]?.emit({
      progress: {
        sessionId: 'pushed123',
        status: 'running',
        isRunning: true,
        stage: 'Preparing update…',
        detail: 'Flux Monitor is getting the installer ready.',
        success: null,
        canCancel: true,
        cancelUnavailableReason: null,
        stepIndex: 1,
        stepCount: 9,
        percentComplete: 8,
        startedAt: '2026-03-29T12:00:00.000Z',
        updatedAt: '2026-03-29T12:00:01.000Z',
      } satisfies UpdateProgress,
    });

    await waitFor(() => {
      expect(useAppStore.getState().updateProgress).toMatchObject({
        sessionId: 'pushed123',
        status: 'running',
        isRunning: true,
      });
    });
  });
});
