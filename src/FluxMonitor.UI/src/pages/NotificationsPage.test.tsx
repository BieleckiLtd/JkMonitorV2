import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationsPage } from './NotificationsPage';
import type { DeviceOption, NotificationConfigResponse } from '../types/notification';

const saveRulesMock = vi.fn();

vi.mock('../hooks/useNotifications', () => ({
  useNotificationConfig: () => ({
    config: {
      channels: [
        { id: 'channel-1', type: 'ntfy', name: 'Main ntfy', enabled: true, settings: {} },
      ],
      rules: [],
    } satisfies NotificationConfigResponse,
    isLoading: false,
    error: null,
    saveChannels: vi.fn(),
    saveRules: saveRulesMock,
    testChannel: vi.fn(),
  }),
  useNotificationLog: () => ({
    log: [],
    reload: vi.fn(),
  }),
  useNotificationMetadata: () => ({
    devices: [
      {
        id: 'device-1',
        name: 'Battery A',
        entities: [
          { id: 'state_of_charge', name: 'State of Charge', unit: '%' },
          { id: 'current', name: 'Current', unit: 'A' },
        ],
      },
    ] satisfies DeviceOption[],
  }),
}));

describe('NotificationsPage', () => {
  beforeEach(() => {
    saveRulesMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('selects the first device entity automatically when a device is chosen', () => {
    render(<NotificationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /rules/i }));
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));

    const deviceSelect = screen.getByLabelText('Rule 1 device');
    const entitySelect = screen.getByLabelText('Rule 1 entity') as HTMLSelectElement;

    fireEvent.change(deviceSelect, { target: { value: 'device-1' } });

    expect(entitySelect.value).toBe('state_of_charge');
  });

  it('blocks saving a rule without a selected entity', () => {
    render(<NotificationsPage hideHeader />);

    fireEvent.click(screen.getByRole('button', { name: /rules/i }));
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    fireEvent.click(screen.getByRole('button', { name: /save rules/i }));

    expect(screen.getByText('Rule "New rule": select a device.')).toBeInTheDocument();
    expect(saveRulesMock).not.toHaveBeenCalled();
  });
});
