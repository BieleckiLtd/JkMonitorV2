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
    fireEvent.click(screen.getByRole('button', { name: 'Configuration section' }));
    expect(screen.getByText('Charge Switch')).toBeInTheDocument();
  });

  it('renders inverter cards as compact expandable summaries with synchronized power units and header badges', async () => {
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
        {
          id: 'battery_voltage',
          type: 'number',
          name: 'Battery Voltage',
          category: 'Battery',
          source: { bank: 'live', byteOffset: 10, unit: 'V' },
          display: { precision: 1 },
        },
        {
          id: 'clock_year',
          type: 'number',
          name: 'Time setting - Year',
          category: 'F3 Time',
          source: { bank: 'live', byteOffset: 12, unit: '' },
          display: { precision: 0, formatter: 'plain-number' },
        },
        {
          id: 'serial_number',
          type: 'text',
          name: 'Serial Number',
          category: 'Device Info',
          source: { bank: 'info', byteOffset: 14, unit: '' },
        },
        {
          id: 'equipment_type',
          type: 'number',
          name: 'Equipment Type',
          category: 'Device Info',
          source: { bank: 'info', byteOffset: 16, unit: '' },
          display: { precision: 0, formatter: 'plain-number' },
        },
        {
          id: 'protocol_number',
          type: 'number',
          name: 'Protocol Number',
          category: 'Device Info',
          source: { bank: 'info', byteOffset: 18, unit: '' },
          display: { precision: 0, formatter: 'plain-number' },
        },
        {
          id: 'firmware_version',
          type: 'text',
          name: 'Firmware Version',
          category: 'Device Info',
          source: { bank: 'info', byteOffset: 28, unit: '' },
        },
        {
          id: 'rated_power',
          type: 'number',
          name: 'Rated Power',
          category: 'Device Info',
          source: { bank: 'info', byteOffset: 44, unit: 'W' },
          display: { precision: 0, formatter: 'plain-number' },
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
                  { entity: 'battery_voltage', color: 'emerald' },
                  { entity: 'state_of_charge', color: 'green' },
                  { entity: 'output_active_power', color: 'amber' },
                  { entity: 'pv_power', color: 'sky' },
                ],
                entities: ['operating_mode', 'energy_saving_mode', 'load_percent', 'grid_voltage', 'mains_frequency', 'output_voltage', 'output_frequency'],
              },
              {
                type: 'parameter-table',
                title: 'Settings',
                groupBy: 'category',
                filter: { writable: true },
              },
              {
                type: 'parameter-table',
                title: 'Device Info',
                entities: ['serial_number', 'equipment_type', 'protocol_number', 'firmware_version', 'rated_power'],
                filter: { categories: ['Device Info'] },
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
          address: 9,
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
              { key: 'operating_mode', displayName: 'Operating Mode', category: 'Status', numericValue: 2, stringValue: 'Mains', sortOrder: 0, unit: '' },
              { key: 'battery_power', displayName: 'Battery Power', category: 'Battery', numericValue: 620, sortOrder: 1, unit: 'W' },
              { key: 'mains_frequency', displayName: 'Mains Frequency', category: 'Grid', numericValue: 49.96, sortOrder: 1, unit: 'Hz' },
              { key: 'pv_power', displayName: 'PV Power', category: 'Solar', numericValue: 1280, sortOrder: 2, unit: 'W' },
              { key: 'grid_voltage', displayName: 'Grid Voltage', category: 'Grid', numericValue: 240.6, sortOrder: 2, unit: 'V' },
              { key: 'output_active_power', displayName: 'Output Active Power', category: 'Output', numericValue: 540, sortOrder: 3, unit: 'W' },
              { key: 'state_of_charge', displayName: 'State of Charge', category: 'Battery', numericValue: 78, sortOrder: 4, unit: '%' },
              { key: 'load_percent', displayName: 'Load', category: 'Output', numericValue: 1, sortOrder: 5, unit: '%' },
              { key: 'energy_saving_mode', displayName: 'Power saving mode', category: 'F0 System', numericValue: 1, stringValue: 'Enabled', sortOrder: 5, unit: '' },
              { key: 'output_priority', displayName: 'Output Priority', category: 'Power Management', numericValue: 0, stringValue: 'Utility first (UTI)', sortOrder: 6, unit: '' },
              { key: 'output_voltage', displayName: 'Output Voltage', category: 'Output', numericValue: 230.4, sortOrder: 6, unit: 'V' },
              { key: 'max_charge_current', displayName: 'Max Charge Current', category: 'F2 Battery', numericValue: 100, rawValue: 100, sortOrder: 7, isWritable: true, unit: 'A' },
              { key: 'modbus_address', displayName: 'Modbus ID setting', category: 'F0 System', numericValue: 0, rawValue: 0, sortOrder: 7, isWritable: true, unit: '' },
              { key: 'output_apparent_power', displayName: 'Output Apparent Power', category: 'Output', numericValue: 900, sortOrder: 8, unit: 'VA' },
              { key: 'output_frequency', displayName: 'Output Frequency', category: 'Output', numericValue: 49.92, sortOrder: 8, unit: 'Hz' },
              { key: 'clock_year', displayName: 'Time setting - Year', category: 'F3 Time', numericValue: 2026, rawValue: 2026, sortOrder: 9, isWritable: true, unit: '', displayFormatter: 'plain-number' },
              { key: 'inv_temperature', displayName: 'INV Temperature', category: 'Temperatures', numericValue: 25, sortOrder: 9, unit: '°C' },
              { key: 'dc_temperature', displayName: 'DC Module Temperature', category: 'Temperatures', numericValue: 16, sortOrder: 10, unit: '°C' },
              { key: 'pv_temperature', displayName: 'MPPT Temperature', category: 'Temperatures', numericValue: 15, sortOrder: 11, unit: '°C' },
              { key: 'serial_number', displayName: 'Serial Number', category: 'Device Info', stringValue: '92B32501100891', sortOrder: 10 },
              { key: 'equipment_type', displayName: 'Equipment Type', category: 'Device Info', numericValue: 29440, sortOrder: 12, unit: '', displayFormatter: 'plain-number' },
              { key: 'protocol_number', displayName: 'Protocol Number', category: 'Device Info', numericValue: 3, sortOrder: 13, unit: '', displayFormatter: 'plain-number' },
              { key: 'firmware_version', displayName: 'Firmware Version', category: 'Device Info', stringValue: 'FW1.2.3', sortOrder: 14 },
              { key: 'rated_power', displayName: 'Rated Power', category: 'Device Info', numericValue: 11000, sortOrder: 15, unit: 'W' },
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
    expect(screen.getByText('0.1')).toBeInTheDocument();
    expect(screen.getByText('0.6')).toBeInTheDocument();
    expect(screen.getByText('1.3')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.getAllByText('kW')).toHaveLength(4);
    expect(screen.queryByText('Max Charge Current')).not.toBeInTheDocument();
    expect(screen.queryByText(/VA/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /garage inverter/i }));

    expect(await screen.findByTestId('history-charts')).toHaveTextContent('History for inv-1');
    const f0Section = screen.getByRole('button', { name: 'F0 System section' });
    const chargerSection = screen.getByRole('button', { name: 'F2 Charger section' });
    const clockSection = screen.getByRole('button', { name: 'F3 Time section' });
    const deviceInfoSection = screen.getByRole('button', { name: 'Device Info section' });
    expect(screen.queryByRole('button', { name: 'Live Readings section' })).not.toBeInTheDocument();
    expect(f0Section).toHaveAttribute('aria-expanded', 'false');
    expect(chargerSection).toHaveAttribute('aria-expanded', 'false');
    expect(clockSection).toHaveAttribute('aria-expanded', 'false');
    expect(deviceInfoSection).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Max Charge Current')).not.toBeInTheDocument();
    expect(screen.queryByText('Serial Number')).not.toBeInTheDocument();
    expect(screen.queryByText('MPPT Temperature')).not.toBeInTheDocument();
    expect(screen.getByText('Grid Voltage')).toBeInTheDocument();
    expect(screen.getByText('Mains Frequency')).toBeInTheDocument();
    expect(screen.getByText('Operating Mode')).toBeInTheDocument();
    expect(screen.getAllByText((_, element) => element?.textContent === '1%').length).toBeGreaterThan(0);

    fireEvent.click(f0Section);
    expect(f0Section).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Modbus ID setting')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();

    fireEvent.click(chargerSection);
    expect(chargerSection).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Max Charge Current')).toBeInTheDocument();

    fireEvent.click(clockSection);
    expect(clockSection).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Time setting - Year')).toBeInTheDocument();
    expect(screen.getByText('2026')).toBeInTheDocument();

    fireEvent.click(deviceInfoSection);
    expect(deviceInfoSection).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Serial Number')).toBeInTheDocument();
    expect(screen.getByText('92B32501100891')).toBeInTheDocument();
    expect(screen.getByText('Equipment Type')).toBeInTheDocument();
    expect(screen.getByText('29440')).toBeInTheDocument();
    expect(screen.getByText('Protocol Number')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.queryByText('2,026')).not.toBeInTheDocument();
  });

  it('renders inverter clock settings as a combined date and time editor', async () => {
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
        { id: 'clock_year', type: 'number', name: 'Time setting - Year', category: 'F3 Time', writable: true, source: { bank: 'clock', byteOffset: 0, unit: '' }, display: { precision: 0, formatter: 'plain-number' } },
        { id: 'clock_month', type: 'number', name: 'Time setting - Month', category: 'F3 Time', writable: true, source: { bank: 'clock', byteOffset: 2, unit: '' }, display: { precision: 0, formatter: 'plain-number' } },
        { id: 'clock_day', type: 'number', name: 'Time setting - Day', category: 'F3 Time', writable: true, source: { bank: 'clock', byteOffset: 4, unit: '' }, display: { precision: 0, formatter: 'plain-number' } },
        { id: 'clock_hour', type: 'number', name: 'Time setting - Hour', category: 'F3 Time', writable: true, source: { bank: 'clock', byteOffset: 6, unit: '' }, display: { precision: 0, formatter: 'plain-number' } },
        { id: 'clock_minute', type: 'number', name: 'Time setting - Minute', category: 'F3 Time', writable: true, source: { bank: 'clock', byteOffset: 8, unit: '' }, display: { precision: 0, formatter: 'plain-number' } },
        { id: 'clock_second', type: 'number', name: 'Time setting - Second', category: 'F3 Time', writable: true, source: { bank: 'clock', byteOffset: 10, unit: '' }, display: { precision: 0, formatter: 'plain-number' } },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            sections: [
              {
                type: 'parameter-table',
                title: 'Clock',
                filter: { writable: true, categories: ['F3 Time'] },
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

    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        results: [
          { parameterKey: 'clock_year', success: true, writtenValue: 2026, readBackValue: 2026 },
          { parameterKey: 'clock_month', success: true, writtenValue: 4, readBackValue: 4 },
          { parameterKey: 'clock_day', success: true, writtenValue: 12, readBackValue: 12 },
          { parameterKey: 'clock_hour', success: true, writtenValue: 13, readBackValue: 13 },
          { parameterKey: 'clock_minute', success: true, writtenValue: 45, readBackValue: 45 },
          { parameterKey: 'clock_second', success: true, writtenValue: 30, readBackValue: 30 },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    render(<MonitorPage />);

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    FakeEventSource.instances[0]?.emit({
      devices: [
        {
          deviceId: 'inv-clock',
          displayName: 'Clock Inverter',
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
              { key: 'clock_year', displayName: 'Time setting - Year', category: 'F3 Time', numericValue: 2026, rawValue: 2026, sortOrder: 0, isWritable: true, unit: '', displayFormatter: 'plain-number' },
              { key: 'clock_month', displayName: 'Time setting - Month', category: 'F3 Time', numericValue: 4, rawValue: 4, sortOrder: 1, isWritable: true, unit: '', displayFormatter: 'plain-number' },
              { key: 'clock_day', displayName: 'Time setting - Day', category: 'F3 Time', numericValue: 12, rawValue: 12, sortOrder: 2, isWritable: true, unit: '', displayFormatter: 'plain-number' },
              { key: 'clock_hour', displayName: 'Time setting - Hour', category: 'F3 Time', numericValue: 12, rawValue: 12, sortOrder: 3, isWritable: true, unit: '', displayFormatter: 'plain-number' },
              { key: 'clock_minute', displayName: 'Time setting - Minute', category: 'F3 Time', numericValue: 34, rawValue: 34, sortOrder: 4, isWritable: true, unit: '', displayFormatter: 'plain-number' },
              { key: 'clock_second', displayName: 'Time setting - Second', category: 'F3 Time', numericValue: 56, rawValue: 56, sortOrder: 5, isWritable: true, unit: '', displayFormatter: 'plain-number' },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('Clock Inverter')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clock inverter/i }));

    const clockSection = await screen.findByRole('button', { name: 'Clock section' });
    expect(clockSection).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(clockSection);
    expect(clockSection).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByText('Date & Time')).toBeInTheDocument();
    expect(screen.getByText('2026-04-12 12:34:56')).toBeInTheDocument();
    expect(screen.queryByText('Time setting - Year')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTitle('Edit date and time'));

    const input = screen.getByLabelText('Set inverter date and time');
    expect(input).toHaveDisplayValue('2026-04-12T12:34:56.000');

    fireEvent.change(input, { target: { value: '2026-04-12T13:45:30' } });
    fireEvent.click(screen.getByLabelText('Save date and time'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/devices/inv-clock/parameters/batch',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parameters: [
            { parameterKey: 'clock_year', rawValue: 2026 },
            { parameterKey: 'clock_month', rawValue: 4 },
            { parameterKey: 'clock_day', rawValue: 12 },
            { parameterKey: 'clock_hour', rawValue: 13 },
            { parameterKey: 'clock_minute', rawValue: 45 },
            { parameterKey: 'clock_second', rawValue: 30 },
          ],
        }),
      }),
    );

    expect(await screen.findByText(/Confirmed: 2026-04-12 13:45:30/)).toBeInTheDocument();
  });

  it('uses entity scale when editing writable numeric parameters', async () => {
    useDeviceDefinitionMock.mockReturnValue({
      version: '1',
      device: {
        id: 'scaled-device',
        name: 'Scaled Device',
        manufacturer: 'Acme',
        model: 'Scale-1',
        category: 'controller',
      },
      connection: {
        transport: { type: 'serial', defaults: {} },
        protocol: { type: 'modbus-rtu', settings: {} },
      },
      dataSources: [],
      pollGroups: {},
      entities: [
        {
          id: 'cell_charge_request',
          type: 'number',
          name: 'Cell Charge Request',
          category: 'Configuration',
          writable: true,
          source: { bank: 'config', byteOffset: 0, unit: 'V', scale: 0.001 },
          display: { precision: 3 },
        },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            sections: [
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

    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        writtenValue: 3460,
        readBackValue: 3460,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as typeof fetch;

    render(<MonitorPage />);

    await waitFor(() => {
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    FakeEventSource.instances[0]?.emit({
      devices: [
        {
          deviceId: 'scaled-1',
          displayName: 'Scaled Battery',
          definitionId: 'scaled-device',
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
              {
                key: 'cell_charge_request',
                displayName: 'Cell Charge Request',
                category: 'Configuration',
                numericValue: 3.45,
                rawValue: 3450,
                sortOrder: 0,
                isWritable: true,
                unit: 'V',
              },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('Scaled Battery')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configuration section' }));
    fireEvent.click(screen.getByTitle('Edit parameter'));

    const input = screen.getByLabelText('Set Cell Charge Request');
    expect(input).toHaveDisplayValue('3.450');

    fireEvent.change(input, { target: { value: '3.460' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/devices/scaled-1/parameters/cell_charge_request',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawValue: 3460 }),
      }),
    );

    expect(await screen.findByText(/Confirmed: 3\.460 V/)).toBeInTheDocument();
  });
});
