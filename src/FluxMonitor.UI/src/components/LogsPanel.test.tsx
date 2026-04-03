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

  it('fills the available height and keeps the log list as the scrollable region', async () => {
    const { container } = render(<LogsPanel />);

    await screen.findByText('Polling failed for device inverter-1.');

    const card = container.querySelector('[data-slot="card"]');
    if (!card) {
      throw new Error('Expected the logs panel card to render.');
    }

    expect(card).toHaveClass('flex-1');

    const scrollArea = Array.from(container.querySelectorAll('div')).find((element) => {
      const className = element.className;
      return typeof className === 'string'
        && className.includes('min-h-0')
        && className.includes('flex-1')
        && className.includes('overflow-y-auto');
    }) as HTMLElement | undefined;

    if (!scrollArea) {
      throw new Error('Expected the log list to render as a flexing scroll area.');
    }

    expect(scrollArea).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto');
  });
});
