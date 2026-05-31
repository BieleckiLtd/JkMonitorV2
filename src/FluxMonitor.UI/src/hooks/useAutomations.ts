import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AutomationConfigResponse,
  AutomationDeviceOption,
  AutomationExpressionValidationResponse,
  AutomationLogEntry,
  AutomationRuleConfig,
  TestAutomationRuleResponse,
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

function hasCurrentValue(parameter: AutomationDeviceOption['parameters'][number]) {
  return parameter.numericValue != null
    || Boolean(parameter.stringValue?.trim())
    || parameter.booleanValue != null
    || parameter.rawValue != null;
}

function getDevicesWithMissingValues(devices: AutomationDeviceOption[]) {
  return devices
    .filter((device) => device.parameters.some((parameter) => !hasCurrentValue(parameter)))
    .map((device) => device.id);
}

function buildAutomationDevicesUrl(refreshMissingValues: boolean, deviceIds: string[] = []) {
  const params = new URLSearchParams();
  if (refreshMissingValues) {
    params.set('refreshMissingValues', 'true');
  }

  for (const deviceId of deviceIds) {
    params.append('deviceId', deviceId);
  }

  const query = params.toString();
  return query ? `/api/automations/devices?${query}` : '/api/automations/devices';
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

  useEffect(() => {
    const handleConfigChanged = () => {
      void load();
    };

    window.addEventListener('automations:config-changed', handleConfigChanged);
    return () => {
      window.removeEventListener('automations:config-changed', handleConfigChanged);
    };
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

  const testRule = useCallback(async (rule: AutomationRuleConfig): Promise<TestAutomationRuleResponse> => {
    const response = await fetch('/api/automations/rules/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule }),
    });
    if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to test automation.'));
    return (await response.json()) as TestAutomationRuleResponse;
  }, []);

  const validateExpression = useCallback(async (expression: string): Promise<AutomationExpressionValidationResponse> => {
    const response = await fetch('/api/automations/expressions/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression }),
    });
    if (!response.ok) throw new Error(await readErrorMessage(response, 'Failed to validate automation expression.'));
    return (await response.json()) as AutomationExpressionValidationResponse;
  }, []);

  return { config, isLoading, error, reload: load, saveRules, testRule, validateExpression };
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
    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [load]);

  return { log, reload: load };
}

export function useAutomationMetadata() {
  const [devices, setDevices] = useState<AutomationDeviceOption[]>([]);
  const attemptedRefreshDeviceIdsRef = useRef(new Set<string>());

  const load = useCallback(async (refreshMissingValues = false, deviceIds: string[] = []) => {
    try {
      const response = await fetch(buildAutomationDevicesUrl(refreshMissingValues, deviceIds), { cache: 'no-store' });
      if (response.ok) {
        setDevices((await response.json()) as AutomationDeviceOption[]);
      }
    } catch {
      // ignore metadata refresh failures
    }
  }, []);

  const reload = useCallback(async () => {
    attemptedRefreshDeviceIdsRef.current.clear();
    await load(true);
  }, [load]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const unresolvedDeviceIds = getDevicesWithMissingValues(devices)
      .filter((deviceId) => !attemptedRefreshDeviceIdsRef.current.has(deviceId));

    if (unresolvedDeviceIds.length === 0) {
      return;
    }

    for (const deviceId of unresolvedDeviceIds) {
      attemptedRefreshDeviceIdsRef.current.add(deviceId);
    }

    void load(true, unresolvedDeviceIds);
  }, [devices, load]);

  return { devices, reload };
}
