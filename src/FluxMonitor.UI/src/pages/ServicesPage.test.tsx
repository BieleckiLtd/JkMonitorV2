import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServicesPage } from './ServicesPage';

describe('ServicesPage', () => {
  beforeEach(() => {
    let serviceInsightStopped = false;

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/system/services') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            serviceCount: 2,
            enabledServiceCount: 1,
            runningServiceCount: 1,
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

      if (url === '/api/system/packages') {
        return {
          ok: true,
          json: async () => ({
            supported: true,
            packageCount: 2,
            automaticPackageCount: 1,
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
            subtitle: serviceInsightStopped ? 'fluxmonitor.service · Inactive' : 'fluxmonitor.service · Active',
            summary: 'Main monitoring service',
            narrative: 'Installed as part of fluxmonitor.',
            metrics: [
              { label: 'Current state', value: serviceInsightStopped ? 'Inactive' : 'Active' },
              { label: 'Startup', value: 'Starts automatically' },
              { label: 'Package', value: 'fluxmonitor' },
            ],
            facts: [
              { label: 'Service name', value: 'fluxmonitor.service' },
            ],
            highlights: [serviceInsightStopped ? 'Currently Inactive.' : 'Running right now.'],
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

      if (url === '/api/system/services/stop' && init?.method === 'POST') {
        serviceInsightStopped = true;

        return {
          ok: true,
          json: async () => ({
            success: true,
            message: "Service 'fluxmonitor.service' was stopped.",
            service: {
              name: 'fluxmonitor.service',
              displayName: 'Flux Monitor',
              description: 'Main monitoring service',
              unitFileState: 'enabled',
              vendorPreset: 'enabled',
              activeState: 'inactive',
              subState: 'dead',
              isEnabled: true,
              isRunning: false,
            },
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

  it('loads services first, keeps insight hidden until selection, and lazy-loads packages', async () => {
    render(<ServicesPage />);

    expect(await screen.findByText('Flux Monitor')).toBeInTheDocument();
    expect(screen.queryByText('Package insight')).not.toBeInTheDocument();
    expect(screen.queryByText('Service insight')).not.toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/services', { cache: 'no-store' });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/system/packages', { cache: 'no-store' });

    fireEvent.click(screen.getByRole('button', { name: /packages/i }));

    expect(await screen.findByText('libfoo')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/system/packages', { cache: 'no-store' });
  });

  it('loads insight only when a service is clicked and can navigate to a related package', async () => {
    render(<ServicesPage />);

    expect(await screen.findByText('Flux Monitor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /flux monitor/i }));

    expect(await screen.findByText('Service insight')).toBeInTheDocument();
    expect(await screen.findByText(/running right now/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText('1.2.3 · Main app'));

    expect(await screen.findByText('Package insight')).toBeInTheDocument();
    expect(await screen.findByText(/collects and publishes monitor data/i)).toBeInTheDocument();
  });

  it('stops a running service from the insight panel', async () => {
    render(<ServicesPage />);

    expect(await screen.findByText('Flux Monitor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /flux monitor/i }));
    expect(await screen.findByRole('button', { name: /stop service/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /stop service/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /stop service/i })).not.toBeInTheDocument();
      expect(screen.getByText('fluxmonitor.service · Inactive')).toBeInTheDocument();
    });
  });

  it('filters the package list after the packages tab loads', async () => {
    render(<ServicesPage />);

    await screen.findByText('Flux Monitor');
    fireEvent.click(screen.getByRole('button', { name: /packages/i }));

    const packageFilter = (await screen.findByPlaceholderText(/quick filter/i)) as HTMLInputElement;
    fireEvent.change(packageFilter, { target: { value: 'libfoo' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /libfoo/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^fluxmonitor$/i })).not.toBeInTheDocument();
    });
  });
});
