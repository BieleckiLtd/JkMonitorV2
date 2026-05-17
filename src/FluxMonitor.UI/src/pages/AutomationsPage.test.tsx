import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsPage } from './AutomationsPage';
import type { AutomationDeviceOption } from '../types/automation';

const saveRulesMock = vi.fn();

const devices: AutomationDeviceOption[] = [
  {
    id: 'battery-a',
    name: 'Battery A',
    parameters: [
      { id: 'state_of_charge', name: 'State of Charge', category: 'Battery', unit: '%', isWritable: false, rawValue: null, options: [] },
      { id: 'charging_enabled', name: 'Charging Enabled', category: 'Control', unit: '', isWritable: true, rawValue: 1, options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'On' },
      ] },
    ],
    writableParameters: [
      { id: 'charging_enabled', name: 'Charging Enabled', category: 'Control', unit: '', isWritable: true, rawValue: 1, options: [
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
  }),
  useAutomationLog: () => ({
    log: [],
    reload: vi.fn(),
  }),
  useAutomationMetadata: () => ({
    devices,
    reload: vi.fn(),
  }),
}));

describe('AutomationsPage', () => {
  beforeEach(() => {
    saveRulesMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('builds a rule from exposed parameters and writable targets', () => {
    render(<AutomationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /add automation/i }));

    expect(screen.getByLabelText('Automation 1 source device')).toHaveValue('battery-a');
    expect(screen.getByLabelText('Automation 1 target parameter')).toHaveValue('charging_enabled');

    fireEvent.click(screen.getByRole('button', { name: /state_of_charge/i }));
    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('state_of_charge');
  });

  it('blocks saving an expression rule without an expression', () => {
    render(<AutomationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /add automation/i }));
    fireEvent.click(screen.getByRole('button', { name: /save automations/i }));

    expect(screen.getByText('Automation "New automation": enter an expression.')).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();
  });
});
