import { useCallback, useEffect, useState } from 'react';
import type {
  NotificationConfigResponse,
  NotificationChannelConfig,
  NotificationRuleConfig,
  NotificationLogEntry,
  DeviceOption,
  TestChannelResponse,
} from '../types/notification';

async function readErrorMessage(response: Response, fallbackMessage: string) {
  try {
    const payload = await response.json() as {
      detail?: string;
      error?: string;
      title?: string;
      errors?: Record<string, string[]>;
    };

    const validationMessages = Object.values(payload.errors ?? {}).flat().filter(Boolean);
    return validationMessages[0] ?? payload.detail ?? payload.error ?? payload.title ?? fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

export function useNotificationConfig() {
  const [config, setConfig] = useState<NotificationConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/notifications');
      if (!response.ok) throw new Error('Failed to load notification config.');
      const data = (await response.json()) as NotificationConfigResponse;
      setConfig(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveChannels = useCallback(async (channels: NotificationChannelConfig[]) => {
    const response = await fetch('/api/notifications/channels', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels }),
    });
    if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save channels.'));
    const data = (await response.json()) as NotificationConfigResponse;
    setConfig(data);
    return data;
  }, []);

  const saveRules = useCallback(async (rules: NotificationRuleConfig[]) => {
    const response = await fetch('/api/notifications/rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save rules.'));
    const data = (await response.json()) as NotificationConfigResponse;
    setConfig(data);
    return data;
  }, []);

  const testChannel = useCallback(async (channelId: string): Promise<TestChannelResponse> => {
    const response = await fetch('/api/notifications/channels/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId }),
    });
    return (await response.json()) as TestChannelResponse;
  }, []);

  return { config, isLoading, error, reload: load, saveChannels, saveRules, testChannel };
}

export function useNotificationLog() {
  const [log, setLog] = useState<NotificationLogEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/notifications/log');
      if (response.ok) {
        setLog((await response.json()) as NotificationLogEntry[]);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { log, reload: load };
}

export function useNotificationMetadata() {
  const [devices, setDevices] = useState<DeviceOption[]>([]);

  useEffect(() => {
    const loadMeta = async () => {
      try {
        const devRes = await fetch('/api/notifications/devices');
        if (devRes.ok) setDevices((await devRes.json()) as DeviceOption[]);
      } catch { /* ignore */ }
    };
    void loadMeta();
  }, []);

  return { devices };
}
