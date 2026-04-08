import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesPage } from './DevicesPage';

describe('DevicesPage', () => {
  let holdFollowUpScan = false;
  let resolveFollowUpScan: (() => void) | null = null;

  beforeEach(() => {
    holdFollowUpScan = false;
    resolveFollowUpScan = null;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const parsedUrl = new URL(url, 'http://localhost');

      if (url === '/api/devices/config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { devices: unknown[] };
        return {
          ok: true,
          json: async () => ({ devices: body.devices }),
        } as Response;
      }

      if (url === '/api/devices/config') {
        return {
          ok: true,
          json: async () => ({ devices: [] }),
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
              transportType: 'serial',
              isTransportSupported: true,
            },
            {
              id: 'jk-inverter-bms-ble',
              name: 'JK Inverter BMS (BLE)',
              manufacturer: 'JK',
              model: 'JK-PB2A16S20P',
              transportType: 'ble',
              isTransportSupported: true,
            },
          ]),
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

  it('renders a BLE address input for supported BLE definitions', async () => {
    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    expect(await screen.findByText(/^JK Inverter BMS$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^JK Inverter BMS \(BLE\)$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));

    expect(await screen.findByText(/scan and choose a nearby ble device/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeDisabled();
  });

  it('shows quick BLE results before the follow-up scan completes', async () => {
    holdFollowUpScan = true;

    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));

    fireEvent.click(screen.getByRole('button', { name: /scan nearby/i }));

    await waitFor(() => {
      const scanRequests = vi.mocked(globalThis.fetch).mock.calls
        .map(([input]) => String(input))
        .filter((url) => url.startsWith('/api/devices/ble/scan?'));
      expect(scanRequests).toContain('/api/devices/ble/scan?definitionId=jk-inverter-bms-ble&timeoutMs=1000&returnOnFirstMatch=true');
      expect(scanRequests).toContain('/api/devices/ble/scan?definitionId=jk-inverter-bms-ble&timeoutMs=8000&returnOnFirstMatch=false');
    });

    expect(await screen.findByText(/verified jk bms/i)).toBeInTheDocument();
    expect(screen.getByText(/-54 dBm/i)).toBeInTheDocument();
    expect(screen.getByText(/quick results shown\. looking for more nearby candidates/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /select ble device 11:22:33:44:55:66/i })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(resolveFollowUpScan).not.toBeNull();
    });

    resolveFollowUpScan?.();

    expect(await screen.findByRole('button', { name: /select ble device 11:22:33:44:55:66/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /select ble device aa:bb:cc:dd:ee:ff/i }));

    expect(screen.getByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i)).toHaveValue('AA:BB:CC:DD:EE:FF');
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });

  it('lets a stopped device switch connection without changing its device id', async () => {
    render(<DevicesPage />);

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

  it('shows a waiting message instead of a blank first-poll failure when start is still in progress', async () => {
    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(screen.getByRole('button', { name: /add jk inverter bms using bluetooth/i }));

    fireEvent.change(screen.getByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i), {
      target: { value: 'C8:47:80:3A:5C:05' }
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole('button', { name: /start/i }));

    expect(await screen.findByText(/device start requested\. waiting for first poll result/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Device started but first poll failed:\s*$/i)).not.toBeInTheDocument();
  });
});
