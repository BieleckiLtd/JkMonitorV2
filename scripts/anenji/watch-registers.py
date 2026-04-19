#!/usr/bin/env python3
"""Poll a list of Modbus registers and print value changes with timestamps.

Designed for interactive inverter testing while toggling settings from the LCD.
"""

from __future__ import annotations

import argparse
import struct
import sys
import time

import serial


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if (crc & 1) else (crc >> 1)
    return crc


def read_regs(ser: serial.Serial, slave: int, addr: int, count: int = 1) -> list[int] | None:
    frame = struct.pack(">BBHH", slave, 3, addr, count)
    frame += struct.pack("<H", crc16(frame))
    ser.reset_input_buffer()
    ser.write(frame)
    time.sleep(0.15)
    response = ser.read(256)
    if len(response) < 5 + count * 2:
        return None

    return [
        struct.unpack(">H", response[3 + i * 2:5 + i * 2])[0]
        for i in range(count)
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="/dev/ttyAMA0")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--slave", type=int, default=1)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--duration", type=float, default=75.0)
    parser.add_argument(
        "--register",
        dest="registers",
        action="append",
        type=int,
        help="Register to poll; may be provided more than once.",
    )
    parser.add_argument(
        "--range",
        dest="ranges",
        action="append",
        nargs=2,
        metavar=("START", "END"),
        type=int,
        help="Inclusive register range to poll; may be provided more than once.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    registers: list[int] = []
    for reg in args.registers or []:
        registers.append(reg)
    for start, end in args.ranges or []:
        if end < start:
            start, end = end, start
        registers.extend(range(start, end + 1))

    if not registers:
        registers = [680, 685, 686, 689, 690, 865]

    registers = sorted(set(registers))
    print(f"Watching registers: {', '.join(str(reg) for reg in registers)}")
    print(f"Port={args.port} baud={args.baud} slave={args.slave} interval={args.interval}s duration={args.duration}s")

    ser = serial.Serial(args.port, args.baud, timeout=1.5)
    last_values: dict[int, int | None] = {}

    start_time = time.time()
    next_tick = start_time

    try:
        while True:
            now = time.time()
            elapsed = now - start_time
            if elapsed > args.duration:
                break

            row: list[str] = []
            for reg in registers:
                values = read_regs(ser, args.slave, reg, 1)
                value = None if values is None else values[0]
                marker = ""
                if reg in last_values and last_values[reg] != value:
                    marker = " *CHANGED*"
                last_values[reg] = value
                row.append(f"{reg}={value}{marker}")

            print(f"[{elapsed:6.1f}s] " + " | ".join(row))
            sys.stdout.flush()

            next_tick += args.interval
            sleep_for = next_tick - time.time()
            if sleep_for > 0:
                time.sleep(sleep_for)
    finally:
        ser.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
