import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorPage } from './MonitorPage';
import type { DeviceDefinition } from '../types/deviceDefinition';

const { useDeviceDefinitionMock } = vi.hoisted(() => ({
  useDeviceDefinitionMock: vi.fn<() => DeviceDefinition | null>(),
}));

vi.mock('../hooks/useDeviceDefinition', () => ({
  useDeviceDefinition: useDeviceDefinitionMock,
}));

vi.mock('../components/HistoryCharts', () => ({
  HistoryCharts: ({ deviceId }: { deviceId: string }) => <div data-testid='history-charts'>History for {deviceId}</div>,
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
            card: {
              statusGlyphs: [
                {
                  type: 'last-seen',
                  icon: 'pulse',
                  levels: [
                    { maxAgeSeconds: 60, color: 'green', label: 'less than a minute ago' },
                    { maxAgeSeconds: 300, color: 'orange', label: 'less than 5 minutes ago' },
                    { color: 'red', label: 'more than 5 minutes ago' },
                  ],
                },
                {
                  type: 'signal-strength',
                  entity: 'signal_strength_pct',
                  icon: 'signal',
                  levels: [
                    { minValue: 55, color: 'green' },
                    { minValue: 25, color: 'orange' },
                    { color: 'red' },
                  ],
                },
                {
                  type: 'battery-level',
                  entity: 'battery_pct',
                  icon: 'battery',
                  levels: [
                    { minValue: 36, color: 'green' },
                    { minValue: 16, color: 'orange' },
                    { color: 'red' },
                  ],
                },
              ],
            },
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
    expect(signalIcon).toHaveClass('text-emerald-400');
    expect(lastSeenIcon.compareDocumentPosition(signalIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(signalIcon.compareDocumentPosition(batteryIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/Signal 64%/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Last advertisement/i)).not.toBeInTheDocument();
  }, 10000);

  it('renders passive BLE environment devices in listening mode without a waiting banner', async () => {
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
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            card: {
              statusGlyphs: [
                {
                  type: 'last-seen',
                  icon: 'pulse',
                  levels: [
                    { maxAgeSeconds: 60, color: 'green', label: 'less than a minute ago' },
                    { maxAgeSeconds: 300, color: 'orange', label: 'less than 5 minutes ago' },
                    { color: 'red', label: 'more than 5 minutes ago' },
                  ],
                },
              ],
            },
            sections: [
              {
                type: 'hero-metrics',
                metrics: [
                  { entity: 'temperature_c', color: 'amber' },
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
          displayName: 'Fridge Sensor',
          definitionId: 'govee-thermo-hygrometer-ble',
          protocolHandler: 'ble-advertisement',
          enabled: true,
          isMaster: false,
          pollIntervalMilliseconds: 5000,
          lastOutcome: 'Listening',
          latestTelemetry: null,
        },
      ],
    });

    expect(await screen.findByText('Fridge Sensor')).toBeInTheDocument();
    expect(screen.getByTitle('Listening for a first signal')).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for first reading/i)).not.toBeInTheDocument();
  }, 10000);

  it('renders JK BMS cards collapsed by default and expands them on demand', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-12T12:00:02.000Z').getTime());

    useDeviceDefinitionMock.mockReturnValue({
      version: '1',
      device: {
        id: 'jk-inverter-bms',
        name: 'JK Inverter BMS',
        manufacturer: 'JK',
        model: 'JK-PB2A16S20P',
        category: 'energy-storage',
        icon: 'battery',
      },
      connection: {
        transport: { type: 'serial', defaults: {} },
        protocol: { type: 'modbus-rtu', settings: {} },
      },
      dataSources: [],
      pollGroups: {},
      entities: [
        {
          id: 'total_voltage',
          type: 'number',
          name: 'Total Voltage',
          category: 'Pack Status',
          source: { bank: 'live', byteOffset: 0, unit: 'V' },
          display: { precision: 2 },
        },
        {
          id: 'current',
          type: 'number',
          name: 'Current',
          category: 'Pack Status',
          source: { bank: 'live', byteOffset: 0, unit: 'A' },
          display: { precision: 1 },
        },
        {
          id: 'power',
          type: 'number',
          name: 'Power',
          category: 'Pack Status',
          source: { bank: 'live', byteOffset: 0, unit: 'W' },
          display: { precision: 0 },
        },
        {
          id: 'state_of_charge',
          type: 'number',
          name: 'State of Charge',
          category: 'Pack Status',
          source: { bank: 'live', byteOffset: 0, unit: '%' },
          display: { precision: 0 },
        },
        {
          id: 'charge_switch',
          type: 'number',
          name: 'Charge Switch',
          category: 'Configuration',
          source: { bank: 'config', byteOffset: 0, unit: '' },
          display: { precision: 0 },
        },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            card: {
              statusGlyphs: [
                {
                  type: 'last-seen',
                  icon: 'pulse',
                  levels: [
                    { maxAgeSeconds: 5, color: 'green', label: 'less than 5 seconds ago' },
                    { maxAgeSeconds: 300, color: 'orange', label: 'less than 5 minutes ago' },
                    { color: 'red', label: 'more than 5 minutes ago' },
                  ],
                },
                {
                  type: 'state',
                  states: [
                    { entity: 'charging_active', equals: true, icon: 'battery-charging', color: 'green', title: 'Charging' },
                    { entity: 'discharging_active', equals: true, icon: 'battery-discharging', color: 'orange', title: 'Discharging' },
                  ],
                },
              ],
            },
            sections: [
              {
                type: 'hero-metrics',
                metrics: [
                  { entity: 'total_voltage', color: 'emerald' },
                  { entity: 'current', color: 'blue' },
                  { entity: 'power', color: 'amber' },
                  { entity: 'state_of_charge', color: 'green' },
                ],
              },
              {
                type: 'parameter-table',
                title: 'Configuration',
                filter: { writable: true },
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
          deviceId: 'jk-1',
          displayName: 'House Battery',
          definitionId: 'jk-inverter-bms',
          protocolHandler: 'modbus-rtu',
          enabled: true,
          isMaster: true,
          pollIntervalMilliseconds: 1000,
          lastOutcome: 'Succeeded',
          latestTelemetry: {
            collectedAt: '2026-04-12T12:00:00.000Z',
            cells: [],
            activeWarnings: [],
            parameters: [
              { key: 'total_voltage', displayName: 'Total Voltage', category: 'Pack Status', numericValue: 53.21, sortOrder: 0, unit: 'V' },
              { key: 'current', displayName: 'Current', category: 'Pack Status', numericValue: -12.3, sortOrder: 1, unit: 'A' },
              { key: 'power', displayName: 'Power', category: 'Pack Status', numericValue: 654, sortOrder: 2, unit: 'W' },
              { key: 'state_of_charge', displayName: 'State of Charge', category: 'Pack Status', numericValue: 78, sortOrder: 3, unit: '%' },
              { key: 'charging_enabled', displayName: 'Charging', category: 'Status', booleanValue: true, sortOrder: 3, unit: '' },
              { key: 'discharging_enabled', displayName: 'Discharging', category: 'Status', booleanValue: true, sortOrder: 3, unit: '' },
              { key: 'charge_switch', displayName: 'Charge Switch', category: 'Configuration', numericValue: 1, rawValue: 1, sortOrder: 4, isWritable: true, unit: '' },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('House Battery')).toBeInTheDocument();
    expect(screen.getByTitle('Last seen less than 5 seconds ago (2026-04-12T12:00:00.000Z)')).toBeInTheDocument();
    expect(screen.getByTitle('Discharging')).toBeInTheDocument();
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();
    expect(screen.getByText('53.21')).toBeInTheDocument();
    expect(screen.queryByTestId('history-charts')).not.toBeInTheDocument();
    expect(screen.queryByText('Charge Switch')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /house battery/i }));

    expect(await screen.findByTestId('history-charts')).toHaveTextContent('History for jk-1');
    expect(screen.getByText('Charge Switch')).toBeInTheDocument();
  });

  it('renders inverter cards as compact expandable summaries with power units and header badges', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-12T12:00:04.000Z').getTime());

    useDeviceDefinitionMock.mockReturnValue({
      version: '1',
      device: {
        id: 'anenji-inverter-rs232',
        name: 'Anenji Inverter',
        manufacturer: 'Anenji / Easun',
        model: 'ANJ-HHS-11000W-48V',
        category: 'inverter',
        icon: 'zap',
      },
      connection: {
        transport: { type: 'serial', defaults: {} },
        protocol: { type: 'modbus-rtu', settings: {} },
      },
      dataSources: [],
      pollGroups: {},
      entities: [
        {
          id: 'grid_power',
          type: 'number',
          name: 'Grid Power',
          category: 'Grid',
          source: { bank: 'live', byteOffset: 0, unit: 'W' },
          display: { precision: 0 },
        },
        {
          id: 'battery_power',
          type: 'number',
          name: 'Battery Power',
          category: 'Battery',
          source: { bank: 'live', byteOffset: 2, unit: 'W' },
          display: { precision: 0 },
        },
        {
          id: 'pv_power',
          type: 'number',
          name: 'PV Power',
          category: 'Solar',
          source: { bank: 'live', byteOffset: 4, unit: 'W' },
          display: { precision: 0 },
        },
        {
          id: 'output_active_power',
          type: 'number',
          name: 'Output Active Power',
          category: 'Output',
          source: { bank: 'live', byteOffset: 6, unit: 'W' },
          display: { precision: 0 },
        },
        {
          id: 'state_of_charge',
          type: 'number',
          name: 'State of Charge',
          category: 'Battery',
          source: { bank: 'live', byteOffset: 8, unit: '%' },
          display: { precision: 0 },
        },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            card: {
              statusGlyphs: [
                {
                  type: 'last-seen',
                  icon: 'pulse',
                  levels: [
                    { maxAgeSeconds: 10, color: 'green', label: 'less than 10 seconds ago' },
                    { maxAgeSeconds: 300, color: 'orange', label: 'less than 5 minutes ago' },
                    { color: 'red', label: 'more than 5 minutes ago' },
                  ],
                },
              ],
            },
            sections: [
              {
                type: 'hero-metrics',
                metrics: [
                  { entity: 'grid_power', color: 'sky', label: 'Grid', format: 'power-short' },
                  { entity: 'battery_power', color: 'emerald', label: 'Battery', format: 'power-short' },
                  { entity: 'pv_power', color: 'green', label: 'Solar', format: 'power-short' },
                  { entity: 'output_active_power', color: 'amber', label: 'Load', format: 'power-short' },
                ],
              },
              {
                type: 'parameter-table',
                title: 'Settings',
                filter: { writable: true },
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
          deviceId: 'inv-1',
          displayName: 'Garage Inverter',
          definitionId: 'anenji-inverter-rs232',
          protocolHandler: 'modbus-rtu',
          enabled: true,
          isMaster: true,
          pollIntervalMilliseconds: 5000,
          lastOutcome: 'Succeeded',
          latestTelemetry: {
            collectedAt: '2026-04-12T12:00:00.000Z',
            cells: [],
            activeWarnings: [],
            parameters: [
              { key: 'grid_power', displayName: 'Grid Power', category: 'Grid', numericValue: 90, sortOrder: 0, unit: 'W' },
              { key: 'battery_power', displayName: 'Battery Power', category: 'Battery', numericValue: 620, sortOrder: 1, unit: 'W' },
              { key: 'pv_power', displayName: 'PV Power', category: 'Solar', numericValue: 1280, sortOrder: 2, unit: 'W' },
              { key: 'output_active_power', displayName: 'Output Active Power', category: 'Output', numericValue: 540, sortOrder: 3, unit: 'W' },
              { key: 'state_of_charge', displayName: 'State of Charge', category: 'Battery', numericValue: 78, sortOrder: 4, unit: '%' },
              { key: 'energy_saving_mode', displayName: 'Eco Mode', category: 'Power Management', numericValue: 1, stringValue: 'On', sortOrder: 5, unit: '' },
              { key: 'output_priority', displayName: 'Output Priority', category: 'Power Management', numericValue: 0, stringValue: 'Utility first (UTI)', sortOrder: 6, unit: '' },
              { key: 'max_charge_current', displayName: 'Max Charge Current', category: 'Settings', numericValue: 100, rawValue: 100, sortOrder: 7, isWritable: true, unit: 'A' },
              { key: 'output_apparent_power', displayName: 'Output Apparent Power', category: 'Output', numericValue: 900, sortOrder: 8, unit: 'VA' },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('Garage Inverter')).toBeInTheDocument();
    expect(screen.getByTitle('Last seen less than 10 seconds ago (2026-04-12T12:00:00.000Z)')).toBeInTheDocument();
    expect(screen.getByTitle('Eco mode enabled')).toHaveClass('text-emerald-400');
    expect(screen.getByTitle('Battery 78%')).toBeInTheDocument();
    expect(screen.getByTitle('Output priority Utility first (UTI)')).toBeInTheDocument();
    expect(screen.getByText('SUF')).toBeInTheDocument();
    expect(screen.getByText('Grid')).toBeInTheDocument();
    expect(screen.getByText('Battery')).toBeInTheDocument();
    expect(screen.getByText('Solar')).toBeInTheDocument();
    expect(screen.getByText('Load')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
    expect(screen.getByText('0.6')).toBeInTheDocument();
    expect(screen.getByText('1.3')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.getAllByText('kW')).toHaveLength(3);
    expect(screen.getByText('W')).toBeInTheDocument();
    expect(screen.queryByText('Max Charge Current')).not.toBeInTheDocument();
    expect(screen.queryByText(/VA/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /garage inverter/i }));

    expect(await screen.findByTestId('history-charts')).toHaveTextContent('History for inv-1');
    expect(screen.getByText('Max Charge Current')).toBeInTheDocument();
  });
});
