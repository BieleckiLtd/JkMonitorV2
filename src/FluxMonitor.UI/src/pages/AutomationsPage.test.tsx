import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsPage } from './AutomationsPage';
import type { AutomationDeviceOption } from '../types/automation';

const saveRulesMock = vi.fn();
const testRuleMock = vi.fn();
const reloadMetadataMock = vi.fn();

const devices: AutomationDeviceOption[] = [
  {
    id: 'battery-a',
    name: 'Battery A',
    parameters: [
      { id: 'state_of_charge', name: 'State of Charge', category: 'Battery', unit: '%', isWritable: false, numericValue: 84, stringValue: null, booleanValue: null, rawValue: null, options: [] },
      { id: 'charging_enabled', name: 'Charging Enabled', category: 'Control', unit: '', isWritable: true, numericValue: null, stringValue: 'On', booleanValue: true, rawValue: 1, options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'On' },
      ] },
    ],
    writableParameters: [
      { id: 'charging_enabled', name: 'Charging Enabled', category: 'Control', unit: '', isWritable: true, numericValue: null, stringValue: 'On', booleanValue: true, rawValue: 1, options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'On' },
      ] },
    ],
  },
];

vi.mock('../hooks/useAutomations', () => ({
  useAutomationConfig: () => ({
    config: { rules: [] },
    isLoading: false,
    error: null,
    saveRules: saveRulesMock,
    testRule: testRuleMock,
  }),
  useAutomationLog: () => ({
    log: [],
    reload: vi.fn(),
  }),
  useAutomationMetadata: () => ({
    devices,
    reload: reloadMetadataMock,
  }),
}));

describe('AutomationsPage', () => {
  beforeEach(() => {
    saveRulesMock.mockReset();
    testRuleMock.mockReset();
    reloadMetadataMock.mockReset();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it('builds a rule from exposed parameters and writable targets', () => {
    render(<AutomationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /add automation/i }));

    expect(screen.getByLabelText('Automation 1 action 1 device')).toHaveValue('battery-a');
    expect(screen.getByLabelText('Automation 1 action 1 parameter')).toHaveValue('charging_enabled');
    expect(screen.getByLabelText('Automation 1 action 1 value')).toHaveValue('1');
    expect(screen.getByText('current: On')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /state_of_charge/i }));
    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('battery-a.state_of_charge');
  });

  it('blocks saving an expression rule without an expression', () => {
    render(<AutomationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /add automation/i }));
    fireEvent.click(screen.getByRole('button', { name: /save automations/i }));

    expect(screen.getByText('Automation "New automation": enter an expression.')).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('keeps an unsaved rule draft across remounts', async () => {
    const firstRender = render(<AutomationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /add automation/i }));
    fireEvent.click(screen.getByRole('button', { name: /state_of_charge/i }));
    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('battery-a.state_of_charge');

    await waitFor(() => {
      expect(window.sessionStorage.getItem('fluxmonitor.automations.draft.v1')).toContain('battery-a.state_of_charge');
    });

    firstRender.unmount();
    render(<AutomationsPage hideHeader />);

    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('battery-a.state_of_charge');
  });
});
