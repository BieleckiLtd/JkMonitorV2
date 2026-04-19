import type { ModbusScannerReadResult, ModbusScannerRegisterValue } from '../pages/system-page/types';

export type ModbusDecodeMode = 'ascii' | 'signed-int' | 'unsigned-int' | 'hex' | 'binary' | 'float';
export type ModbusMatrixDisplayMode = 'hex' | 'unsigned' | 'signed' | 'ascii' | 'binary';
export type ModbusEntityKind = 'sensor' | 'binary_sensor' | 'text';
export type ModbusEntityDataType = 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'float64' | 'ascii' | 'hex';

export type ModbusSelectionSummary = {
  startAddress: number;
  endAddress: number;
  registerCount: number;
  byteCount: number;
  bytes: number[];
  registers: ModbusScannerRegisterValue[];
};

export type ModbusDecodedValue = {
  label: string;
  value: string;
  detail?: string;
};

export type ModbusMatrixRow = {
  rowAddress: number;
  cells: Array<ModbusScannerRegisterValue | null>;
};

export type ModbusMatrixCellDisplay = {
  primary: string;
  secondary?: string;
};

export type ModbusMatrixAnnotation = {
  id: string;
  name: string;
  category: string;
  entityType: ModbusEntityKind;
  startAddress: number;
  endAddress: number;
  dataType: ModbusEntityDataType;
  formatter?: string;
  unit?: string;
  scale?: number;
  bitMask?: number;
  colorIndex: number;
};

export type ModbusMatrixAnnotationPreview = {
  value: string;
  detail?: string;
};

export type ModbusMatrixAnnotationSegment = {
  annotationId: string;
  rowAddress: number;
  startOffset: number;
  endOffset: number;
  isStartSegment: boolean;
};

export function getSelectionSummary(
  scan: ModbusScannerReadResult | null,
  startAddress: number | null,
  endAddress: number | null,
): ModbusSelectionSummary | null {
  if (!scan || startAddress == null || endAddress == null) {
    return null;
  }

  const sortedStart = Math.min(startAddress, endAddress);
  const sortedEnd = Math.max(startAddress, endAddress);
  const registers = scan.registers.filter((register) => register.address >= sortedStart && register.address <= sortedEnd);

  if (registers.length === 0) {
    return null;
  }

  return {
    startAddress: sortedStart,
    endAddress: sortedEnd,
    registerCount: registers.length,
    byteCount: registers.length * 2,
    bytes: registers.flatMap((register) => [register.highByte, register.lowByte]),
    registers,
  };
}

export function decodeSelection(
  selection: ModbusSelectionSummary | null,
  mode: ModbusDecodeMode,
): ModbusDecodedValue[] {
  if (!selection) {
    return [];
  }

  switch (mode) {
    case 'ascii':
      return decodeAscii(selection.bytes);
    case 'signed-int':
      return decodeInteger(selection.bytes, true);
    case 'unsigned-int':
      return decodeInteger(selection.bytes, false);
    case 'hex':
      return decodeHex(selection.bytes);
    case 'binary':
      return decodeBinary(selection.bytes);
    case 'float':
      return decodeFloat(selection.bytes);
    default:
      return [];
  }
}

export function buildRegisterMatrix(
  scan: ModbusScannerReadResult | null,
  columnCount: number,
): ModbusMatrixRow[] {
  if (!scan || !Number.isFinite(columnCount) || columnCount < 1) {
    return [];
  }

  const rows: ModbusMatrixRow[] = [];

  for (let index = 0; index < scan.registers.length; index += columnCount) {
    const slice = scan.registers.slice(index, index + columnCount);
    rows.push({
      rowAddress: slice[0]?.address ?? scan.startRegister + index,
      cells: Array.from({ length: columnCount }, (_, offset) => slice[offset] ?? null),
    });
  }

  return rows;
}

