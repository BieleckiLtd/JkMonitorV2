import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationsPage } from './NotificationsPage';
import type { NotificationConfigResponse } from '../types/notification';

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
    testChannel: vi.fn(),
  }),
}));

describe('NotificationsPage', () => {
  afterEach(() => {
    cleanup();
  });

  it('keeps notifications focused on delivery channels', () => {
    render(<NotificationsPage hideHeader />);

    expect(screen.getByText('Main ntfy')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save channels/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rules/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /history/i })).not.toBeInTheDocument();
  });
});
