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
        id: 'jk-inverter-bms-ble',
        name: 'JK Inverter BMS (BLE)',
        manufacturer: 'JK',
        model: 'JK-PB2A16S20P',
        category: 'energy-storage',
        icon: 'battery',
      },
      connection: {
        transport: { type: 'ble', defaults: {} },
        protocol: { type: 'ble-frame', settings: { byteOrder: 'little-endian' } },
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
          id: 'charging_enabled',
          type: 'binary_sensor',
          name: 'Charging',
          category: 'Status',
          source: { bank: 'live', byteOffset: 0, dataType: 'uint8', trueValue: 1 },
        },
        {
          id: 'discharging_enabled',
          type: 'binary_sensor',
          name: 'Discharging',
          category: 'Status',
          source: { bank: 'live', byteOffset: 1, dataType: 'uint8', trueValue: 1 },
        },
        {
          id: 'mos_temperature',
          type: 'number',
          name: 'MOS Temperature',
          category: 'Thermal Protection',
          source: { bank: 'live', byteOffset: 2, unit: '°C' },
          display: { precision: 1 },
        },
        {
          id: 'battery_temp_1',
          type: 'number',
          name: 'Battery Temp 1',
          category: 'Thermal Protection',
          source: { bank: 'live', byteOffset: 4, unit: '°C' },
          display: { precision: 1 },
        },
        {
          id: 'battery_temp_2',
          type: 'number',
          name: 'Battery Temp 2',
          category: 'Thermal Protection',
          source: { bank: 'live', byteOffset: 6, unit: '°C' },
          display: { precision: 1 },
        },
        {
          id: 'battery_temp_3',
          type: 'number',
          name: 'Battery Temp 3',
          category: 'Thermal Protection',
          source: { bank: 'live', byteOffset: 8, unit: '°C' },
          display: { precision: 1 },
        },
        {
          id: 'charge_status_time_elapsed',
          type: 'number',
          name: 'Charge Status Time',
          category: 'Charging',
          source: { bank: 'live', byteOffset: 10, unit: 's' },
          display: { precision: 0 },
        },
        {
          id: 'cell_request_charge_voltage_time',
          type: 'number',
          name: 'RCV Time',
          category: 'Charging',
          source: { bank: 'info', byteOffset: 32, unit: 'h', scale: 0.1 },
          display: { precision: 1 },
          writable: true,
        },
        {
          id: 'cell_request_float_voltage_time',
          type: 'number',
          name: 'RFV Time',
          category: 'Charging',
          source: { bank: 'info', byteOffset: 33, unit: 'h', scale: 0.1 },
          display: { precision: 1 },
          writable: true,
        },
        {
          id: 'charge_status',
          type: 'select',
          name: 'Charge Status',
          category: 'Charging',
          source: { bank: 'live', byteOffset: 12, dataType: 'uint8' },
          options: [
            { value: 0, label: 'Bulk' },
            { value: 1, label: 'Absorption' },
            { value: 2, label: 'Float' },
          ],
        },
        {
          id: 'heating_status',
          type: 'binary_sensor',
          name: 'Heating Status',
          category: 'System',
          source: { bank: 'live', byteOffset: 13, dataType: 'uint8', trueValue: 1 },
        },
        {
          id: 'heating_current',
          type: 'number',
          name: 'Heat Current',
          category: 'System',
          source: { bank: 'live', byteOffset: 14, unit: 'A' },
          display: { precision: 3 },
        },
        {
          id: 'emergency_time_countdown',
          type: 'number',
          name: 'Emergency Timer',
          category: 'System',
          source: { bank: 'live', byteOffset: 16, unit: 's' },
          display: { precision: 0 },
        },
        {
          id: 'time_enter_sleep',
          type: 'number',
          name: 'Time Enter Sleep',
          category: 'System',
          source: { bank: 'live', byteOffset: 18, unit: 's' },
          display: { precision: 0 },
        },
        {
          id: 'pcl_module_state',
          type: 'binary_sensor',
          name: 'Par-Limiter (PCL Module)',
          category: 'System',
          source: { bank: 'live', byteOffset: 20, dataType: 'uint8', trueValue: 1 },
        },
        {
          id: 'dry_contact_1',
          type: 'binary_sensor',
          name: 'DRY1 Alarm',
          category: 'System',
          source: { bank: 'live', byteOffset: 21, dataType: 'uint8', trueValue: 1 },
        },
        {
          id: 'dry_contact_2',
          type: 'binary_sensor',
          name: 'DRY2 Alarm',
          category: 'System',
          source: { bank: 'live', byteOffset: 22, dataType: 'uint8', trueValue: 1 },
        },
        {
          id: 'lcd_buzzer_trigger',
          type: 'number',
          name: 'LCD Buzzer Trigger',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 0, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'dry_1_trigger',
          type: 'number',
          name: 'DRY 1 Trigger',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 1, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'dry_2_trigger',
          type: 'number',
          name: 'DRY 2 Trigger',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 2, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'lcd_buzzer_trigger_value',
          type: 'number',
          name: 'LCD Buzzer Trigger Value',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 4, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'lcd_buzzer_release_value',
          type: 'number',
          name: 'LCD Buzzer Release Value',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 8, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'dry_1_trigger_value',
          type: 'number',
          name: 'DRY 1 Trigger Value',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 12, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'dry_1_release_value',
          type: 'number',
          name: 'DRY 1 Release Value',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 16, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'dry_2_trigger_value',
          type: 'number',
          name: 'DRY 2 Trigger Value',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 20, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'dry_2_release_value',
          type: 'number',
          name: 'DRY 2 Release Value',
          category: 'Triggers',
          source: { bank: 'info', byteOffset: 24, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'uart1_protocol',
          type: 'number',
          name: 'UART 1 Protocol',
          category: 'Communication',
          source: { bank: 'info', byteOffset: 28, unit: '' },
          display: { precision: 0 },
          writable: true,
        },
        {
          id: 'can_protocol',
          type: 'number',
          name: 'CAN Protocol',
          category: 'Communication',
          source: { bank: 'info', byteOffset: 29, unit: '' },
          display: { precision: 0 },
          writable: true,
        },
        {
          id: 'uart2_protocol',
          type: 'number',
          name: 'UART 2 Protocol',
          category: 'Communication',
          source: { bank: 'info', byteOffset: 30, unit: '' },
          display: { precision: 0 },
          writable: true,
        },
        {
          id: 'uart3_protocol',
          type: 'number',
          name: 'UART 3 Protocol',
          category: 'Communication',
          source: { bank: 'info', byteOffset: 31, unit: '' },
          display: { precision: 0 },
          writable: true,
        },
        {
          id: 'charge_switch',
          type: 'number',
          name: 'Charge Switch',
          category: 'Charging',
          source: { bank: 'config', byteOffset: 0, unit: '' },
          display: { precision: 0 },
        },
        {
          id: 'voltage_calibration',
          type: 'number',
          name: 'Voltage Calibration',
          category: 'System',
          source: { bank: 'config', byteOffset: 4, unit: 'V', scale: 0.001 },
          display: { precision: 3 },
          writable: true,
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
                    { entity: 'charging_enabled', equals: true, icon: 'battery-charging', color: 'green', title: 'Charging' },
                    { entity: 'discharging_enabled', equals: true, icon: 'battery-discharging', color: 'orange', title: 'Discharging' },
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
                type: 'status-indicators',
                entities: ['charging_enabled', 'discharging_enabled'],
              },
              {
                type: 'parameter-table',
                title: 'Configuration',
                filter: {
                  categories: ['Cell Protection', 'Current Protection', 'Thermal Protection', 'Balance Settings', 'SOC Settings', 'System', 'Charging', 'Discharging', 'Communication', 'Triggers', 'Device Info', 'F2 Charger'],
                },
                groupBy: 'category',
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
          definitionId: 'jk-inverter-bms-ble',
          protocolHandler: 'ble-frame',
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
              { key: 'mos_temperature', displayName: 'MOS Temperature', category: 'Thermal Protection', numericValue: 21.733, sortOrder: 4, unit: '°C' },
              { key: 'battery_temp_1', displayName: 'Battery Temp 1', category: 'Thermal Protection', numericValue: 19.544, sortOrder: 5, unit: '°C' },
              { key: 'battery_temp_2', displayName: 'Battery Temp 2', category: 'Thermal Protection', numericValue: 20.122, sortOrder: 6, unit: '°C' },
              { key: 'battery_temp_3', displayName: 'Battery Temp 3', category: 'Thermal Protection', numericValue: 19.866, sortOrder: 7, unit: '°C' },
              { key: 'charge_status', displayName: 'Charge Status', category: 'Charging', numericValue: 2, rawValue: 2, stringValue: 'Float', sortOrder: 8, unit: '' },
              { key: 'discharge_status', displayName: 'Discharge Status', category: 'Discharging', numericValue: 1, rawValue: 1, stringValue: 'Enabled', sortOrder: 8, unit: '' },
              { key: 'max_charge_current', displayName: 'Max Charge Current', category: 'Charging', numericValue: 80, rawValue: 80, sortOrder: 8, isWritable: true, unit: 'A' },
              { key: 'max_discharge_current', displayName: 'Max Discharge Current', category: 'Discharging', numericValue: 120, rawValue: 120, sortOrder: 8, isWritable: true, unit: 'A' },
              { key: 'charge_status_time_elapsed', displayName: 'Charge Status Time', category: 'Charging', numericValue: 90, sortOrder: 9, unit: 's' },
              { key: 'cell_request_charge_voltage_time', displayName: 'RCV Time', category: 'Charging', numericValue: 0.1, rawValue: 1, sortOrder: 10, isWritable: true, unit: 'h' },
              { key: 'cell_request_float_voltage_time', displayName: 'RFV Time', category: 'Charging', numericValue: 0.2, rawValue: 2, sortOrder: 11, isWritable: true, unit: 'h' },
              { key: 'cell_overvoltage_protection', displayName: 'Cell OVP', category: 'Cell Protection', numericValue: 3.65, sortOrder: 11, isWritable: true, unit: 'V' },
              { key: 'charge_overcurrent_protection', displayName: 'Charge OCP', category: 'Current Protection', numericValue: 120, sortOrder: 11, isWritable: true, unit: 'A' },
              { key: 'balance_trigger_voltage', displayName: 'Balance Trigger Voltage', category: 'Balance Settings', numericValue: 3.4, sortOrder: 11, isWritable: true, unit: 'V' },
              { key: 'soc_100_voltage', displayName: 'SOC 100% Voltage', category: 'SOC Settings', numericValue: 56.8, sortOrder: 11, isWritable: true, unit: 'V' },
              { key: 'soc_0_voltage', displayName: 'SOC 0% Voltage', category: 'SOC Settings', numericValue: 44.8, sortOrder: 11, isWritable: true, unit: 'V' },
              { key: 'heating_status', displayName: 'Heating Status', category: 'System', booleanValue: false, sortOrder: 10, unit: '' },
              { key: 'heating_current', displayName: 'Heat Current', category: 'System', numericValue: 0.511, sortOrder: 11, unit: 'A' },
              { key: 'emergency_time_countdown', displayName: 'Emergency Timer', category: 'System', numericValue: 45, sortOrder: 12, unit: 's' },
              { key: 'time_enter_sleep', displayName: 'Time Enter Sleep', category: 'System', numericValue: 86400, sortOrder: 13, unit: 's' },
              { key: 'pcl_module_state', displayName: 'Par-Limiter (PCL Module)', category: 'System', booleanValue: false, sortOrder: 14, unit: '' },
              { key: 'dry_contact_1', displayName: 'DRY1 Alarm', category: 'System', booleanValue: false, sortOrder: 15, unit: '' },
              { key: 'dry_contact_2', displayName: 'DRY2 Alarm', category: 'System', booleanValue: true, sortOrder: 16, unit: '' },
              { key: 'lcd_buzzer_trigger', displayName: 'LCD Buzzer Trigger', category: 'Triggers', numericValue: 3, sortOrder: 17, isWritable: true, unit: '' },
              { key: 'dry_1_trigger', displayName: 'DRY 1 Trigger', category: 'Triggers', numericValue: 2, sortOrder: 18, isWritable: true, unit: '' },
              { key: 'dry_2_trigger', displayName: 'DRY 2 Trigger', category: 'Triggers', numericValue: 4, sortOrder: 19, isWritable: true, unit: '' },
              { key: 'lcd_buzzer_trigger_value', displayName: 'LCD Buzzer Trigger Value', category: 'Triggers', numericValue: 80, sortOrder: 20, isWritable: true, unit: '' },
              { key: 'lcd_buzzer_release_value', displayName: 'LCD Buzzer Release Value', category: 'Triggers', numericValue: 60, sortOrder: 21, isWritable: true, unit: '' },
              { key: 'dry_1_trigger_value', displayName: 'DRY 1 Trigger Value', category: 'Triggers', numericValue: 90, sortOrder: 22, isWritable: true, unit: '' },
              { key: 'dry_1_release_value', displayName: 'DRY 1 Release Value', category: 'Triggers', numericValue: 70, sortOrder: 23, isWritable: true, unit: '' },
              { key: 'dry_2_trigger_value', displayName: 'DRY 2 Trigger Value', category: 'Triggers', numericValue: 95, sortOrder: 24, isWritable: true, unit: '' },
              { key: 'dry_2_release_value', displayName: 'DRY 2 Release Value', category: 'Triggers', numericValue: 75, sortOrder: 25, isWritable: true, unit: '' },
              { key: 'uart1_protocol', displayName: 'UART 1 Protocol', category: 'Communication', numericValue: 1, sortOrder: 26, unit: '' },
              { key: 'can_protocol', displayName: 'CAN Protocol', category: 'Communication', numericValue: 2, sortOrder: 27, unit: '' },
              { key: 'uart2_protocol', displayName: 'UART 2 Protocol', category: 'Communication', numericValue: 3, sortOrder: 28, unit: '' },
              { key: 'uart3_protocol', displayName: 'UART 3 Protocol', category: 'Communication', numericValue: 15, sortOrder: 29, isWritable: true, unit: '' },
              { key: 'charge_switch', displayName: 'Charge Switch', category: 'Charging', numericValue: 1, rawValue: 1, sortOrder: 29, isWritable: true, unit: '' },
              { key: 'voltage_calibration', displayName: 'Voltage Calibration', category: 'System', numericValue: 53.2, rawValue: 53200, sortOrder: 30, isWritable: true, unit: 'V' },
              { key: 'serial_number', displayName: 'Serial Number', category: 'Device Info', stringValue: 'JK-001', sortOrder: 31, unit: '' },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('House Battery')).toBeInTheDocument();
    expect(screen.getByTitle('Last seen less than 5 seconds ago (2026-04-12T12:00:00.000Z)')).toBeInTheDocument();
    expect(screen.getByTitle('Charging')).toBeInTheDocument();
    expect(screen.queryByText('Succeeded')).not.toBeInTheDocument();
    expect(screen.getByText('53.21')).toBeInTheDocument();
    expect(screen.queryByTestId('history-charts')).not.toBeInTheDocument();
    expect(screen.queryByText('Charging')).not.toBeInTheDocument();
    expect(screen.queryByText('Charge Status')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /house battery/i }));

    expect(await screen.findByTestId('history-charts')).toHaveTextContent('History for jk-1');
  const chargingSection = screen.getByRole('button', { name: 'Charging section' });
  const dischargingSection = screen.getByRole('button', { name: 'Discharging section' });
  const balanceSection = screen.getByRole('button', { name: 'Balance Settings section' });
  const cellProtectionSection = screen.getByRole('button', { name: 'Cell Protection section' });
  const currentProtectionSection = screen.getByRole('button', { name: 'Current Protection section' });
  const thermalSection = screen.getByRole('button', { name: 'Thermal Protection section' });
  const triggersSection = screen.getByRole('button', { name: 'Triggers section' });
  const communicationSection = screen.getByRole('button', { name: 'Communication section' });
  const systemSection = screen.getByRole('button', { name: 'System section' });
  const deviceInfoSection = screen.getByRole('button', { name: 'Device Info section' });
  expect(screen.queryByRole('button', { name: 'SOC Settings section' })).not.toBeInTheDocument();
  expect(chargingSection.compareDocumentPosition(dischargingSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(dischargingSection.compareDocumentPosition(balanceSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(balanceSection.compareDocumentPosition(cellProtectionSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(cellProtectionSection.compareDocumentPosition(currentProtectionSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(currentProtectionSection.compareDocumentPosition(thermalSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(thermalSection.compareDocumentPosition(triggersSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(triggersSection.compareDocumentPosition(communicationSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(communicationSection.compareDocumentPosition(systemSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(systemSection.compareDocumentPosition(deviceInfoSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(thermalSection);
    expect(screen.getByText('Battery Temp 3')).toBeInTheDocument();
    expect(screen.getByText('MOS Temperature')).toBeInTheDocument();
    expect(screen.getByText('21.7')).toBeInTheDocument();
    expect(screen.getByText('19.9')).toBeInTheDocument();
    expect(screen.queryByText('21.733')).not.toBeInTheDocument();

    fireEvent.click(currentProtectionSection);
    expect(screen.getByText('Max Charge Current')).toBeInTheDocument();
    expect(screen.getByText('Max Discharge Current')).toBeInTheDocument();
    expect(screen.getByText('Charge OCP')).toBeInTheDocument();
    expect(screen.getByText('Max Charge Current').compareDocumentPosition(screen.getByText('Charge OCP')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Max Discharge Current').compareDocumentPosition(screen.getByText('Charge OCP')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  fireEvent.click(chargingSection);
    expect(screen.getByText('Charge Status')).toBeInTheDocument();
    expect(screen.getByText('Charge Status Time')).toBeInTheDocument();
    expect(screen.getAllByText('Max Charge Current').length).toBeGreaterThan(1);
    const chargingSwitchLabel = screen.getAllByText('Charging').find((element) => element.tagName === 'SPAN');
    expect(chargingSwitchLabel).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('RCV Time')).toBeInTheDocument();
    expect(screen.getByText('RFV Time')).toBeInTheDocument();
    expect(screen.getByText('0.1')).toBeInTheDocument();
    expect(screen.getByText('0.2')).toBeInTheDocument();
    expect(chargingSwitchLabel?.compareDocumentPosition(screen.getByText('Charge Status')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('SOC 100% Voltage')).toBeInTheDocument();
    expect(screen.getByText('SOC 0% Voltage')).toBeInTheDocument();
    expect(screen.getByText('Charge Status').compareDocumentPosition(screen.getByText('SOC 100% Voltage')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText((_, element) => element?.textContent === '0.1 h').length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) => element?.textContent === '0.2 h').length).toBeGreaterThan(0);

    fireEvent.click(dischargingSection);
    expect(screen.getByText('Discharge Status')).toBeInTheDocument();
    expect(screen.getAllByText('Max Discharge Current').length).toBeGreaterThan(1);

    fireEvent.click(systemSection);
    expect(screen.getByText('Heating Status')).toBeInTheDocument();
    expect(screen.getByText('Heat Current')).toBeInTheDocument();
    expect(screen.getByText('Time Enter Sleep')).toBeInTheDocument();
    expect(screen.getByText('Par-Limiter (PCL Module)')).toBeInTheDocument();
    expect(screen.getByText('DRY2 Alarm')).toBeInTheDocument();
    expect(screen.getByText('Voltage Calibration')).toBeInTheDocument();
    expect(screen.queryByText('LCD Buzzer Trigger')).not.toBeInTheDocument();

    fireEvent.click(communicationSection);
    expect(screen.getByText('UART 1 Protocol')).toBeInTheDocument();
    expect(screen.getByText('CAN Protocol')).toBeInTheDocument();
    expect(screen.getByText('UART 2 Protocol')).toBeInTheDocument();
    expect(screen.getByText('UART 3 Protocol')).toBeInTheDocument();

    fireEvent.click(triggersSection);
    expect(screen.getByText('LCD Buzzer Trigger')).toBeInTheDocument();
    expect(screen.getByText('LCD Buzzer Trigger Value')).toBeInTheDocument();
    expect(screen.getByText('DRY 1 Trigger')).toBeInTheDocument();
    expect(screen.getByText('DRY 2 Release Value')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit LCD Buzzer Trigger' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit DRY 2 Release Value' })).toBeEnabled();

    fireEvent.click(deviceInfoSection);
    expect(screen.getByText('Serial Number')).toBeInTheDocument();
    expect(screen.getByText('JK-001')).toBeInTheDocument();
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
              { key: 'modbus_address', displayName: 'Modbus address', category: 'F0 System', numericValue: 9, rawValue: 9, sortOrder: 7, isWritable: true, unit: '' },
              {
                key: 'dry_contact_mode',
                displayName: 'Dry contact mode',
                category: 'F0 System',
                numericValue: 1,
                rawValue: 1,
                stringValue: 'md2 - Neutral-ground bonding',
                sortOrder: 8,
                isWritable: true,
                unit: '',
                options: [
                  { value: 0, label: 'md1 - Warning relay' },
                  { value: 1, label: 'md2 - Neutral-ground bonding' },
                ],
              },
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
    expect(screen.getByText('Modbus address')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('Dry contact mode')).toBeInTheDocument();
    expect(screen.getByText('md2 - Neutral-ground bonding')).toBeInTheDocument();

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

  it('keeps inverter power hero metrics for JK V15 telemetry with grid, battery, solar, and load power values', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-04-12T12:00:04.000Z').getTime());

    useDeviceDefinitionMock.mockReturnValue({
      version: '1',
      device: {
        id: 'jk-v15',
        name: 'JK V15',
        manufacturer: 'JK',
        model: 'V15',
        category: 'energy-storage',
        icon: 'battery',
      },
      connection: {
        transport: { type: 'ble', defaults: {} },
        protocol: { type: 'ble-frame', settings: {} },
      },
      dataSources: [],
      pollGroups: {},
      entities: [
        { id: 'grid_power', type: 'number', name: 'Grid Power', category: 'Grid', source: { bank: 'live', byteOffset: 0, unit: 'W' }, display: { precision: 0 } },
        { id: 'battery_power', type: 'number', name: 'Battery Power', category: 'Battery', source: { bank: 'live', byteOffset: 2, unit: 'W' }, display: { precision: 0 } },
        { id: 'pv_power', type: 'number', name: 'PV Power', category: 'Solar', source: { bank: 'live', byteOffset: 4, unit: 'W' }, display: { precision: 0 } },
        { id: 'output_active_power', type: 'number', name: 'Output Active Power', category: 'Output', source: { bank: 'live', byteOffset: 6, unit: 'W' }, display: { precision: 0 } },
        { id: 'total_voltage', type: 'number', name: 'Total Voltage', category: 'Pack Status', source: { bank: 'live', byteOffset: 8, unit: 'V' }, display: { precision: 2 } },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            sections: [
              {
                type: 'hero-metrics',
                metrics: [
                  { entity: 'total_voltage', color: 'emerald' },
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
          deviceId: '40904494583P',
          displayName: 'JK V15',
          definitionId: 'jk-v15',
          protocolHandler: 'ble-frame',
          enabled: true,
          isMaster: true,
          pollIntervalMilliseconds: 1000,
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
              { key: 'total_voltage', displayName: 'Total Voltage', category: 'Pack Status', numericValue: 53.2, sortOrder: 4, unit: 'V' },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('JK V15')).toBeInTheDocument();
    expect(screen.getByText('Grid')).toBeInTheDocument();
    expect(screen.getByText('Battery')).toBeInTheDocument();
    expect(screen.getByText('Solar')).toBeInTheDocument();
    expect(screen.getByText('Load')).toBeInTheDocument();
    expect(screen.getByText('0.1')).toBeInTheDocument();
    expect(screen.getByText('0.6')).toBeInTheDocument();
    expect(screen.getByText('1.3')).toBeInTheDocument();
    expect(screen.getByText('0.5')).toBeInTheDocument();
    expect(screen.queryByText('Total Voltage')).not.toBeInTheDocument();
  });

  it('keeps inverter cards collapsed while the definition is still loading', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      {
        deviceId: 'inv-1',
        displayName: 'Garage Inverter',
        definitionId: 'anenji-inverter-rs232',
        enabled: true,
        isMaster: true,
        pollIntervalMilliseconds: 500,
        lastOutcome: 'Succeeded',
        latestTelemetry: {
          collectedAt: '2026-04-12T12:00:00.000Z',
          cells: [],
          activeWarnings: [],
          parameters: [
            {
              key: 'max_charge_current',
              displayName: 'Max Charge Current',
              category: 'Charger',
              numericValue: 60,
              stringValue: '60',
              unit: 'A',
              sortOrder: 1,
            },
          ],
        },
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

    expect(await screen.findByRole('button', { name: /garage inverter/i })).toBeInTheDocument();
    expect(screen.queryByTestId('history-charts')).not.toBeInTheDocument();
    expect(screen.queryByText('Max Charge Current')).not.toBeInTheDocument();
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

  it('disables Anenji output voltage and frequency edits while load is active', async () => {
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
          id: 'output_voltage_setting',
          type: 'select',
          name: 'Output voltage',
          category: 'F1 Output',
          writable: true,
          source: { bank: 'settings', byteOffset: 10, unit: 'V' },
          write: {
            guard: {
              anyNonZero: ['output_active_power', 'load_percent', 'output_current'],
              message: 'Turn inverter output off before changing output voltage or frequency.',
            },
          },
          options: [
            { value: 2200, label: '220 V' },
            { value: 2300, label: '230 V' },
            { value: 2400, label: '240 V' },
          ],
        },
        {
          id: 'output_frequency_setting',
          type: 'select',
          name: 'Output frequency',
          category: 'F1 Output',
          writable: true,
          source: { bank: 'settings', byteOffset: 12, unit: 'Hz' },
          write: {
            guard: {
              anyNonZero: ['output_active_power', 'load_percent', 'output_current'],
              message: 'Turn inverter output off before changing output voltage or frequency.',
            },
          },
          options: [
            { value: 5000, label: '50 Hz' },
            { value: 6000, label: '60 Hz' },
          ],
        },
        {
          id: 'dry_contact_mode',
          type: 'select',
          name: 'Dry contact mode',
          category: 'F0 System',
          writable: true,
          source: { bank: 'settings', byteOffset: 16, unit: '' },
          options: [
            { value: 0, label: 'md1 - Warning relay' },
            { value: 1, label: 'md2 - Neutral-ground bonding' },
          ],
        },
      ],
      computedEntities: [],
      ui: {
        pages: {
          monitor: {
            sections: [
              {
                type: 'parameter-table',
                title: 'Writable settings',
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
          latestTelemetry: {
            collectedAt: '2026-04-19T12:00:00.000Z',
            cells: [],
            activeWarnings: [],
            parameters: [
              {
                key: 'output_voltage_setting',
                displayName: 'Output voltage',
                category: 'F1 Output',
                numericValue: 230,
                rawValue: 2300,
                stringValue: '230 V',
                sortOrder: 0,
                isWritable: true,
                unit: 'V',
                options: [
                  { value: 2200, label: '220 V' },
                  { value: 2300, label: '230 V' },
                  { value: 2400, label: '240 V' },
                ],
              },
              {
                key: 'output_frequency_setting',
                displayName: 'Output frequency',
                category: 'F1 Output',
                numericValue: 50,
                rawValue: 5000,
                stringValue: '50 Hz',
                sortOrder: 1,
                isWritable: true,
                unit: 'Hz',
                options: [
                  { value: 5000, label: '50 Hz' },
                  { value: 6000, label: '60 Hz' },
                ],
              },
              {
                key: 'output_active_power',
                displayName: 'Load Power',
                category: 'Output',
                numericValue: 540,
                rawValue: 540,
                sortOrder: 2,
                unit: 'W',
              },
              {
                key: 'dry_contact_mode',
                displayName: 'Dry contact mode',
                category: 'F0 System',
                numericValue: 1,
                rawValue: 1,
                stringValue: 'md2 - Neutral-ground bonding',
                sortOrder: 3,
                isWritable: true,
                unit: '',
                options: [
                  { value: 0, label: 'md1 - Warning relay' },
                  { value: 1, label: 'md2 - Neutral-ground bonding' },
                ],
              },
            ],
          },
        },
      ],
    });

    expect(await screen.findByText('Garage Inverter')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /garage inverter/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Writable settings section' }));

    expect(screen.getByText('Dry contact mode')).toBeInTheDocument();
    expect(screen.getByText('Output voltage')).toBeInTheDocument();
    expect(screen.getByText('Output frequency')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Output voltage' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit Output frequency' })).toBeDisabled();
    expect(screen.getAllByText('Turn inverter output off before changing output voltage or frequency.')).toHaveLength(2);
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
    fireEvent.click(screen.getByRole('button', { name: /scaled battery/i }));
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
