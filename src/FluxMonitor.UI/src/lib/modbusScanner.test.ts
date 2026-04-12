import { describe, expect, it } from 'vitest';
import { decodeSelection, getSelectionSummary } from './modbusScanner';
import type { ModbusScannerReadResult } from '../pages/system-page/types';

const scanResult: ModbusScannerReadResult = {
  portName: 'COM3',
  slaveAddress: 1,
  baudRate: 9600,
  parity: 'None',
  dataBits: 8,
  stopBits: 1,
  responseTimeoutMs: 1000,
  retryCount: 1,
  registerKind: 'holding',
  startRegister: 0,
  registerCount: 4,
  registersPerRequest: 2,
  collectedAtUtc: '2026-04-12T08:00:00Z',
  totalRequests: 2,
  blocks: [],
  registers: [
    { address: 0, highByte: 0x41, lowByte: 0x42, unsignedValue: 0x4142, hexValue: '0x4142' },
    { address: 1, highByte: 0x43, lowByte: 0x44, unsignedValue: 0x4344, hexValue: '0x4344' },
    { address: 2, highByte: 0x3F, lowByte: 0x80, unsignedValue: 0x3F80, hexValue: '0x3F80' },
    { address: 3, highByte: 0x00, lowByte: 0x00, unsignedValue: 0x0000, hexValue: '0x0000' },
  ],
};

describe('modbusScanner helpers', () => {
  it('builds a contiguous selection summary from register addresses', () => {
    const summary = getSelectionSummary(scanResult, 1, 3);

    expect(summary).not.toBeNull();
    expect(summary?.startAddress).toBe(1);
    expect(summary?.endAddress).toBe(3);
    expect(summary?.registerCount).toBe(3);
    expect(summary?.bytes).toEqual([0x43, 0x44, 0x3F, 0x80, 0x00, 0x00]);
  });

  it('decodes ascii, integer, and float views from a selection', () => {
    const asciiSelection = getSelectionSummary(scanResult, 0, 1);
    const floatSelection = getSelectionSummary(scanResult, 2, 3);

    expect(decodeSelection(asciiSelection, 'ascii')[0]).toMatchObject({
      label: 'ASCII',
      value: 'ABCD',
    });

    expect(decodeSelection(asciiSelection, 'unsigned-int')[0]).toMatchObject({
      label: 'Unsigned integer',
      value: '1094861636',
    });

    expect(decodeSelection(floatSelection, 'float')[0]).toMatchObject({
      label: 'Float32',
      value: '1',
    });
  });
});
