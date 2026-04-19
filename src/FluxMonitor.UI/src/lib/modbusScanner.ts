import type { ModbusScannerReadResult, ModbusScannerRegisterValue } from '../pages/system-page/types';

export type ModbusDecodeMode = 'ascii' | 'signed-int' | 'unsigned-int' | 'hex' | 'binary' | 'float';
export type ModbusMatrixDisplayMode = 'hex' | 'unsigned' | 'signed' | 'ascii' | 'binary';

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
