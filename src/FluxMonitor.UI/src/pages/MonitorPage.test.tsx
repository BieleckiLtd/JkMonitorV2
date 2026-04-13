import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorPage } from './MonitorPage';
import type { DeviceDefinition } from '../types/deviceDefinition';

const { useDeviceDefinitionMock } = vi.hoisted(() => ({
  useDeviceDefinitionMock: vi.fn<() => DeviceDefinition | null>(),
}));

vi.mock('../hooks/useDeviceDefinition', () => ({
  useDeviceDefinition: useDeviceDefinitionMock,
}));

describe('MonitorPage', () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    vi.useRealTimers();
    useDeviceDefinitionMock.mockReturnValue(null);
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

  it('renders devices in the order provided by the runtime snapshot', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        deviceId: 'device-2',
        displayName: 'Battery 2',
        sortOrder: 0,
        definitionId: 'jk-inverter-bms',
        enabled: true,
        isMaster: false,
        pollIntervalMilliseconds: 500,
        lastOutcome: 'Succeeded',
        latestTelemetry: null,
      },
      {
        deviceId: 'device-1',
        displayName: 'Battery 1',
        sortOrder: 1,
        definitionId: 'jk-inverter-bms',
        enabled: true,
        isMaster: true,
        pollIntervalMilliseconds: 500,
        lastOutcome: 'Succeeded',
        latestTelemetry: null,
      },
    ]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    class FakeEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {}
    }

    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

    render(<MonitorPage />);

    const battery2 = await screen.findByText('Battery 2');
    const battery1 = await screen.findByText('Battery 1');

    expect(battery2.compareDocumentPosition(battery1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows environment device last seen, signal, and battery icon tooltips in the header order', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-12T12:00:02.000Z').getTime());

    useDeviceDefinitionMock.mockReturnValue({
      version: '1',
      device: {
        id: 'govee-thermo-hygrometer-ble',
        name: 'Govee',
        manufacturer: 'Govee',
        model: 'H5075',
        category: 'environment',
      },
      connection: {
        transport: { type: 'ble', defaults: {} },
        protocol: { type: 'ble-advertisement', settings: {} },
      },
      dataSources: [],
      pollGroups: {},
      entities: [
        {
          id: 'temperature_c',
          type: 'number',
          name: 'Temperature',
          category: 'Environment',
          source: { bank: 'advertisement', byteOffset: 0, unit: 'C' },
          display: { precision: 1 },
        },
        {
          id: 'humidity_pct',
          type: 'number',
          name: 'Humidity',
          category: 'Environment',
          source: { bank: 'advertisement', byteOffset: 0, unit: '%' },
          display: { precision: 1 },
        },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            sections: [
              {
                type: 'hero-metrics',
                metrics: [
                  { entity: 'temperature_c', color: 'amber' },
                  { entity: 'humidity_pct', color: 'blue' },
                ],
              },
            ],
          },
        },
      },
    } satisfies DeviceDefinition);

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

    FakeEventSource.instances[0]?.emit({
      devices: [
        {
          deviceId: 'govee-1',
          displayName: 'GVH5075_47C0',
          definitionId: 'govee-thermo-hygrometer-ble',
          enabled: true,
          isMaster: true,
          pollIntervalMilliseconds: 1000,
          lastOutcome: 'Succeeded',
          latestTelemetry: {
            collectedAt: '2026-04-12T12:00:00.000Z',
            cells: [],
            activeWarnings: [],
            parameters: [
              { key: 'battery_pct', displayName: 'Battery', category: 'Status', numericValue: 88, sortOrder: 0, unit: '%' },
              { key: 'signal_strength_pct', displayName: 'Signal', category: 'Status', numericValue: 64, sortOrder: 1, unit: '%' },
              { key: 'temperature_c', displayName: 'Temperature', category: 'Environment', numericValue: 14.9, sortOrder: 2, unit: 'C' },
              { key: 'humidity_pct', displayName: 'Relative Humidity', category: 'Environment', numericValue: 75.5, sortOrder: 3, unit: '%' },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('GVH5075_47C0')).toBeInTheDocument();
    const lastSeenIcon = screen.getByTitle('Last seen less than a minute ago (2026-04-12T12:00:00.000Z)');
    const signalIcon = screen.getByTitle('Signal 64%');
    const batteryIcon = screen.getByTitle('Battery 88%');

    expect(lastSeenIcon).toBeInTheDocument();
    expect(signalIcon).toBeInTheDocument();
    expect(batteryIcon).toBeInTheDocument();
    expect(lastSeenIcon.compareDocumentPosition(signalIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(signalIcon.compareDocumentPosition(batteryIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Signal 64%/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last advertisement/i)).not.toBeInTheDocument();
  }, 10000);
});
