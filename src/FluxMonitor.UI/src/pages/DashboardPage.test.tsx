import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';

describe('DashboardPage', () => {
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

  it('applies pushed runtime status from the SSE stream', async () => {
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
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      serviceName: 'FluxMonitor.Backend',
      environmentName: 'Development',
      startupMode: 'Hardware',
      startedAt: '2026-04-10T10:00:00Z',
      reportedAt: '2026-04-10T10:00:00Z',
      configuredDeviceCount: 0,
      enabledDeviceCount: 0,
      devices: [],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    render(<DashboardPage />);

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    FakeEventSource.instances[0]?.emit({
      status: {
        serviceName: 'FluxMonitor.Backend',
        environmentName: 'Production',
        startupMode: 'Hardware',
        startedAt: '2026-04-10T10:00:00Z',
        reportedAt: '2026-04-10T10:00:00.500Z',
        configuredDeviceCount: 1,
        enabledDeviceCount: 1,
        systemMetrics: {
          cpuUtilizationPercent: 12,
          memoryUsedBytes: 1000,
          memoryTotalBytes: 2000,
          storageUsedBytes: 3000,
          storageTotalBytes: 6000,
        },
        devices: [
          {
            deviceId: 'device-1',
            displayName: 'Battery 1',
            protocol: 'modbus',
            enabled: true,
            isMaster: true,
            pollIntervalMilliseconds: 1000,
            lastOutcome: 'Succeeded',
            latestTelemetry: null,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getAllByText('Production').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Battery 1')).toBeInTheDocument();
    expect(screen.getAllByText('12%').length).toBeGreaterThan(0);
  });
});
