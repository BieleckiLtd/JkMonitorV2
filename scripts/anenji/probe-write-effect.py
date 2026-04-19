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


def write_fc06(ser: serial.Serial, slave: int, address: int, value: int) -> str:
    pdu = struct.pack(">BBHH", slave, 0x06, address, value)
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
    if buffer[1] == 0x86:
        return f"exc:{buffer[2]:02x}"
    if len(buffer) < 8:
        return f"short:{len(buffer)}"
    return "ok" if buffer[1] == 0x06 else f"fc:{buffer[1]:02x}"


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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe write side-effects for a candidate holding register")
    parser.add_argument("address", type=int)
    parser.add_argument("value", type=int)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--slave", type=int, default=1)
    parser.add_argument("--delay-ms", type=int, default=750)
    parser.add_argument("--function", choices=["fc06", "fc10"], default="fc10")
    parser.add_argument(
        "--watch",
        dest="watch",
        type=int,
        action="append",
        help="Register to read before/after; may be specified multiple times.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    watch = args.watch or [203, 227, 344, 346, 509, 510, 606, 607, 621, 622]
    write_func = write_fc06 if args.function == "fc06" else write_fc10

    with serial.Serial(args.port, args.baud, timeout=1.0, write_timeout=1.0) as ser:
        before = read_registers(ser, args.slave, watch)

        original_regs, original_status = read_regs(ser, args.slave, args.address, 1)
        if not original_regs or args.address not in original_regs:
            print(json.dumps({
                "address": args.address,
                "error": f"Unable to read original value: {original_status}",
                "before": before,
            }, indent=2))
            return 1

        original_value = original_regs[args.address]
        write_status = write_func(ser, args.slave, args.address, args.value)
        time.sleep(args.delay_ms / 1000)
        after_write = read_registers(ser, args.slave, watch)

        restore_status = write_func(ser, args.slave, args.address, original_value)
        time.sleep(args.delay_ms / 1000)
        after_restore = read_registers(ser, args.slave, watch)

    print(json.dumps({
        "address": args.address,
        "function": args.function,
        "originalValue": original_value,
        "testValue": args.value,
        "writeStatus": write_status,
        "restoreStatus": restore_status,
        "before": before,
        "afterWrite": after_write,
        "afterRestore": after_restore,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())