import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SystemPage } from './SystemPage';
import { AppBarProvider } from '../components/AppBar';

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
      <AppBarProvider>
        <Routes>
          <Route path='/system' element={<SystemPage />} />
          <Route path='/system/theme' element={<div>Theme page</div>} />
          <Route path='/system/notifications' element={<div>Notifications page</div>} />
          <Route path='/system/:sectionId' element={<SystemPage />} />
        </Routes>
        <LocationDisplay />
      </AppBarProvider>
    </MemoryRouter>
  );
}

describe('SystemPage', () => {
  let matchMediaMock: MatchMediaMock;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', undefined);
    matchMediaMock = createMatchMediaMock(true);
    window.matchMedia = vi.fn().mockImplementation(() => matchMediaMock);

    let localAccessEnabled = false;
    let localAccessActive = false;
    let localAccessPassword: string | null = null;
    let sshEnabled = false;
    let sshActive = false;
    const localAccessHostName = 'fluxmonitor';
    const localAccessHotspotName = 'FluxMonitor-test';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
            rawSecondsWindowMinutes: 10,
            persistedBucketMinutes: 5,
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
              wifiInterfaces: [
                {
                  name: 'wlan0',
                  description: 'Wireless adapter',
                  status: 'up',
                  macAddress: 'AA:BB:CC:DD:EE:FF',
                  addresses: localAccessActive ? ['192.168.42.1'] : ['192.168.1.25'],
                  speedMbps: 72,
                  connectionName: localAccessActive ? 'fluxmonitor-direct-wifi' : 'Home Mesh',
                  connectionState: localAccessActive ? 'activated' : 'connected',
                  connectedSsid: localAccessActive ? null : 'Home Mesh',
                  connectedBssid: localAccessActive ? null : 'AA:AA:AA:AA:AA:AA',
                  signalPercent: localAccessActive ? null : 78,
                  security: localAccessActive ? null : 'WPA2',
                  signalBars: localAccessActive ? null : '▂▄▆█',
                },
              ],
            },
            bluetooth: {
              supported: true,
              statusMessage: null,
              powered: true,
              devices: [],
            },
            ssh: {
              supported: true,
              enabled: sshEnabled,
              active: sshActive,
              statusMessage: sshActive
                ? sshEnabled
                  ? 'SSH is enabled and accepting remote terminal connections.'
                  : 'SSH is running, but it will not start automatically after reboot.'
                : 'SSH is off.',
              serviceLoadState: 'loaded',
              serviceActiveState: sshActive ? 'active' : 'inactive',
              serviceSubState: sshActive ? 'running' : 'dead',
              serviceUnitFileState: sshEnabled ? 'enabled' : 'disabled',
              serviceResult: 'success',
            },
            directAccess: {
              settings: {
                storageAvailable: true,
                autoStartMode: localAccessEnabled ? 'when-wifi-not-connected' : 'off',
                wifiPassword: localAccessPassword,
              },
              mode: {
                supported: true,
                enabled: localAccessEnabled,
                active: localAccessActive,
                hostName: localAccessHostName,
                statusMessage: localAccessActive ? 'Local access mode is active.' : localAccessEnabled ? 'Local access mode is ready if Wi-Fi drops.' : 'Local access mode is off.',
                hotspotName: localAccessHotspotName,
                hotspotPassword: localAccessPassword,
                addresses: localAccessActive ? ['192.168.42.1'] : [],
              },
              wifi: {
                supported: true,
                enabled: localAccessActive,
                statusMessage: localAccessActive ? 'Local access hotspot is active.' : "Turning this on will disconnect 'Home Mesh' and move Wi-Fi onto the Raspberry Pi hotspot.",
                interfaceName: 'wlan0',
                currentNetworkName: localAccessActive ? null : 'Home Mesh',
                disconnectsCurrentWifi: !localAccessActive,
                ssid: localAccessHotspotName,
                addresses: localAccessActive ? ['192.168.42.1'] : [],
              },
              bluetooth: {
                supported: true,
                enabled: localAccessActive,
                statusMessage: localAccessActive ? 'Local access Bluetooth is active.' : 'Keeps the Raspberry Pi on its current network while nearby devices connect over Bluetooth PAN.',
                interfaceName: 'btnap0',
                deviceName: 'FluxMonitor Pi',
                requiresPairing: true,
                discoverable: localAccessActive,
                pairable: localAccessActive,
                addresses: localAccessActive ? ['192.168.42.2'] : [],
              },
            },
          }),
        } as Response;
      }

      if (url === '/api/system/ssh') {
        const body = typeof init?.body === 'string'
          ? JSON.parse(init.body) as { enabled?: boolean }
          : null;

        sshEnabled = Boolean(body?.enabled);
        sshActive = Boolean(body?.enabled);

        return {
          ok: true,
          json: async () => ({
            success: true,
            enabled: sshEnabled,
            active: sshActive,
            message: sshEnabled ? 'SSH was enabled.' : 'SSH was disabled.',
          }),
        } as Response;
      }

      if (url === '/api/system/local-access-mode') {
        localAccessEnabled = true;
        localAccessActive = true;
        return {
          ok: true,
          json: async () => ({
            success: true,
            enabled: true,
            active: true,
            message: 'Local access mode is on.',
          }),
        } as Response;
      }

      if (url === '/api/system/local-access-mode/advanced') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            message: 'Local access settings were saved.',
            settings: {
              storageAvailable: true,
              autoStartMode: localAccessEnabled ? 'when-wifi-not-connected' : 'off',
              wifiPassword: localAccessPassword,
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

    const root = container.querySelector('.flex.min-h-full.flex-1.flex-col.overflow-hidden') as HTMLElement | null;
    if (!root) {
      throw new Error('Expected the system page root to render.');
    }

    const logsCard = container.querySelector('[data-slot="card"]');
    if (!logsCard) {
      throw new Error('Expected the logs panel card to render.');
    }

    expect(logsCard).toHaveClass('flex-1');
    expect(screen.queryByText(/application logs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/browse captured log entries filtered by severity and time range/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('location-display')).toHaveTextContent('/system/logs');
  });

  it('toggles local access mode from the unified connectivity section', async () => {
    renderSystemPage('/system/connectivity');

    fireEvent.click(await screen.findByRole('button', { name: /local access mode/i }));

    expect(await screen.findByText(/lets you connect to the device if it loses connection to the wi-fi router/i)).toBeInTheDocument();
    expect(screen.queryByText(/^hostname$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /toggle local access mode/i }));

    await waitFor(() => {
      expect(screen.getByText(/local access mode is on/i)).toBeInTheDocument();
    });

    expect(screen.getByText(/^hostname$/i)).toBeInTheDocument();
    expect(screen.getAllByText(/fluxmonitor.local/i).length).toBeGreaterThan(0);
    expect(screen.getByText('192.168.42.1')).toBeInTheDocument();
    expect(screen.getByText('FluxMonitor-test')).toBeInTheDocument();
    expect(screen.getByText(/no password/i)).toBeInTheDocument();
  });

  it('toggles ssh access from the unified connectivity section', async () => {
    renderSystemPage('/system/connectivity');

    expect(await screen.findByText(/enable secure remote terminal access to this device/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: /toggle ssh access/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/ssh', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    expect(await screen.findByText(/ssh was enabled/i)).toBeInTheDocument();
    expect(screen.getByText(/enabled and running/i)).toBeInTheDocument();
  });

  it('saves local access advanced settings from the unified connectivity section', async () => {
    const baseFetch = globalThis.fetch;
    let localAccessPassword: string | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/system/connectivity') {
        const response = await baseFetch(input, init);
        const data = await response.json() as Record<string, unknown>;
        const directAccess = data.directAccess as Record<string, unknown>;
        const settings = directAccess.settings as Record<string, unknown>;
        const mode = directAccess.mode as Record<string, unknown>;

        return {
          ok: true,
          json: async () => ({
            ...data,
            directAccess: {
              ...directAccess,
              settings: {
                ...settings,
                wifiPassword: localAccessPassword,
              },
              mode: {
                ...mode,
                hotspotPassword: localAccessPassword,
              },
            },
          }),
        } as Response;
      }

      if (url === '/api/system/local-access-mode/advanced' && init?.method === 'POST') {
        localAccessPassword = 'abc';

        return {
          ok: true,
          json: async () => ({
            success: true,
            message: 'Local access settings were saved.',
            settings: {
              storageAvailable: true,
              autoStartMode: 'off',
              wifiPassword: localAccessPassword,
            },
          }),
        } as Response;
      }

      return baseFetch(input, init);
    });

    globalThis.fetch = fetchMock as typeof fetch;

    renderSystemPage('/system/connectivity');

    fireEvent.click(await screen.findByRole('button', { name: /local access mode/i }));

    fireEvent.click(await screen.findByRole('button', { name: /^advanced$/i }));

    const passwordInput = screen.getByLabelText(/local access hotspot password/i);
    fireEvent.change(passwordInput, { target: { value: 'abc' } });

    fireEvent.click(screen.getByRole('button', { name: /save local access settings/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/system/local-access-mode/advanced', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const postCall = fetchMock.mock.calls.find(([input, init]) =>
      input === '/api/system/local-access-mode/advanced' && init && typeof init === 'object' && init.method === 'POST');

    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      wifiPassword: 'abc',
    });

    expect(await screen.findByText(/local access settings were saved/i)).toBeInTheDocument();
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
            message: 'Database settings were saved and applied immediately.',
            settings: {
              rawSecondsWindowMinutes: 10,
              persistedBucketMinutes: 30,
            },
          }),
        } as Response;
      }

      return baseFetch(input, init);
    });

    globalThis.fetch = fetchMock as typeof fetch;

    renderSystemPage('/system/database');

    expect(await screen.findByText(/temporary history stays in memory at the device's raw poll cadence/i)).toBeInTheDocument();
    expect(screen.getByText(/larger temporary memory windows use more ram/i)).toBeInTheDocument();
    expect(screen.getByText(/smaller persisted buckets capture more detail, but they also grow the database faster/i)).toBeInTheDocument();
    expect(screen.queryByText(/storage provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/database status/i)).not.toBeInTheDocument();

    const persistedBucketSelect = await screen.findByRole('combobox', { name: /persisted bucket minutes/i });
    fireEvent.click(persistedBucketSelect);
    await screen.findByRole('listbox');
    const option = await screen.findByRole('option', { name: '30 min' });
    fireEvent.mouseMove(option);
    fireEvent.click(option);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

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
      persistedBucketMinutes: 30,
      restartApplication: false,
    });

    expect(await screen.findByText(/database settings were saved and applied immediately/i)).toBeInTheDocument();
    expect(screen.getByText(/30m persisted buckets stored forever in the database/i)).toBeInTheDocument();
  });
});
