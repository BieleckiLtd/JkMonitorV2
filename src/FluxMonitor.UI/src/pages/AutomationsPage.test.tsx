import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationsPage } from './AutomationsPage';
import type { AutomationDeviceOption, AutomationRuleConfig } from '../types/automation';

const saveRulesMock = vi.fn();
const testRuleMock = vi.fn();
const reloadMetadataMock = vi.fn();
const validateExpressionMock = vi.fn();
let configRules: AutomationRuleConfig[] = [];
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    config: { rules: configRules },
    isLoading: false,
    error: null,
    saveRules: saveRulesMock,
    testRule: testRuleMock,
    validateExpression: validateExpressionMock,
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

function renderPage(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function createSavedRule(id: string, name: string): AutomationRuleConfig {
  return {
    id,
    name,
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
  };
}

describe('AutomationsPage', () => {
  beforeEach(() => {
    configRules = [];
    saveRulesMock.mockReset();
    testRuleMock.mockReset();
    reloadMetadataMock.mockReset();
    validateExpressionMock.mockReset();
    validateExpressionMock.mockResolvedValue({ isValid: true, message: null });
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
  });

  it('builds a new automation from exposed parameters and writable targets', async () => {
    renderPage(<AutomationsPage hideHeader createNew />);

    expect(await screen.findByLabelText('Automation 1 action 1 device')).toHaveValue('battery-a');
    expect(screen.getByLabelText('Automation 1 action 1 parameter')).toHaveValue('charging_enabled');
    expect(screen.getByLabelText('Automation 1 action 1 value')).toHaveValue('1');
    expect(screen.getByText('current: On')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /battery-a/i }));
    fireEvent.click(screen.getByRole('button', { name: /state_of_charge/i }));
    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('battery-a.state_of_charge');
  });

  it('blocks saving an expression rule without an expression', async () => {
    renderPage(<AutomationsPage hideHeader createNew />);

    await screen.findByRole('button', { name: /^save$/i });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(screen.getByText('Automation "New automation": enter an expression.')).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('keeps saved automations visible when a stale draft exists', async () => {
    configRules = [createSavedRule('server-1', 'Server automation')];
    window.sessionStorage.setItem('fluxmonitor.automations.draft.v1', JSON.stringify({
      rules: [createSavedRule('draft-1', 'Draft automation')],
      tab: 'automation',
      ruleMessages: {},
      testResults: {},
      activeRuleId: 'draft-1',
    }));

    renderPage(<AutomationsPage hideHeader selectedRuleId='server-1' />);

    expect(await screen.findByDisplayValue('Server automation')).toBeInTheDocument();
    expect(screen.queryByText('Select an automation')).not.toBeInTheDocument();
  });

  it('keeps an unsaved rule draft across remounts', async () => {
    const firstRender = renderPage(<AutomationsPage hideHeader createNew />);

    await screen.findByRole('button', { name: /^save$/i });
    fireEvent.click(screen.getByRole('button', { name: /battery-a/i }));
    fireEvent.click(screen.getByRole('button', { name: /state_of_charge/i }));
    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('battery-a.state_of_charge');

    await waitFor(() => {
      expect(window.sessionStorage.getItem('fluxmonitor.automations.draft.v1')).toContain('battery-a.state_of_charge');
    });

    firstRender.unmount();
    renderPage(<AutomationsPage hideHeader createNew />);

    expect(screen.getByPlaceholderText(/state_of_charge/i)).toHaveValue('battery-a.state_of_charge');
  });

  it('blocks saving when expression validation fails', async () => {
    validateExpressionMock.mockResolvedValue({ isValid: false, message: 'Unexpected token near time.minute.' });

    renderPage(<AutomationsPage hideHeader createNew />);

    await screen.findByRole('button', { name: /^save$/i });
    fireEvent.change(screen.getByPlaceholderText(/state_of_charge/i), {
      target: { value: 'time.hour=5 and time.minute=55' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(validateExpressionMock).toHaveBeenCalledWith('time.hour=5 and time.minute=55');
    });
    expect(screen.getByText('Unexpected token near time.minute.')).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();
  });

  it('uses a GUID when saving a newly created automation', async () => {
    saveRulesMock.mockImplementation(async (rules: AutomationRuleConfig[]) => ({ rules }));

    renderPage(<AutomationsPage hideHeader createNew />);

    await screen.findByRole('button', { name: /^save$/i });
    fireEvent.change(screen.getByPlaceholderText(/state_of_charge/i), {
      target: { value: 'time.hour == 5' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(saveRulesMock).toHaveBeenCalledTimes(1);
    });

    const savedRules = saveRulesMock.mock.calls[0]?.[0] as AutomationRuleConfig[];
    expect(savedRules[0]?.id).toMatch(uuidRegex);
  });

  it('renders the values browser below the automation definition panel', async () => {
    renderPage(<AutomationsPage hideHeader createNew />);

    await screen.findByRole('button', { name: /^save$/i });

    const nameLabel = screen.getByText('Name');
    const valuesTitle = screen.getByText('Values');
    expect(nameLabel.compareDocumentPosition(valuesTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
