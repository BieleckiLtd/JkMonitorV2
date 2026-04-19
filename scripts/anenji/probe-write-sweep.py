#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import time

import serial


def crc_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def read_regs(ser: serial.Serial, slave: int, start: int, count: int) -> tuple[dict[int, int] | None, str]:
    pdu = struct.pack(">BBHH", slave, 0x03, start, count)
    frame = pdu + struct.pack("<H", crc_modbus(pdu))
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()

    expected = 3 + count * 2 + 2
    buffer = bytearray()
    started = time.time()
    while time.time() - started < 2.0 and len(buffer) < expected:
        chunk = ser.read(expected - len(buffer))
        if chunk:
            buffer.extend(chunk)
        elif buffer:
            break

    if len(buffer) < 5:
        return None, f"short:{len(buffer)}"
    if buffer[1] == 0x83:
        return None, f"exc:{buffer[2]:02x}"
    if buffer[1] != 0x03:
        return None, f"fc:{buffer[1]:02x}"

    byte_count = buffer[2]
    data = buffer[3:3 + byte_count]
    regs: dict[int, int] = {}
    for index in range(0, len(data), 2):
        if index + 1 < len(data):
            regs[start + index // 2] = struct.unpack(">H", data[index:index + 2])[0]
    return regs, "ok"


def read_registers(ser: serial.Serial, slave: int, addresses: list[int]) -> dict[str, int | str | None]:
    values: dict[str, int | str | None] = {}
    for address in addresses:
        regs, status = read_regs(ser, slave, address, 1)
        if regs and address in regs:
            values[str(address)] = regs[address]
        else:
            values[str(address)] = status
        time.sleep(0.03)
    return values


def write_fc10(ser: serial.Serial, slave: int, address: int, value: int) -> str:
    pdu = struct.pack(">BBHHB", slave, 0x10, address, 1, 2) + struct.pack(">H", value)
    frame = pdu + struct.pack("<H", crc_modbus(pdu))
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()

    buffer = bytearray()
    started = time.time()
    while time.time() - started < 2.0 and len(buffer) < 8:
        chunk = ser.read(8 - len(buffer))
        if chunk:
            buffer.extend(chunk)
        elif buffer:
            break

    if len(buffer) < 4:
        return f"timeout:{len(buffer)}"
    if buffer[1] == 0x90:
        return f"exc:{buffer[2]:02x}"
    if len(buffer) < 8:
        return f"short:{len(buffer)}"
    return "ok" if buffer[1] == 0x10 else f"fc:{buffer[1]:02x}"


def changed_keys(before: dict[str, int | str | None], after: dict[str, int | str | None]) -> list[str]:
    return [key for key, value in after.items() if before.get(key) != value]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Sweep write side-effects across candidate holding registers")
    parser.add_argument("value", type=int)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--slave", type=int, default=1)
    parser.add_argument("--delay-ms", type=int, default=500)
    parser.add_argument("--candidate", dest="candidates", type=int, action="append", required=True)
    parser.add_argument("--watch", dest="watch", type=int, action="append")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    watch = sorted(set(args.watch or [606, 607]))
    candidates = sorted(set(args.candidates))
    results: list[dict[str, object]] = []

    with serial.Serial(args.port, args.baud, timeout=1.0, write_timeout=1.0) as ser:
        for address in candidates:
            read_set = sorted(set([address, *watch]))
            before = read_registers(ser, args.slave, read_set)

            original_regs, original_status = read_regs(ser, args.slave, address, 1)
            if not original_regs or address not in original_regs:
                results.append({
                    "address": address,
                    "error": f"Unable to read original value: {original_status}",
                    "before": before,
                })
                continue

            original_value = original_regs[address]
            write_status = write_fc10(ser, args.slave, address, args.value)
            time.sleep(args.delay_ms / 1000)
            after_write = read_registers(ser, args.slave, read_set)

            restore_status = write_fc10(ser, args.slave, address, original_value)
            time.sleep(args.delay_ms / 1000)
            after_restore = read_registers(ser, args.slave, read_set)

            results.append({
                "address": address,
                "originalValue": original_value,
                "testValue": args.value,
                "writeStatus": write_status,
                "restoreStatus": restore_status,
                "before": before,
                "afterWrite": after_write,
                "afterRestore": after_restore,
                "changedAfterWrite": changed_keys(before, after_write),
                "changedAfterRestore": changed_keys(before, after_restore),
            })

    print(json.dumps({"watch": watch, "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())