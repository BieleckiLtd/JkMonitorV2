import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesPage } from './DevicesPage';

function renderPage(ui = <DevicesPage />) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('DevicesPage', () => {
  let holdFollowUpScan = false;
  let resolveFollowUpScan: (() => void) | null = null;
  let initialDevicesResponse: unknown[] = [];
  let initialRememberedDeviceIds: string[] = [];

  const definitionDetailsById = {
    'jk-inverter-bms': {
      version: '1.0.0',
      device: {
        id: 'jk-inverter-bms',
        name: 'JK Inverter BMS',
        manufacturer: 'JK',
        model: 'JK-PB2A16S20P',
        category: 'Battery',
      },
      connection: {
        transport: {
          type: 'serial',
          defaults: {
            baudRate: 115200,
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            readTimeoutMs: 1000,
            writeTimeoutMs: 1000,
          },
        },
        protocol: {
          type: 'modbus',
          settings: {
            defaultSlaveAddress: 1,
            interFrameDelayMs: 100,
            retries: 1,
            byteOrder: 'big-endian',
          },
        },
      },
      dataSources: [
        {
          id: 'live',
          name: 'Live Data',
          pollGroup: 'fast',
        },
      ],
      pollGroups: {
        fast: {
          intervalMs: 1000,
          description: 'Fast polling',
        },
      },
      entities: [],
    },
    'jk-inverter-bms-ble': {
      version: '1.0.0',
      device: {
        id: 'jk-inverter-bms-ble',
        name: 'JK Inverter BMS (BLE)',
        manufacturer: 'JK',
        model: 'JK-PB2A16S20P',
        category: 'Battery',
      },
      connection: {
        transport: {
          type: 'ble',
          defaults: {
            serviceUuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
            notifyCharacteristicUuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
            writeCharacteristicUuid: '0000ffe2-0000-1000-8000-00805f9b34fb',
            connectionTimeoutMs: 20000,
            reconnectDelayMs: 5000,
          },
        },
        protocol: {
          type: 'ble-frame',
          settings: {
            byteOrder: 'little-endian',
            responseFrameSize: 300,
            checksumType: 'sum8',
            requestFrameSize: 20,
            requestPreamble: [85, 170],
            responsePreamble: [121],
          },
        },
      },
      dataSources: [
        {
          id: 'live',
          name: 'Live Data',
          pollGroup: 'fast',
          readMode: 'notify-stream',
        },
      ],
      pollGroups: {
        fast: {
          intervalMs: 1000,
          description: 'Fast polling',
        },
      },
      entities: [],
    },
  } as const;

  beforeEach(() => {
    holdFollowUpScan = false;
    resolveFollowUpScan = null;
    initialDevicesResponse = [];
    initialRememberedDeviceIds = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const parsedUrl = new URL(url, 'http://localhost');

      if (url === '/api/devices/config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { devices: unknown[] };
        return {
          ok: true,
          json: async () => ({ devices: body.devices, rememberedDeviceIds: initialRememberedDeviceIds }),
        } as Response;
      }

      if (url === '/api/devices/config') {
        return {
          ok: true,
          json: async () => ({ devices: initialDevicesResponse, rememberedDeviceIds: initialRememberedDeviceIds }),
        } as Response;
      }

      if (url === '/api/devices/current') {
        return {
          ok: true,
          json: async () => ([]),
        } as Response;
      }

      if (url === '/api/definitions') {
        return {
          ok: true,
          json: async () => ([
            {
              id: 'jk-inverter-bms',
              name: 'JK Inverter BMS',
              manufacturer: 'JK',
              model: 'JK-PB2A16S20P',
              category: 'energy-storage',
              transportType: 'serial',
              isTransportSupported: true,
            },
            {
              id: 'jk-inverter-bms-ble',
              name: 'JK Inverter BMS (BLE)',
              manufacturer: 'JK',
              model: 'JK-PB2A16S20P',
              category: 'energy-storage',
              transportType: 'ble',
              isTransportSupported: true,
            },
          ]),
        } as Response;
      }

      if (parsedUrl.pathname.startsWith('/api/definitions/')) {
        const definitionId = decodeURIComponent(parsedUrl.pathname.replace('/api/definitions/', ''));
        const definition = definitionDetailsById[definitionId as keyof typeof definitionDetailsById];
        if (!definition) {
          throw new Error(`Unhandled definition request: ${url}`);
        }

        return {
          ok: true,
          json: async () => definition,
        } as Response;
      }

      if (url === '/api/devices/ports') {
        return {
          ok: true,
          json: async () => ({ ports: [] }),
        } as Response;
      }

      if (url === '/api/devices/device-1/start') {
        return {
          ok: true,
          json: async () => ({
            deviceId: 'device-1',
            started: true,
            outcome: 'Started',
            error: null,
            message: 'Device started but first poll failed:',
          }),
        } as Response;
      }

      if (url.startsWith('/api/devices/ble/scan?')) {
        const timeoutMs = parsedUrl.searchParams.get('timeoutMs');
        const returnOnFirstMatch = parsedUrl.searchParams.get('returnOnFirstMatch');

        if (timeoutMs === '1000' && returnOnFirstMatch === 'true') {
          return {
            ok: true,
            json: async () => ({
              devices: [
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  alias: 'JK-BMS',
                  name: 'JK Smart BMS',
                  displayName: 'JK-BMS',
                  isConnected: false,
                  isPaired: true,
                  rssi: -54,
                  manufacturerData: ['0x07D0: 4A4B424D53'],
                  advertisedServiceUuids: ['0000ffe0-0000-1000-8000-00805f9b34fb'],
                  isDefinitionVerified: true,
                  verificationLabel: 'Verified JK BMS',
                  verificationDetails: 'JK · JK-PB2A16S20P · Battery-1',
                },
              ],
            }),
          } as Response;
        }

        if (timeoutMs === '8000' && returnOnFirstMatch === 'false') {
          const response = {
            ok: true,
            json: async () => ({
              devices: [
                {
                  address: 'AA:BB:CC:DD:EE:FF',
                  alias: 'JK-BMS',
                  name: 'JK Smart BMS',
                  displayName: 'JK-BMS',
                  isConnected: false,
                  isPaired: true,
                  rssi: -54,
                  manufacturerData: ['0x07D0: 4A4B424D53'],
                  advertisedServiceUuids: ['0000ffe0-0000-1000-8000-00805f9b34fb'],
                  isDefinitionVerified: true,
                  verificationLabel: 'Verified JK BMS',
                  verificationDetails: 'JK · JK-PB2A16S20P · Battery-1',
                },
                {
                  address: '11:22:33:44:55:66',
                  alias: 'JK-BMS-2',
                  name: 'JK Smart BMS 2',
                  displayName: 'JK-BMS-2',
                  isConnected: false,
                  isPaired: false,
                  rssi: -61,
                  manufacturerData: ['0x07D0: 4A4B424D5332'],
                  advertisedServiceUuids: ['0000ffe0-0000-1000-8000-00805f9b34fb'],
                  isDefinitionVerified: true,
                  verificationLabel: 'Service match',
                  verificationDetails: 'Advertises the expected BLE service.',
                },
              ],
            }),
          } as Response;

          if (holdFollowUpScan) {
            return new Promise<Response>((resolve) => {
              resolveFollowUpScan = () => resolve(response);
            });
          }

          return response;
        }

        return {
          ok: true,
          json: async () => ({
            devices: [
              {
                address: 'AA:BB:CC:DD:EE:FF',
                alias: 'JK-BMS',
                name: 'JK Smart BMS',
                displayName: 'JK-BMS',
                isConnected: false,
                isPaired: true,
                rssi: -54,
                manufacturerData: ['0x07D0: 4A4B424D53'],
                advertisedServiceUuids: ['0000ffe0-0000-1000-8000-00805f9b34fb'],
                isDefinitionVerified: true,
                verificationLabel: 'Verified JK BMS',
                verificationDetails: 'JK · JK-PB2A16S20P · Battery-1',
              },
            ],
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

  it('renders the BLE scan picker for supported BLE definitions and can fall back to manual add', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    expect(await screen.findByText(/^JK Inverter BMS$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^JK Inverter BMS \(BLE\)$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));

    expect(await screen.findByText(/jk inverter bms nearby/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add selected/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /add manually/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add manually/i }));

    expect(await screen.findByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeDisabled();
  });

  it('shows quick BLE results before the follow-up scan completes', async () => {
    holdFollowUpScan = true;

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));

    await waitFor(() => {
      const scanRequests = vi.mocked(globalThis.fetch).mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.startsWith('/api/devices/ble/scan?'));
      expect(scanRequests).toContain('/api/devices/ble/scan?definitionId=jk-inverter-bms-ble&timeoutMs=1000&returnOnFirstMatch=true');
      expect(scanRequests).toContain('/api/devices/ble/scan?definitionId=jk-inverter-bms-ble&timeoutMs=8000&returnOnFirstMatch=false');
    });

    expect(await screen.findByText(/verified jk bms/i)).toBeInTheDocument();
    expect(screen.getByText(/-54 dBm/i)).toBeInTheDocument();
    expect(screen.getByText(/quick matches are shown first while the scan keeps listening for more devices/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /select ble device 11:22:33:44:55:66/i })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(resolveFollowUpScan).not.toBeNull();
    });

    resolveFollowUpScan?.();

    expect(await screen.findByRole('button', { name: /select ble device 11:22:33:44:55:66/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /select ble device aa:bb:cc:dd:ee:ff/i }));
    fireEvent.click(screen.getByRole('button', { name: /add selected/i }));

    expect(await screen.findByDisplayValue('AA:BB:CC:DD:EE:FF')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('does not show BLE devices that are already added for the same definition', async () => {
    initialDevicesResponse = [
      {
        deviceId: 'device-1',
        displayName: 'JK Inverter BMS',
        definitionId: 'jk-inverter-bms-ble',
        transportPortName: 'AA:BB:CC:DD:EE:FF',
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
      },
    ];

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /select ble device aa:bb:cc:dd:ee:ff/i })).not.toBeInTheDocument();
    });

    expect(await screen.findByRole('button', { name: /select ble device 11:22:33:44:55:66/i })).toBeInTheDocument();
  });

  it('lets a stopped device switch connection without changing its device id', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using usb \/ serial/i }));

    expect(await screen.findByRole('combobox', { name: /serial port/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('device-1')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /display name/i })).toHaveValue('JK Inverter BMS');

    fireEvent.change(screen.getByRole('combobox', { name: /connection/i }), {
      target: { value: 'jk-inverter-bms-ble' },
    });

    expect(await screen.findByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('device-1')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /display name/i })).toHaveValue('JK Inverter BMS');
    expect(screen.queryByRole('combobox', { name: /serial port/i })).not.toBeInTheDocument();
  });

  it('hides polling and master controls for BLE notification-stream devices', async () => {
    initialDevicesResponse = [
      {
        deviceId: 'device-1',
        displayName: 'JK Inverter BMS',
        definitionId: 'jk-inverter-bms-ble',
        definitionVersion: '1.0.0',
        transportPortName: 'AA:BB:CC:DD:EE:FF',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms-ble'],
      },
    ];

    renderPage();

    expect(await screen.findByText(/connection: bluetooth .* notification stream/i)).toBeInTheDocument();
    expect(screen.queryByText(/effective poll/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/effective poll interval/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/is master/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText(/definition overrides/i));

    expect(screen.queryByText(/protocol settings/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/poll groups/i)).not.toBeInTheDocument();
    expect(screen.getByText(/transport defaults/i)).toBeInTheDocument();
  });

  it('shows a waiting message instead of a blank first-poll failure when start is still in progress', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add manually/i }));

    fireEvent.change(await screen.findByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i), {
      target: { value: 'C8:47:80:3A:5C:05' }
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(await screen.findByText(/device start requested\. waiting for first poll result/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Device started but first poll failed:\s*$/i)).not.toBeInTheDocument();
  });

  it('keeps focus while editing the device id', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using usb \/ serial/i }));

    const deviceIdInput = await screen.findByDisplayValue('device-1');
    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
        String(input) === '/api/devices/config' && init?.method === 'PUT')).toBeDefined();
    });
    vi.mocked(globalThis.fetch).mockClear();
    deviceIdInput.focus();

    fireEvent.change(deviceIdInput, { target: { value: 'device-1a' } });
    expect(screen.getByDisplayValue('device-1a')).toHaveFocus();

    fireEvent.change(screen.getByDisplayValue('device-1a'), { target: { value: 'device-1ab' } });
    expect(screen.getByDisplayValue('device-1ab')).toHaveFocus();
  });

  it('does not autosave device id changes until the field loses focus', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using usb \/ serial/i }));

    const deviceIdInput = await screen.findByDisplayValue('device-1');
    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
        String(input) === '/api/devices/config' && init?.method === 'PUT')).toBeDefined();
    });

    const getConfigSaveCount = () => vi.mocked(globalThis.fetch).mock.calls.filter(([input, init]) =>
      String(input) === '/api/devices/config' && init?.method === 'PUT').length;
    const initialConfigSaveCount = getConfigSaveCount();

    deviceIdInput.focus();

    fireEvent.change(deviceIdInput, { target: { value: 'device-1a' } });
    await new Promise((resolve) => window.setTimeout(resolve, 700));

    expect(screen.getByDisplayValue('device-1a')).toHaveFocus();
    expect(getConfigSaveCount()).toBe(initialConfigSaveCount);

    fireEvent.change(screen.getByDisplayValue('device-1a'), { target: { value: 'device-1ab' } });
    await new Promise((resolve) => window.setTimeout(resolve, 700));

    expect(screen.getByDisplayValue('device-1ab')).toHaveFocus();
    expect(getConfigSaveCount()).toBe(initialConfigSaveCount);

    fireEvent.blur(screen.getByDisplayValue('device-1ab'));

    await waitFor(() => {
      expect(getConfigSaveCount()).toBeGreaterThan(initialConfigSaveCount);
    }, { timeout: 1500 });
  });

  it('does not autosave text input changes until the field loses focus', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using usb \/ serial/i }));

    await waitFor(() => {
      expect(vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
        String(input) === '/api/devices/config' && init?.method === 'PUT')).toBeDefined();
    });

    const getConfigSaveCount = () => vi.mocked(globalThis.fetch).mock.calls.filter(([input, init]) =>
      String(input) === '/api/devices/config' && init?.method === 'PUT').length;
    const initialConfigSaveCount = getConfigSaveCount();
    const displayNameInput = screen.getByRole('textbox', { name: /display name/i });

    displayNameInput.focus();

    fireEvent.change(displayNameInput, { target: { value: 'Garage battery' } });
    await new Promise((resolve) => window.setTimeout(resolve, 700));

    expect(screen.getByDisplayValue('Garage battery')).toHaveFocus();
    expect(getConfigSaveCount()).toBe(initialConfigSaveCount);

    fireEvent.change(screen.getByDisplayValue('Garage battery'), { target: { value: 'Garage battery bank' } });
    await new Promise((resolve) => window.setTimeout(resolve, 700));

    expect(screen.getByDisplayValue('Garage battery bank')).toHaveFocus();
    expect(getConfigSaveCount()).toBe(initialConfigSaveCount);

    fireEvent.blur(screen.getByDisplayValue('Garage battery bank'));

    await waitFor(() => {
      expect(getConfigSaveCount()).toBeGreaterThan(initialConfigSaveCount);
    }, { timeout: 1500 });
  });

  it('blocks duplicate device ids from being saved', async () => {
    initialDevicesResponse = [
      {
        persistedId: 1,
        deviceId: 'device-1',
        displayName: 'Battery 1',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM3',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
      {
        persistedId: 2,
        deviceId: 'device-2',
        displayName: 'Battery 2',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM4',
        bleSettingsPin: null,
        address: 2,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
    ];

    renderPage();

    const deviceIdInputs = await screen.findAllByDisplayValue(/device-[12]/);
    fireEvent.focus(deviceIdInputs[1]);
    fireEvent.change(deviceIdInputs[1], { target: { value: 'device-1' } });

    expect(await screen.findAllByText('Device ID must be unique.')).toHaveLength(2);

    fireEvent.blur(screen.getAllByDisplayValue('device-1')[1]);
    await new Promise((resolve) => window.setTimeout(resolve, 700));

    expect(vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
      String(input) === '/api/devices/config' && init?.method === 'PUT')).toBeUndefined();
  });

  it('assigns a collision-free default device id when adding a device', async () => {
    initialDevicesResponse = [
      {
        persistedId: 1,
        deviceId: 'device-1',
        displayName: 'Battery 1',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM3',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
      {
        persistedId: 2,
        deviceId: 'device-3',
        displayName: 'Battery 3',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM4',
        bleSettingsPin: null,
        address: 2,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
    ];

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using usb \/ serial/i }));

    expect(await screen.findByDisplayValue('device-2')).toBeInTheDocument();
    expect(screen.queryAllByDisplayValue('device-1')).toHaveLength(1);
    expect(screen.queryAllByDisplayValue('device-3')).toHaveLength(1);
  });

  it('offers remembered device ids except ones already used by other devices', async () => {
    initialDevicesResponse = [
      {
        persistedId: 1,
        deviceId: 'device-1',
        displayName: 'Battery 1',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM3',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
    ];
    initialRememberedDeviceIds = ['device-1', 'legacy-a', 'legacy-b'];

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /add device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using usb \/ serial/i }));

    const newDeviceIdInput = await screen.findByDisplayValue('device-2');
    const listId = newDeviceIdInput.getAttribute('list');
    expect(listId).toBeTruthy();

    const datalist = document.getElementById(String(listId));
    expect(datalist).not.toBeNull();

    const options = Array.from(datalist?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value'));
    expect(options).toContain('legacy-a');
    expect(options).toContain('legacy-b');
    expect(options).not.toContain('device-1');

    fireEvent.change(newDeviceIdInput, { target: { value: 'legacy-b' } });
    expect(screen.getByDisplayValue('legacy-b')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('legacy-b'), { target: { value: 'custom-new-id' } });
    expect(screen.getByDisplayValue('custom-new-id')).toBeInTheDocument();
  });

  it('saves poll-group overrides from an existing device snapshot', async () => {
    initialDevicesResponse = [
      {
        persistedId: 1,
        deviceId: 'device-1',
        displayName: 'Battery 1',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM3',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 4321,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: {
          ...definitionDetailsById['jk-inverter-bms'],
          pollGroups: {
            fast: {
              intervalMs: 4321,
              description: 'Fast polling',
            },
          },
        },
      },
    ];

    renderPage();

    fireEvent.click(await screen.findByText(/definition overrides/i));

    const pollIntervalInput = await screen.findByDisplayValue('4321');
    fireEvent.change(pollIntervalInput, { target: { value: '2500' } });

    const putCallBeforeBlur = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
      String(input) === '/api/devices/config' && init?.method === 'PUT');
    expect(putCallBeforeBlur).toBeUndefined();

    fireEvent.blur(pollIntervalInput);

    await waitFor(() => {
      const putCall = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
        String(input) === '/api/devices/config' && init?.method === 'PUT');
      expect(putCall).toBeDefined();

      const body = JSON.parse(String(putCall?.[1]?.body)) as { devices: Array<{ definition: { pollGroups: { fast: { intervalMs: number } } } }> };
      expect(body.devices[0]?.definition.pollGroups.fast.intervalMs).toBe(2500);
    });
  });

  it('saves the configured monitor order when a device is moved', async () => {
    initialDevicesResponse = [
      {
        persistedId: 1,
        deviceId: 'device-1',
        displayName: 'Battery 1',
        sortOrder: 0,
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM3',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
      {
        persistedId: 2,
        deviceId: 'device-2',
        displayName: 'Battery 2',
        sortOrder: 1,
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM4',
        bleSettingsPin: null,
        address: 2,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
    ];

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /move battery 1 down/i }));

    await waitFor(() => {
      const putCall = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
        String(input) === '/api/devices/config' && init?.method === 'PUT');
      expect(putCall).toBeDefined();

      const body = JSON.parse(String(putCall?.[1]?.body)) as {
        devices: Array<{ deviceId: string; sortOrder: number }>;
      };

      expect(body.devices.map((device) => device.deviceId)).toEqual(['device-2', 'device-1']);
      expect(body.devices.map((device) => device.sortOrder)).toEqual([0, 1]);
    });
  });

  it('renders only the selected device card for a routed device page', async () => {
    initialDevicesResponse = [
      {
        persistedId: 1,
        deviceId: 'device-1',
        displayName: 'Battery 1',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM3',
        bleSettingsPin: null,
        address: 1,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
      {
        persistedId: 2,
        deviceId: 'device-2',
        displayName: 'Battery 2',
        definitionId: 'jk-inverter-bms',
        definitionVersion: '1.0.0',
        transportPortName: 'COM4',
        bleSettingsPin: null,
        address: 2,
        isMaster: false,
        pollIntervalMilliseconds: 1000,
        enabled: false,
        cellVoltageSmoothingFactor: 0,
        cellVoltageSmoothingBreakoutMillivolts: 0,
        displayPrecision: {
          voltage: 2,
          cellVoltage: 3,
          current: 1,
          power: 0,
          temperature: 1,
          soc: 0,
          deltaVoltage: 3,
        },
        hasDefinitionOverride: false,
        definition: definitionDetailsById['jk-inverter-bms'],
      },
    ];

    renderPage(<DevicesPage selectedDeviceId='device-2' />);

    expect(await screen.findByText('Battery 2')).toBeInTheDocument();
    expect(screen.queryByText('Battery 1')).not.toBeInTheDocument();
  });
});
