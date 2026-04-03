import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
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

function LocationDisplay() {
  const location = useLocation();
  return <div data-testid='location-display'>{location.pathname}</div>;
}

function renderSystemPage(initialEntry = '/system') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path='/system' element={<SystemPage />} />
        <Route path='/system/theme' element={<div>Theme page</div>} />
        <Route path='/system/notifications' element={<div>Notifications page</div>} />
        <Route path='/system/:sectionId' element={<SystemPage />} />
      </Routes>
      <LocationDisplay />
    </MemoryRouter>
  );
}

describe('SystemPage', () => {
  let matchMediaMock: MatchMediaMock;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', undefined);
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

      if (url === '/api/database/settings') {
        return {
          ok: true,
          json: async () => ({
            environmentName: 'Development',
            storageProvider: 'TimescaleDb',
            databaseConfigured: true,
            rawSecondsWindowMinutes: 10,
            oneMinuteWindowHours: 1,
            fiveMinuteWindowDays: 7,
            compressAfterMinutes: 60,
            canAutoRestart: false,
            applyMessage: 'Settings can be saved here, but this environment still needs a manual restart to apply them.',
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

      if (url.startsWith('/api/logs?')) {
        return {
          ok: true,
          json: async () => ({
            entries: [],
            totalCount: 0,
          }),
        } as Response;
      }

      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('treats the system menu as its own page and navigates back from a section detail', async () => {
    renderSystemPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /resource usage/i })).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /hardware interfaces/i }));

    expect(await screen.findByRole('button', { name: /^back$/i })).toBeInTheDocument();
    expect(screen.getByText(/serial ports and block devices detected on this host/i)).toBeInTheDocument();
    expect(screen.getByTestId('location-display')).toHaveTextContent('/system/hardware-interfaces');

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/serial ports and block devices detected on this host/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hardware interfaces/i })).toBeInTheDocument();
    expect(screen.getByTestId('location-display')).toHaveTextContent('/system');
  });

  it('opens system subpages from the system menu', async () => {
    renderSystemPage();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /theme/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /theme/i }));

    await waitFor(() => {
      expect(screen.getByText('Theme page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('location-display')).toHaveTextContent('/system/theme');
  });

  it('loads the matching section from a direct system child route', async () => {
    const { container } = renderSystemPage('/system/logs');

    expect(await screen.findByRole('button', { name: /^back$/i })).toBeInTheDocument();

    const root = container.firstElementChild as HTMLElement | null;
    if (!root) {
      throw new Error('Expected the system page root to render.');
    }

    expect(root).toHaveClass('flex', 'min-h-full', 'flex-1', 'flex-col', 'overflow-hidden');

    const logsCard = container.querySelector('[data-slot="card"]');
    if (!logsCard) {
      throw new Error('Expected the logs panel card to render.');
    }

    expect(logsCard).toHaveClass('flex-1');
    expect(screen.queryByText(/application logs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/browse captured log entries filtered by severity and time range/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('location-display')).toHaveTextContent('/system/logs');
  });

  it('posts database retention changes from the database section', async () => {
    const baseFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/database/settings' && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            restartScheduled: false,
            message: 'Database retention settings were saved. Restart the app to apply them.',
            settings: {
              environmentName: 'Development',
              storageProvider: 'TimescaleDb',
              databaseConfigured: true,
              rawSecondsWindowMinutes: 10,
              oneMinuteWindowHours: 8760,
              fiveMinuteWindowDays: 0,
              compressAfterMinutes: 1440,
              canAutoRestart: false,
              applyMessage: 'Settings can be saved here, but this environment still needs a manual restart to apply them.',
            },
          }),
        } as Response;
      }

      return baseFetch(input, init);
    });

    globalThis.fetch = fetchMock as typeof fetch;

    renderSystemPage('/system/database');

    const oneMinuteInput = await screen.findByLabelText(/1-minute rollup hours/i);
    fireEvent.change(oneMinuteInput, { target: { value: '8760' } });
    fireEvent.change(screen.getByLabelText(/5-minute rollup days/i), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/compression after minutes/i), { target: { value: '1440' } });

    fireEvent.click(screen.getByRole('button', { name: /save policy/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/database/settings', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const postCall = fetchMock.mock.calls.find(([input, init]) =>
      input === '/api/database/settings' && init && typeof init === 'object' && init.method === 'POST');

    expect(postCall).toBeTruthy();
    expect(postCall?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      rawSecondsWindowMinutes: 10,
      oneMinuteWindowHours: 8760,
      fiveMinuteWindowDays: 0,
      compressAfterMinutes: 1440,
      restartApplication: true,
    });

    expect(await screen.findByText(/database retention settings were saved/i)).toBeInTheDocument();
  });
});
