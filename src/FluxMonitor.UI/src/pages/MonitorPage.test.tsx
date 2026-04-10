import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorPage } from './MonitorPage';

vi.mock('../hooks/useDeviceDefinition', () => ({
  useDeviceDefinition: () => null,
}));

describe('MonitorPage', () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();

    if (originalEventSource) {
      globalThis.EventSource = originalEventSource;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as typeof globalThis & { EventSource?: typeof EventSource }).EventSource;
    }

    vi.restoreAllMocks();
  });

  it('applies pushed device snapshots from the SSE stream', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];

      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
      }

      emit(payload: unknown) {
        this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
      }
    }

    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    render(<MonitorPage />);

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    expect(FakeEventSource.instances[0]?.url).toBe('/api/devices/current/stream');

    FakeEventSource.instances[0]?.emit({
      devices: [
        {
          deviceId: 'device-1',
          displayName: 'Battery 1',
          definitionId: 'jk-inverter-bms',
          enabled: true,
          isMaster: true,
          pollIntervalMilliseconds: 500,
          lastOutcome: 'Succeeded',
          latestTelemetry: null,
        },
      ],
    });

    expect(await screen.findByText('Battery 1')).toBeInTheDocument();
    expect(screen.getByText(/device-1/i)).toBeInTheDocument();
  });

  it('reconnects the SSE stream after an error and refreshes the latest snapshot', async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];

      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {
        FakeEventSource.instances.push(this);
      }
    }

    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

    const fetchMock = vi.fn()
      .mockResolvedValue(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    render(<MonitorPage />);
    await screen.findByText(/no devices configured/i);

    expect(FakeEventSource.instances).toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    FakeEventSource.instances[0]?.onerror?.();

    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 2100));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]?.url).toBe('/api/devices/current/stream');
  }, 10000);
});
