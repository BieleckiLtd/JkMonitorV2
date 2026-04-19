import { describe, expect, it } from 'vitest';
import {
  buildAnnotationSegments,
  buildRegisterMatrix,
  decodeAnnotationPreview,
  decodeSelection,
  formatRegisterValue,
  getSelectionSummary,
} from './modbusScanner';
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

  it('builds a row-major matrix with addresses running top-to-bottom', () => {
    const matrix = buildRegisterMatrix({
      ...scanResult,
      startRegister: 10,
      registerCount: 6,
      registers: [
        { address: 10, highByte: 0x00, lowByte: 0x0A, unsignedValue: 10, hexValue: '0x000A' },
        { address: 11, highByte: 0x00, lowByte: 0x0B, unsignedValue: 11, hexValue: '0x000B' },
        { address: 12, highByte: 0x00, lowByte: 0x0C, unsignedValue: 12, hexValue: '0x000C' },
        { address: 13, highByte: 0x00, lowByte: 0x0D, unsignedValue: 13, hexValue: '0x000D' },
        { address: 14, highByte: 0x00, lowByte: 0x0E, unsignedValue: 14, hexValue: '0x000E' },
        { address: 15, highByte: 0x00, lowByte: 0x0F, unsignedValue: 15, hexValue: '0x000F' },
      ],
    }, 3);

    expect(matrix).toHaveLength(2);
    expect(matrix[0]).toMatchObject({ rowAddress: 10 });
    expect(matrix[1]).toMatchObject({ rowAddress: 13 });
    expect(matrix[0]?.cells.map((cell) => cell?.address)).toEqual([10, 11, 12]);
    expect(matrix[1]?.cells.map((cell) => cell?.address)).toEqual([13, 14, 15]);
  });

  it('formats single register values for multiple matrix display modes', () => {
    expect(formatRegisterValue(scanResult.registers[0]!, 'ascii')).toMatchObject({
      primary: 'AB',
      secondary: '0x4142',
    });

    expect(formatRegisterValue({
      address: 9,
      highByte: 0xff,
      lowByte: 0xfe,
      unsignedValue: 0xfffe,
      hexValue: '0xFFFE',
    }, 'signed')).toMatchObject({
      primary: '-2',
      secondary: '0xFFFE',
    });
  });

  it('decodes annotation previews and builds row overlay segments', () => {
    const preview = decodeAnnotationPreview(scanResult, {
      id: 'motor_temp',
      name: 'MOTOR_TEMP',
      category: 'Thermal',
      entityType: 'sensor',
      startAddress: 2,
      endAddress: 3,
      dataType: 'float32',
      unit: 'C',
      scale: 1,
      colorIndex: 0,
    });

    expect(preview).toMatchObject({
      value: '1 C',
      detail: 'float32',
    });

    const rows = buildRegisterMatrix({
      ...scanResult,
      startRegister: 10,
      registerCount: 8,
      registers: Array.from({ length: 8 }, (_, index) => ({
        address: 10 + index,
        highByte: 0,
        lowByte: index,
        unsignedValue: index,
        hexValue: `0x000${index}`,
      })),
    }, 4);
    const segments = buildAnnotationSegments(rows, [{
      id: 'serial_no',
      name: 'SERIAL_NO',
      category: 'Identity',
      entityType: 'text',
      startAddress: 11,
      endAddress: 16,
      dataType: 'ascii',
      colorIndex: 1,
    }], 4);

    expect(segments.get(10)).toEqual([{
      annotationId: 'serial_no',
      rowAddress: 10,
      startOffset: 1,
      endOffset: 3,
      isStartSegment: true,
    }]);
    expect(segments.get(14)).toEqual([{
      annotationId: 'serial_no',
      rowAddress: 14,
      startOffset: 0,
      endOffset: 2,
      isStartSegment: false,
    }]);
  });
});
