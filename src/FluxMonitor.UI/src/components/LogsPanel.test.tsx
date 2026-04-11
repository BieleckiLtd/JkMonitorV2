import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsPanel } from './LogsPanel';

type MockLogEntry = {
  id: number;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  exception?: string | null;
};

describe('LogsPanel', () => {
  const writeText = vi.fn();
  let logEntries: MockLogEntry[];
  let totalCountOverride: number | null;

  beforeEach(() => {
    writeText.mockReset();
    logEntries = [
      {
        id: 42,
        timestamp: '2026-03-27T10:30:45.000Z',
        level: 'Error',
        category: 'FluxMonitor.Backend.Services.DeviceOrchestrator',
        message: 'Polling failed for device inverter-1.',
        exception: 'System.TimeoutException: Poll timed out.',
      },
    ];
    totalCountOverride = null;

    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText,
      },
    });

    vi.stubGlobal('confirm', vi.fn(() => true));

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/logs?')) {
        return {
          ok: true,
          json: async () => ({
            totalCount: totalCountOverride ?? logEntries.length,
            entries: logEntries,
          }),
        } as Response;
      }

      if (url === '/api/logs/delete' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { deleteAll?: boolean; entryIds?: number[] };

        if (body.deleteAll) {
          const deletedCount = logEntries.length;
          logEntries = [];

          return {
            ok: true,
            json: async () => ({ deletedCount }),
          } as Response;
        }

        const ids = new Set(body.entryIds ?? []);
        const deletedCount = logEntries.filter((entry) => ids.has(entry.id)).length;
        logEntries = logEntries.filter((entry) => !ids.has(entry.id));

        return {
          ok: true,
          json: async () => ({ deletedCount }),
        } as Response;
      }

      throw new Error(`Unhandled fetch: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it('renders a single top pager before the refresh button when multiple pages exist', async () => {
    totalCountOverride = 250;

    render(<LogsPanel />);

    const pageLabel = await screen.findByText('Page 1 of 3');
    const refreshButton = screen.getByRole('button', { name: /^refresh$/i });

    expect(screen.getAllByText('Page 1 of 3')).toHaveLength(1);
    expect(pageLabel.compareDocumentPosition(refreshButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('clears an individual log entry from the page', async () => {
    render(<LogsPanel />);

    await screen.findByText('Polling failed for device inverter-1.');

    fireEvent.click(screen.getByRole('button', { name: 'Delete log entry 42' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/logs/delete', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const deleteCall = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
      input === '/api/logs/delete' && init && typeof init === 'object' && init.method === 'POST');

    expect(deleteCall).toBeTruthy();
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ entryIds: [42] });
    expect(await screen.findByText('Cleared log entry.')).toBeInTheDocument();
    expect(screen.getByText('No log entries match the current filters.')).toBeInTheDocument();
  });

  it('clears the currently visible log entries', async () => {
    logEntries = [
      {
        id: 42,
        timestamp: '2026-03-27T10:30:45.000Z',
        level: 'Error',
        category: 'FluxMonitor.Backend.Services.DeviceOrchestrator',
        message: 'Polling failed for device inverter-1.',
        exception: 'System.TimeoutException: Poll timed out.',
      },
      {
        id: 43,
        timestamp: '2026-03-27T10:31:00.000Z',
        level: 'Warning',
        category: 'FluxMonitor.Backend.Services.RuntimeStatusBroadcaster',
        message: 'Broadcast loop reconnected after a delay.',
        exception: null,
      },
    ];

    render(<LogsPanel />);

    await screen.findByText('Broadcast loop reconnected after a delay.');

    fireEvent.click(screen.getByRole('button', { name: /^clear visible$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/logs/delete', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const deleteCall = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
      input === '/api/logs/delete' && init && typeof init === 'object' && init.method === 'POST');

    expect(deleteCall).toBeTruthy();
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ entryIds: [42, 43] });
    expect(await screen.findByText('Cleared 2 visible log entries.')).toBeInTheDocument();
    expect(screen.getByText('No log entries match the current filters.')).toBeInTheDocument();
  });

  it('clears all log entries', async () => {
    render(<LogsPanel />);

    await screen.findByText('Polling failed for device inverter-1.');

    fireEvent.click(screen.getByRole('button', { name: /^clear all$/i }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/logs/delete', expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
    });

    const deleteCall = vi.mocked(globalThis.fetch).mock.calls.find(([input, init]) =>
      input === '/api/logs/delete' && init && typeof init === 'object' && init.method === 'POST');

    expect(deleteCall).toBeTruthy();
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({ deleteAll: true });
    expect(await screen.findByText('Cleared 1 log entries.')).toBeInTheDocument();
    expect(screen.getByText('No log entries match the current filters.')).toBeInTheDocument();
  });
});
