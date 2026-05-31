import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsNavigationPanel } from './AutomationsNavigationPanel';
import type { AutomationConfigResponse, AutomationRuleConfig } from '../types/automation';

const fetchMock = vi.fn();

function createRule(overrides: Partial<AutomationRuleConfig> = {}): AutomationRuleConfig {
  return {
    id: 'rule-1',
    name: 'Morning charge',
    enabled: true,
    expression: 'time.hour == 5',
    actions: [
      {
        targetDeviceId: 'battery-a',
        targetParameterKey: 'charging_enabled',
        rawValue: 1,
      },
    ],
    cooldownMinutes: 15,
    ...overrides,
  };
}

function jsonResponse(data: AutomationConfigResponse): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe('AutomationsNavigationPanel', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the rule expression beneath the automation name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ rules: [createRule()] }));

    render(
      <MemoryRouter initialEntries={['/automations/rule-1']}>
        <AutomationsNavigationPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Morning charge')).toBeInTheDocument();
    expect(screen.getByText('time.hour == 5')).toBeInTheDocument();
  });

  it('toggles automation enabled state from the navigation item', async () => {
    const initialRule = createRule();
    const disabledRule = createRule({ enabled: false });

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ rules: [initialRule] }))
      .mockResolvedValueOnce(jsonResponse({ rules: [disabledRule] }))
      .mockResolvedValueOnce(jsonResponse({ rules: [disabledRule] }));

    render(
      <MemoryRouter initialEntries={['/automations/rule-1']}>
        <AutomationsNavigationPanel />
      </MemoryRouter>,
    );

    const toggle = await screen.findByRole('switch', { name: 'Toggle automation Morning charge' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/automations/rules', expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: [disabledRule] }),
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Toggle automation Morning charge' })).not.toBeChecked();
    });
  });
});