import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
              isTransportSupported: false,
              unsupportedTransportMessage: "Transport type 'ble' is not supported yet. This build currently supports: serial.",
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

      throw new Error(`Unhandled fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows unsupported transports as unavailable in the add-device picker', async () => {
    render(<DevicesPage />);

    fireEvent.click(await screen.findByRole('button', { name: /add first device/i }));

    const bleButton = await screen.findByRole('button', { name: /jk inverter bms \(ble\)/i });
    expect(bleButton).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText(/transport type 'ble' is not supported yet/i)).toBeInTheDocument();
    });

    const supportedButton = screen
      .getAllByRole('button')
      .find(button => !button.hasAttribute('disabled') && button.textContent?.includes('JK Inverter BMS'));

    expect(supportedButton).toBeDefined();
    expect(supportedButton).toBeEnabled();
  });
});
