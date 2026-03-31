import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemPage } from './SystemPage';

type MatchMediaMock = MediaQueryList & {
  dispatchChange: (matches: boolean) => void;
};

function createMatchMediaMock(initialMatches: boolean): MatchMediaMock {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  return {
    get matches() {
      return matches;
    },
    media: '(max-width: 1023px)',
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: MediaQueryListEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: MediaQueryListEvent) => void);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => true,
    dispatchChange: (nextMatches: boolean) => {
      matches = nextMatches;
      const event = { matches, media: '(max-width: 1023px)' } as MediaQueryListEvent;

      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe('SystemPage', () => {
  let matchMediaMock: MatchMediaMock;

  beforeEach(() => {
    matchMediaMock = createMatchMediaMock(true);
    window.matchMedia = vi.fn().mockImplementation(() => matchMediaMock);

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/health') {
        return {
          ok: true,
          json: async () => ({
            serviceName: 'Flux Monitor',
            environmentName: 'Development',
            startupMode: 'Manual',
            startedAt: '2026-03-31T10:00:00Z',
            reportedAt: '2026-03-31T10:05:00Z',
            configuredDeviceCount: 0,
            enabledDeviceCount: 0,
            build: {
              releaseTag: 'dev-latest',
              sourceRevisionId: 'abcdef1',
              informationalVersion: '1.0.0',
              workflowRunNumber: '42',
              workflowRunAttempt: '1',
              builtAt: '2026-03-31T09:55:00Z',
            },
            systemMetrics: {
              cpuUtilizationPercent: 12,
              cpuCoreCount: 4,
              cpuMaxClockSpeedMegahertz: 1800,
              cpuCurrentClockSpeedMegahertz: 1200,
              cpuIsThrottled: false,
              processCount: 101,
              systemUptimeSeconds: 7200,
              memoryAvailableBytes: 2_000_000_000,
              memoryUsedBytes: 1_000_000_000,
              memoryTotalBytes: 3_000_000_000,
              storageUsedBytes: 4_000_000_000,
              storageTotalBytes: 8_000_000_000,
              mainFanSpeedRpm: 900,
              systemTemperatureCelsius: 42,
            },
            devices: [],
          }),
        } as Response;
      }

      if (url === '/api/database/size') {
        return {
          ok: true,
          json: async () => ({
            totalSizeBytes: 1024,
            totalSizeFormatted: '1 KB',
            tables: [],
          }),
        } as Response;
      }

      if (url === '/api/system/connectivity') {
        return {
          ok: true,
          json: async () => ({
            network: {
              supported: true,
              statusMessage: null,
              wifiPowered: true,
              hasInternetAccess: true,
              ethernetInterfaces: [],
              wifiInterfaces: [],
            },
            bluetooth: {
              supported: true,
              statusMessage: null,
              powered: true,
              devices: [],
            },
          }),
        } as Response;
      }

      if (url === '/api/system/internet-speed') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            status: 'idle',
            backend: 'ookla',
            canStart: true,
            isRunning: false,
            statusMessage: 'Ready',
            result: null,
          }),
        } as Response;
      }

      if (url === '/api/system/cloudflare-tunnel') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            statusMessage: 'Idle',
            tunnelProvider: 'cloudflared',
            hasStoredToken: false,
            configured: false,
            packageInstalled: true,
            packageVersion: '2026.3.0',
            serviceInstalled: true,
            serviceRunning: false,
            serviceEnabled: false,
            serviceLoadState: 'loaded',
            serviceActiveState: 'inactive',
            serviceSubState: 'dead',
            serviceUnitFileState: 'disabled',
            serviceResult: 'success',
          }),
        } as Response;
      }

      if (url === '/api/system/interfaces') {
        return {
          ok: true,
          json: async () => ({
            serialPorts: [],
            blockDevices: [],
            networkInterfaces: [],
          }),
        } as Response;
      }

      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('opens a system section in a narrow-screen detail view and returns to the menu', async () => {
    render(<SystemPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /resource usage/i })).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hardware interfaces/i }));

    expect(await screen.findByRole('button', { name: /^back$/i })).toBeInTheDocument();
    expect(screen.getByText(/serial ports and block devices detected on this host/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^back$/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /hardware interfaces/i })).toBeInTheDocument();
  });
});