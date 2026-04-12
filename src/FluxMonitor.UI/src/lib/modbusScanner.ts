import type { ModbusScannerReadResult, ModbusScannerRegisterValue } from '../pages/system-page/types';

export type ModbusDecodeMode = 'ascii' | 'signed-int' | 'unsigned-int' | 'hex' | 'binary' | 'float';

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
