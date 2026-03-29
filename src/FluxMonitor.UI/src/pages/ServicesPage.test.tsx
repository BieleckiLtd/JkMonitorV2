import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServicesPage } from './ServicesPage';

describe('ServicesPage', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/system/services/catalog') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            summary: {
              packageCount: 2,
              automaticPackageCount: 1,
              serviceCount: 2,
              enabledServiceCount: 1,
              runningServiceCount: 1,
            },
            packages: [
              {
                name: 'fluxmonitor',
                version: '1.2.3',
                architecture: 'arm64',
                channel: 'stable,now',
                status: 'installed',
                isAutomatic: false,
              },
              {
                name: 'libfoo',
                version: '2.0.0',
                architecture: 'arm64',
                channel: 'stable,now',
                status: 'installed,automatic',
                isAutomatic: true,
              },
            ],
            services: [
              {
                name: 'fluxmonitor.service',
                displayName: 'Flux Monitor',
                description: 'Main monitoring service',
                unitFileState: 'enabled',
                vendorPreset: 'enabled',
                activeState: 'active',
                subState: 'running',
                isEnabled: true,
                isRunning: true,
              },
              {
                name: 'backup-agent.service',
                displayName: 'Backup Agent',
                description: 'Backup helper',
                unitFileState: 'disabled',
                vendorPreset: 'disabled',
                activeState: 'inactive',
                subState: 'dead',
                isEnabled: false,
                isRunning: false,
              },
            ],
          }),
        } as Response;
      }

      if (url === '/api/system/services/insight?kind=service&id=fluxmonitor.service') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            kind: 'service',
            id: 'fluxmonitor.service',
            title: 'Flux Monitor',
            subtitle: 'fluxmonitor.service · Active',
            summary: 'Main monitoring service',
            narrative: 'Installed as part of fluxmonitor.',
            metrics: [
              { label: 'Current state', value: 'Active' },
              { label: 'Startup', value: 'Starts automatically' },
              { label: 'Package', value: 'fluxmonitor' },
            ],
            facts: [
              { label: 'Service name', value: 'fluxmonitor.service' },
            ],
            highlights: ['Running right now.'],
            relatedItems: [
              { kind: 'package', id: 'fluxmonitor', title: 'fluxmonitor', subtitle: '1.2.3 · Main app' },
            ],
          }),
        } as Response;
      }

      if (url === '/api/system/services/insight?kind=package&id=fluxmonitor') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            kind: 'package',
            id: 'fluxmonitor',
            title: 'fluxmonitor',
            subtitle: '1.2.3 · arm64',
            summary: 'Main app',
            narrative: 'Collects and publishes monitor data.',
            metrics: [
              { label: 'Installed size', value: '24 MB' },
            ],
            facts: [
              { label: 'Version', value: '1.2.3' },
            ],
            highlights: ['Provides 1 background service.'],
            relatedItems: [],
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

  it('loads the catalog, defaults to the running service, and loads package insight on click', async () => {
    render(<ServicesPage />);

    expect(await screen.findByText('Flux Monitor')).toBeInTheDocument();
    expect(screen.queryByText('What this does')).not.toBeInTheDocument();
    expect(await screen.findByText(/running right now/i)).toBeInTheDocument();

    const packageCard = screen.getByText('Installed packages').closest('[data-slot="card"]');
    expect(packageCard).not.toBeNull();
    fireEvent.click(within(packageCard as HTMLElement).getByRole('button', { name: /fluxmonitor/i }));

    await waitFor(() => {
      expect(screen.getByText(/collects and publishes monitor data/i)).toBeInTheDocument();
      expect(screen.getByText(/24 MB/i)).toBeInTheDocument();
    });
  });

  it('filters the package list with the quick filter input', async () => {
    render(<ServicesPage />);

    await screen.findByText('Flux Monitor');

    const packageCard = screen.getByText('Installed packages').closest('[data-slot="card"]');
    expect(packageCard).not.toBeNull();

    fireEvent.change(within(packageCard as HTMLElement).getByPlaceholderText(/quick filter/i), { target: { value: 'libfoo' } });

    await waitFor(() => {
      expect(within(packageCard as HTMLElement).getByRole('button', { name: /libfoo/i })).toBeInTheDocument();
      expect(within(packageCard as HTMLElement).queryByRole('button', { name: /fluxmonitor/i })).not.toBeInTheDocument();
    });
  });
});
