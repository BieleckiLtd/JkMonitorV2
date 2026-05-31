import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutomationMetadata } from './useAutomations';
import type { AutomationDeviceOption } from '../types/automation';

const fetchMock = vi.fn();

function createDevice(parameterOverrides: Partial<AutomationDeviceOption['parameters'][number]> = {}): AutomationDeviceOption {
  const parameter = {
    id: 'charging_enabled',
    name: 'Charging Enabled',
    category: 'Control',
    unit: '',
    isWritable: true,
    numericValue: null,
    stringValue: null,
    booleanValue: null,
    rawValue: null,
    options: [],
    ...parameterOverrides,
  };

  return {
    id: 'battery-a',
    name: 'Battery A',
    parameters: [parameter],
    writableParameters: [parameter],
  };
}

function jsonResponse(data: AutomationDeviceOption[]): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

describe('useAutomationMetadata', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries devices with missing values once using refreshMissingValues', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([createDevice()]))
      .mockResolvedValueOnce(jsonResponse([createDevice({ booleanValue: true, rawValue: 1 })]));

    const { result } = renderHook(() => useAutomationMetadata());

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/automations/devices');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/automations/devices?refreshMissingValues=true&deviceId=battery-a');

    await waitFor(() => {
      expect(result.current.devices[0]?.parameters[0]?.booleanValue).toBe(true);
    });
  });
});