#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import time

import serial


DEFAULT_CANDIDATES = [
    300, 301, 302, 303, 305, 306, 307, 312, 316, 318, 319, 320, 321, 402, 420,
    600, 601, 603, 605, 606, 607, 630, 631, 632, 633, 634, 637, 638, 639, 640,
    641, 642, 643, 644, 646, 647, 648, 649, 650, 652, 653, 654, 655, 656, 677,
    678, 679, 681, 682, 683, 684, 689, 690, 821, 822, 823, 824, 825, 826, 827,
    828, 829, 830, 831, 832, 833, 834, 835, 836, 837, 838, 839, 840, 841, 842,
    843, 844, 845, 846, 847, 848, 849, 850, 851, 852, 853, 854, 855, 856, 857,
    858, 859, 860, 861, 862, 863, 864, 865, 866, 867, 868, 869, 870,
]

TARGET_VALUES = {22, 23, 24, 50, 60, 220, 230, 240, 500, 600, 2200, 2300, 2400, 5000, 6000}


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
    parser = argparse.ArgumentParser(description="Probe candidate Anenji output-setting registers")
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--slave", type=int, default=1)
    parser.add_argument("--scan-max", type=int, default=1000)
    parser.add_argument("--candidate", dest="candidates", type=int, action="append")
    parser.add_argument("--skip-hit-scan", action="store_true")
    parser.add_argument("--skip-fc06", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    candidates = sorted(set(args.candidates or DEFAULT_CANDIDATES))
    hits: list[tuple[int, int]] = []
    probe: dict[int, dict[str, int | str | None]] = {}

    with serial.Serial(args.port, args.baud, timeout=1.0, write_timeout=1.0) as ser:
        if not args.skip_hit_scan:
            for base in range(1, args.scan_max + 1, 25):
                count = min(25, args.scan_max - base + 1)
                regs, _ = read_regs(ser, args.slave, base, count)
                if regs:
                    for address, value in regs.items():
                        if value in TARGET_VALUES:
                            hits.append((address, value))
                time.sleep(0.03)

        for address in candidates:
            regs, status = read_regs(ser, args.slave, address, 1)
            if not regs or address not in regs:
                probe[address] = {"read": status}
                continue

            value = regs[address]
            fc06 = "skipped" if args.skip_fc06 else write_fc06(ser, args.slave, address, value)
            if not args.skip_fc06:
                time.sleep(0.05)
            fc10 = write_fc10(ser, args.slave, address, value)
            time.sleep(0.05)
            regs_after, _ = read_regs(ser, args.slave, address, 1)

            probe[address] = {
                "value": value,
                "fc06": fc06,
                "fc10": fc10,
                "readback": None if not regs_after else regs_after.get(address),
            }

    print(json.dumps({"hits": hits, "probe": probe}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())