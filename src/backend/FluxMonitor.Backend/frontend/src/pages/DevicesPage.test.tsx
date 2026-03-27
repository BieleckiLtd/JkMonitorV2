import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesPage } from './DevicesPage';

describe('DevicesPage', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/devices/config') {
        return {
          ok: true,
          json: async () => ({ devices: [] }),
        } as Response;
      }

      if (url === '/api/definitions') {
        return {
          ok: true,
          json: async () => ([
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

      if (url === '/api/devices/databases') {
        return {
          ok: true,
          json: async () => ({ databases: [] }),
        } as Response;
      }

      if (url.startsWith('/api/devices/ble/scan?')) {
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
    fireEvent.click(await screen.findByRole('button', { name: /jk inverter bms \(ble\)/i }));

    expect(await screen.findByText(/scan and choose a nearby ble device/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start/i })).toBeDisabled();
  });

  it('scans and suggests nearby BLE devices for selection', async () => {
    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));
    fireEvent.click(await screen.findByRole('button', { name: /jk inverter bms \(ble\)/i }));

    fireEvent.click(screen.getByRole('button', { name: /scan nearby/i }));

    await waitFor(() => {
      expect(screen.getByText(/verified jk bms/i)).toBeInTheDocument();
      expect(screen.getByText(/-54 dBm/i)).toBeInTheDocument();
      expect(screen.getByText(/manufacturer data: 0x07d0: 4a4b424d53/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /select ble device aa:bb:cc:dd:ee:ff/i }));

    expect(screen.getByPlaceholderText(/aa:bb:cc:dd:ee:ff or device alias/i)).toHaveValue('AA:BB:CC:DD:EE:FF');
    expect(screen.getByRole('button', { name: /start/i })).toBeEnabled();
  });
});