export function formatRegisterValue(
  register: ModbusScannerRegisterValue,
  mode: ModbusMatrixDisplayMode,
): ModbusMatrixCellDisplay {
  switch (mode) {
    case 'hex':
      return {
        primary: register.hexValue,
        secondary: `${toByteBinary(register.highByte)} ${toByteBinary(register.lowByte)}`,
      };
    case 'unsigned':
      return {
        primary: register.unsignedValue.toString(),
        secondary: register.hexValue,
      };
    case 'signed':
      return {
        primary: toSignedWord(register.unsignedValue).toString(),
        secondary: register.hexValue,
      };
    case 'ascii':
      return {
        primary: `${toAsciiChar(register.highByte)}${toAsciiChar(register.lowByte)}`,
        secondary: register.hexValue,
      };
    case 'binary':
      return {
        primary: `${toByteBinary(register.highByte)} ${toByteBinary(register.lowByte)}`,
        secondary: register.hexValue,
      };
    default:
      return {
        primary: register.hexValue,
      };
  }
}

export function decodeAnnotationPreview(
  scan: ModbusScannerReadResult | null,
  annotation: ModbusMatrixAnnotation,
): ModbusMatrixAnnotationPreview {
  const registers = getRegistersInRange(scan, annotation.startAddress, annotation.endAddress);
  if (registers.length === 0) {
    return { value: 'No registers selected' };
  }

  const bytes = registers.flatMap((register) => [register.highByte, register.lowByte]);
  const scale = annotation.scale ?? 1;

  switch (annotation.dataType) {
    case 'ascii':
      return {
        value: bytes.map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.').join('').trim() || '""',
        detail: `${registers.length} register${registers.length === 1 ? '' : 's'}`,
      };
    case 'hex':
      return {
        value: bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '),
        detail: `${registers.length} register${registers.length === 1 ? '' : 's'}`,
      };
    case 'uint16':
    case 'int16':
    case 'uint32':
    case 'int32': {
      const width = annotation.dataType.endsWith('32') ? 4 : 2;
      if (bytes.length !== width) {
        return { value: `Select ${width / 2} registers`, detail: annotation.dataType };
      }

      const maskedValue = applyBitMask(bytesToUnsignedBigInt(bytes), annotation.bitMask);
      const value = annotation.dataType.startsWith('int')
        ? signedValueFromMasked(maskedValue, width * 8)
        : maskedValue;
      return {
        value: formatScaledNumeric(value, scale, annotation.unit),
        detail: annotation.bitMask != null && annotation.bitMask !== 0 ? `mask ${toWordHex(annotation.bitMask)}` : annotation.dataType,
      };
    }
    case 'float32': {
      if (bytes.length !== 4) {
        return { value: 'Select 2 registers', detail: 'float32' };
      }

      const view = new DataView(Uint8Array.from(bytes).buffer);
      const value = view.getFloat32(0, false) * scale;
      return {
        value: `${trimNumber(value)}${annotation.unit ? ` ${annotation.unit}` : ''}`,
        detail: annotation.formatter?.trim() || 'float32',
      };
    }
    case 'float64': {
      if (bytes.length !== 8) {
        return { value: 'Select 4 registers', detail: 'float64' };
      }

      const view = new DataView(Uint8Array.from(bytes).buffer);
      const value = view.getFloat64(0, false) * scale;
      return {
        value: `${trimNumber(value)}${annotation.unit ? ` ${annotation.unit}` : ''}`,
        detail: annotation.formatter?.trim() || 'float64',
      };
    }
    default:
      return { value: 'Unsupported data type' };
  }
}

export function buildAnnotationSegments(
  rows: ModbusMatrixRow[],
  annotations: ModbusMatrixAnnotation[],
  columnCount: number,
): Map<number, ModbusMatrixAnnotationSegment[]> {
  const segmentsByRow = new Map<number, ModbusMatrixAnnotationSegment[]>();

  for (const annotation of annotations) {
    const start = Math.min(annotation.startAddress, annotation.endAddress);
    const end = Math.max(annotation.startAddress, annotation.endAddress);

    for (const row of rows) {
      const rowStart = row.rowAddress;
      const rowEnd = row.rowAddress + columnCount - 1;
      const overlapStart = Math.max(start, rowStart);
      const overlapEnd = Math.min(end, rowEnd);

      if (overlapStart > overlapEnd) {
        continue;
      }

      const segments = segmentsByRow.get(row.rowAddress) ?? [];
      segments.push({
        annotationId: annotation.id,
        rowAddress: row.rowAddress,
        startOffset: overlapStart - rowStart,
        endOffset: overlapEnd - rowStart,
        isStartSegment: overlapStart === start,
      });
      segmentsByRow.set(row.rowAddress, segments);
    }
  }

  return segmentsByRow;
}

