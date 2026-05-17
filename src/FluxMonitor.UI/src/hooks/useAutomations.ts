import { useCallback, useEffect, useState } from 'react';
import type {
  AutomationConfigResponse,
  AutomationDeviceOption,
  AutomationLogEntry,
  AutomationRuleConfig,
} from '../types/automation';

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

export function useAutomationConfig() {
  const [config, setConfig] = useState<AutomationConfigResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIsLoading(true);
      const response = await fetch('/api/automations');
      if (!response.ok) throw new Error('Failed to load automation config.');
      setConfig((await response.json()) as AutomationConfigResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveRules = useCallback(async (rules: AutomationRuleConfig[]) => {
    const response = await fetch('/api/automations/rules', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules }),
    });
    if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to save automations.'));
    const data = (await response.json()) as AutomationConfigResponse;
    setConfig(data);
    return data;
  }, []);

  return { config, isLoading, error, reload: load, saveRules };
}

export function useAutomationLog() {
  const [log, setLog] = useState<AutomationLogEntry[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/automations/log');
      if (response.ok) {
        setLog((await response.json()) as AutomationLogEntry[]);
      }
    } catch {
      // ignore log refresh failures
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { log, reload: load };
}

export function useAutomationMetadata() {
  const [devices, setDevices] = useState<AutomationDeviceOption[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/automations/devices');
      if (response.ok) {
        setDevices((await response.json()) as AutomationDeviceOption[]);
      }
    } catch {
      // ignore metadata refresh failures
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { devices, reload: load };
}
