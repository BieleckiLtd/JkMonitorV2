#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import struct
import time
from pathlib import Path

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe whether output setting writes succeed only in standby mode")
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--slave", type=int, default=1)
    parser.add_argument("--switch-reg", type=int, default=690)
    parser.add_argument("--off-value", type=int, default=0)
    parser.add_argument("--on-value", type=int, default=1)
    parser.add_argument("--voltage", type=int, default=2400)
    parser.add_argument("--frequency", type=int, default=6000)
    parser.add_argument("--step-delay-ms", type=int, default=1500)
    parser.add_argument("--boot-delay-ms", type=int, default=3000)
    parser.add_argument("--output", default="/tmp/probe-output-setting-standby-last.json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    watch = [203, 227, 344, 346, 606, 607, args.switch_reg]

    with serial.Serial(args.port, args.baud, timeout=1.0, write_timeout=1.0) as ser:
        before = read_registers(ser, args.slave, watch)

        original_voltage_regs, original_voltage_status = read_regs(ser, args.slave, 606, 1)
        original_frequency_regs, original_frequency_status = read_regs(ser, args.slave, 607, 1)
        if not original_voltage_regs or 606 not in original_voltage_regs:
            result = {
                "error": f"Unable to read original voltage value: {original_voltage_status}",
                "before": before,
            }
            Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))
            return 1
        if not original_frequency_regs or 607 not in original_frequency_regs:
            result = {
                "error": f"Unable to read original frequency value: {original_frequency_status}",
                "before": before,
            }
            Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))
            return 1

        original_voltage = original_voltage_regs[606]
        original_frequency = original_frequency_regs[607]

        shutdown_status = write_fc10(ser, args.slave, args.switch_reg, args.off_value)
        time.sleep(args.step_delay_ms / 1000)
        after_shutdown = read_registers(ser, args.slave, watch)

        voltage_write_status = write_fc10(ser, args.slave, 606, args.voltage)
        time.sleep(args.step_delay_ms / 1000)
        frequency_write_status = write_fc10(ser, args.slave, 607, args.frequency)
        time.sleep(args.step_delay_ms / 1000)
        after_test_writes = read_registers(ser, args.slave, watch)

        restore_voltage_status = write_fc10(ser, args.slave, 606, original_voltage)
        time.sleep(args.step_delay_ms / 1000)
        restore_frequency_status = write_fc10(ser, args.slave, 607, original_frequency)
        time.sleep(args.step_delay_ms / 1000)
        after_restore_settings = read_registers(ser, args.slave, watch)

        boot_status = write_fc10(ser, args.slave, args.switch_reg, args.on_value)
        time.sleep(args.boot_delay_ms / 1000)
        after_boot = read_registers(ser, args.slave, watch)

    result = {
        "switchRegister": args.switch_reg,
        "offValue": args.off_value,
        "onValue": args.on_value,
        "originalVoltage": original_voltage,
        "originalFrequency": original_frequency,
        "testVoltage": args.voltage,
        "testFrequency": args.frequency,
        "shutdownStatus": shutdown_status,
        "voltageWriteStatus": voltage_write_status,
        "frequencyWriteStatus": frequency_write_status,
        "restoreVoltageStatus": restore_voltage_status,
        "restoreFrequencyStatus": restore_frequency_status,
        "bootStatus": boot_status,
        "before": before,
        "afterShutdown": after_shutdown,
        "afterTestWrites": after_test_writes,
        "afterRestoreSettings": after_restore_settings,
        "afterBoot": after_boot,
    }
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())