export function getRegistersInRange(
  scan: ModbusScannerReadResult | null,
  startAddress: number,
  endAddress: number,
): ModbusScannerRegisterValue[] {
  if (!scan) {
    return [];
  }

  const minAddress = Math.min(startAddress, endAddress);
  const maxAddress = Math.max(startAddress, endAddress);
  return scan.registers.filter((register) => register.address >= minAddress && register.address <= maxAddress);
}

function decodeAscii(bytes: number[]): ModbusDecodedValue[] {
  return [{
    label: 'ASCII',
    value: bytes.map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.').join(''),
    detail: `${bytes.length} byte${bytes.length === 1 ? '' : 's'}`,
  }];
}

function decodeInteger(bytes: number[], signed: boolean): ModbusDecodedValue[] {
  const value = signed ? bytesToSignedBigInt(bytes) : bytesToUnsignedBigInt(bytes);

  return [{
    label: signed ? 'Signed integer' : 'Unsigned integer',
    value: value.toString(),
    detail: `${bytes.length * 8}-bit big-endian`,
  }];
}

function decodeHex(bytes: number[]): ModbusDecodedValue[] {
  return [{
    label: 'Hexadecimal',
    value: bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' '),
    detail: `${bytes.length} byte${bytes.length === 1 ? '' : 's'}`,
  }];
}

function decodeBinary(bytes: number[]): ModbusDecodedValue[] {
  return [{
    label: 'Binary',
    value: bytes.map((byte) => byte.toString(2).padStart(8, '0')).join(' '),
    detail: `${bytes.length} byte${bytes.length === 1 ? '' : 's'}`,
  }];
}

function decodeFloat(bytes: number[]): ModbusDecodedValue[] {
  if (bytes.length === 4) {
    const view = new DataView(Uint8Array.from(bytes).buffer);
    const value = view.getFloat32(0, false);
    return [{
      label: 'Float32',
      value: Number.isFinite(value) ? value.toString() : 'Unsupported',
      detail: 'IEEE 754 big-endian',
    }];
  }

  if (bytes.length === 8) {
    const view = new DataView(Uint8Array.from(bytes).buffer);
    const value = view.getFloat64(0, false);
    return [{
      label: 'Float64',
      value: Number.isFinite(value) ? value.toString() : 'Unsupported',
      detail: 'IEEE 754 big-endian',
    }];
  }

  return [{
    label: 'Floating-point',
    value: 'Select 2 registers for Float32 or 4 registers for Float64.',
  }];
}

function bytesToUnsignedBigInt(bytes: number[]) {
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value;
}

function bytesToSignedBigInt(bytes: number[]) {
  const unsignedValue = bytesToUnsignedBigInt(bytes);
  const bitCount = BigInt(bytes.length * 8);
  const signBit = 1n << (bitCount - 1n);
  return (unsignedValue & signBit) === 0n
    ? unsignedValue
    : unsignedValue - (1n << bitCount);
}

function toSignedWord(value: number) {
  return value > 0x7fff ? value - 0x1_0000 : value;
}

function toAsciiChar(value: number) {
  return value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
}

function toByteBinary(value: number) {
  return value.toString(2).padStart(8, '0');
}

function applyBitMask(value: bigint, bitMask?: number) {
  if (bitMask == null || bitMask === 0) {
    return value;
  }

  return value & BigInt(bitMask >>> 0);
}

function signedValueFromMasked(value: bigint, bitCount: number) {
  const bits = BigInt(bitCount);
  const signBit = 1n << (bits - 1n);
  return (value & signBit) === 0n ? value : value - (1n << bits);
}

function formatScaledNumeric(value: bigint, scale: number, unit?: string) {
  const numberValue = Number(value) * scale;
  if (Number.isFinite(numberValue) && Number.isSafeInteger(Number(value))) {
    return `${trimNumber(numberValue)}${unit ? ` ${unit}` : ''}`;
  }

  return `${value.toString()}${unit ? ` ${unit}` : ''}`;
}

function trimNumber(value: number) {
  return Number.isInteger(value) ? value.toString() : value.toFixed(3).replace(/\.?0+$/, '');
}

function toWordHex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}
