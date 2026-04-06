import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './useAppStore';
import type { UpdateProgress } from '../lib/systemUpdate';

const initialState = useAppStore.getState();

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useAppStore update restart recovery', () => {
  const originalLocation = window.location;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useRealTimers();

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
    vi.useFakeTimers();

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T11:59:00.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T12:01:30.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }));

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
    await flushPromises();

    expect(useAppStore.getState().updateProgress).toMatchObject({
      status: 'restarting',
      isRunning: true,
    });
    expect(useAppStore.getState().updateProgress?.stage).not.toBe('Update complete.');
    expect(useAppStore.getState().updateProgress?.detail).toBe(
      'Flux Monitor is restarting. The page will reload automatically when it is ready.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(locationReplace).toHaveBeenCalledTimes(1);

    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/health?nocache=');
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain('/api/health?nocache=');
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('/api/health?nocache=');
    expect(String(locationReplace.mock.calls[0]?.[0])).toContain('_reload=');
  });

  it('treats a missing final progress snapshot as restart recovery instead of clearing the overlay', async () => {
    vi.useFakeTimers();

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T11:59:00.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T12:01:30.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }));

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
    await flushPromises();

    expect(useAppStore.getState().updateProgress).toMatchObject({
      sessionId: 'final123',
      status: 'restarting',
      isRunning: true,
    });
    expect(useAppStore.getState().updateProgress?.detail).toBe(
      'Flux Monitor is restarting. The page will reload automatically when it is ready.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(locationReplace).toHaveBeenCalledTimes(1);
  });

  it('does not hard reload until the backend actually goes away or reports a new start time', async () => {
    vi.useFakeTimers();

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
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T11:59:00.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T11:59:00.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T12:01:30.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }));

    globalThis.fetch = fetchMock as typeof fetch;

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
        startedAt: '2026-03-29T12:00:00.000Z',
        updatedAt: '2026-03-29T12:00:01.000Z',
      },
    });

    await useAppStore.getState().fetchUpdateProgress();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(locationReplace).toHaveBeenCalledTimes(1);
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

  it('reconnects the update stream and refreshes the snapshot after a non-restart stream failure', async () => {
    vi.useFakeTimers();

    class FakeEventSource {
      static instances: FakeEventSource[] = [];

      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
      }
    }

    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as typeof fetch;

    useAppStore.getState().connectUpdateProgressStream();

    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0]?.onerror?.();

    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe('/api/system/update/stream');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores an older polled snapshot for the active update session', async () => {
    const currentProgress: UpdateProgress = {
      sessionId: 'steady123',
      status: 'running',
      isRunning: true,
      stage: 'Updating tunnel connector…',
      detail: 'Checking that the cloudflared package used for internet access is installed.',
      success: null,
      canCancel: false,
      cancelUnavailableReason: 'Cancellation is no longer available because the installed files are being replaced.',
      stepIndex: 6,
      stepCount: 11,
      percentComplete: 61,
      startedAt: '2026-03-29T12:00:00.000Z',
      updatedAt: '2026-03-29T12:00:10.000Z',
    };

    const staleProgress: UpdateProgress = {
      ...currentProgress,
      stage: 'Replacing installed files…',
      detail: 'Switching the app over to the new release and preserving your local configuration.',
      stepIndex: 5,
      percentComplete: 50,
      updatedAt: '2026-03-29T12:00:08.000Z',
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(staleProgress), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })) as typeof fetch;

    useAppStore.setState({ updateProgress: currentProgress });

    await useAppStore.getState().fetchUpdateProgress();

    expect(useAppStore.getState().updateProgress).toMatchObject(currentProgress);
  });

  it('does not clear a running update when a poll temporarily returns no snapshot', async () => {
    const currentProgress: UpdateProgress = {
      sessionId: 'keep1234',
      status: 'running',
      isRunning: true,
      stage: 'Verifying package…',
      detail: 'Checking that the downloaded package matches the published checksum before anything is replaced.',
      success: null,
      canCancel: true,
      cancelUnavailableReason: null,
      stepIndex: 3,
      stepCount: 11,
      percentComplete: 30,
      startedAt: '2026-03-29T12:00:00.000Z',
      updatedAt: '2026-03-29T12:00:05.000Z',
    };

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 })) as typeof fetch;

    useAppStore.setState({ updateProgress: currentProgress });

    await useAppStore.getState().fetchUpdateProgress();

    expect(useAppStore.getState().updateProgress).toMatchObject(currentProgress);
  });

  it('treats a terminal success snapshot as restart recovery until heartbeat reload completes', async () => {
    vi.useFakeTimers();

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
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sessionId: 'success123',
        status: 'succeeded',
        isRunning: false,
        stage: 'Update complete.',
        detail: 'Flux Monitor finished installing the update.',
        success: true,
        canCancel: false,
        cancelUnavailableReason: null,
        stepIndex: 11,
        stepCount: 11,
        percentComplete: 100,
        startedAt: '2026-03-29T12:00:00.000Z',
        updatedAt: '2026-03-29T12:00:40.000Z',
      } satisfies UpdateProgress), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T11:59:00.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ startedAt: '2026-03-29T12:01:30.000Z' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      }));

    globalThis.fetch = fetchMock as typeof fetch;

    useAppStore.setState({
      updateProgress: {
        sessionId: 'success123',
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
        updatedAt: '2026-03-29T12:00:35.000Z',
      },
    });

    await useAppStore.getState().fetchUpdateProgress();
    await flushPromises();

    expect(useAppStore.getState().updateProgress).toMatchObject({
      sessionId: 'success123',
      status: 'restarting',
      isRunning: true,
    });
    expect(useAppStore.getState().updateProgress?.detail).toBe(
      'Flux Monitor is restarting. The page will reload automatically when it is ready.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(locationReplace).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1500);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(locationReplace).toHaveBeenCalledTimes(1);
    expect(String(locationReplace.mock.calls[0]?.[0])).toContain('_reload=');
  });
});

describe('useAppStore theme application', () => {
  const originalThemeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      if (originalThemeColor === null) {
        meta.removeAttribute('content');
      } else {
        meta.setAttribute('content', originalThemeColor);
      }
    }
  });

  it('applies the active theme id and mode to the document root', () => {
    useAppStore.getState().setActiveThemeId('tactical-slate');

    expect(useAppStore.getState().activeThemeId).toBe('tactical-slate');
    expect(document.documentElement.dataset.theme).toBe('tactical-slate');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('#c5ff41');
    expect(localStorage.getItem('FluxMonitor-theme')).toBe('tactical-slate');
  });

  it('switches the document root back to a light theme when selected', () => {
    useAppStore.getState().setActiveThemeId('ocean-light');

    expect(document.documentElement.dataset.theme).toBe('ocean-light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#f8fafc');
  });
});
