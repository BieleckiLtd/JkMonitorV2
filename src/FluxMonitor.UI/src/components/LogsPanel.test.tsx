import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsPanel } from './LogsPanel';

describe('LogsPanel', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    writeText.mockReset();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText,
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        totalCount: 1,
        entries: [
          {
            id: 42,
            timestamp: '2026-03-27T10:30:45.000Z',
            level: 'Error',
            category: 'FluxMonitor.Backend.Services.DeviceOrchestrator',
            message: 'Polling failed for device inverter-1.',
            exception: 'System.TimeoutException: Poll timed out.',
          },
        ],
      }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('copies an individual log entry to the clipboard with its exception', async () => {
    render(<LogsPanel />);

    await screen.findByText('Polling failed for device inverter-1.');

    fireEvent.click(screen.getByRole('button', { name: 'Copy log entry 42 to clipboard' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Polling failed for device inverter-1.')
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('System.TimeoutException: Poll timed out.')
    );
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('FluxMonitor.Backend.Services.DeviceOrchestrator')
    );
  });
});
