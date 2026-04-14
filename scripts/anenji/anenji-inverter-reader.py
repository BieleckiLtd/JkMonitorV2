#!/usr/bin/env python3
"""
Anenji ANJ-HHS-11000W-48V Inverter Reader
==========================================
Protocol: Modbus RTU over RS232 (via MAX3232 level converter)
Port:     /dev/ttyAMA0 (Pi 5 GPIO UART0, GPIO14=TX, GPIO15=RX)
Baud:     9600 8N1
Slave ID: 1
Function: 0x03 (Read Holding Registers)

Register map derived from:
  - Raw register analysis of the Anenji ANJ-HHS-11000W-48V (equipment type 29440/0x7300)
  - ISolar/EASUN SMG-II Modbus protocol (syssi/esphome-smg-ii)
  - GM6200 extended register definitions

NOTE: This firmware uses a non-standard register layout compared to SMG-II.
  - Settings are in the 600+ range (SMG-II uses 300+)
  - Battery live data is at 277-281 (SMG-II uses 215-229)
  - Grid/output live data is at 338-349 range (SMG-II uses 202-214)
  - Some SMG-II addresses (201, 203) are still valid

Usage:
  python3 anenji-inverter-reader.py                # Full report, all properties
  python3 anenji-inverter-reader.py --json         # Single read, JSON output
  python3 anenji-inverter-reader.py --loop 5       # Continuous reads every 5 seconds
  python3 anenji-inverter-reader.py --raw          # Dump all non-zero registers
  python3 anenji-inverter-reader.py --live         # Compact live-data-only output
  python3 anenji-inverter-reader.py --fast         # Only read live registers (faster)
"""

import serial
import struct
import time
import sys
import json
import argparse
from datetime import datetime

# ─── Modbus RTU helpers ───────────────────────────────────────────

def crc_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

def read_holding_registers(ser, slave, start, count):
    """Read holding registers (FC 0x03). Returns dict {addr: value} or None."""
    pdu = struct.pack('>BBHH', slave, 0x03, start, count)
    c = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    expected = 3 + count * 2 + 2
    buf = bytearray()
    t0 = time.time()
    while time.time() - t0 < 2.0 and len(buf) < expected:
        chunk = ser.read(expected - len(buf))
        if chunk:
            buf.extend(chunk)
        elif buf:
            break
    if len(buf) < 5:
        return None
    payload = buf[:-2]
    recv_crc = struct.unpack('<H', buf[-2:])[0]
    if recv_crc != crc_modbus(payload):
        return None
    if buf[1] != 0x03:
        return None
    bc = buf[2]
    data = buf[3:3+bc]
    regs = {}
    for i in range(0, len(data), 2):
        if i + 1 < len(data):
            regs[start + i // 2] = struct.unpack('>H', data[i:i+2])[0]
    return regs

def read_all_registers(ser, slave=1):
    """Read all registers 0-999 in blocks of 25."""
    all_regs = {}
    for base in range(0, 1000, 25):
        r = read_holding_registers(ser, slave, base, 25)
        if r:
            all_regs.update(r)
        time.sleep(0.02)
    return all_regs

def signed16(v):
    return v if v < 32768 else v - 65536

# ─── Register helpers ─────────────────────────────────────────────

def get_reg(regs, addr, scale=1, signed=False, default=0):
    """Get a register value, optionally scaled and sign-extended."""
    if addr is None or addr not in regs:
        return default
    raw = regs[addr]
    value = signed16(raw) if signed else raw
    if scale != 1:
        return round(value * scale, 2)
    return value

def get_enum(regs, addr, lookup, signed=False):
    """Get an enum string from a register value."""
    raw = get_reg(regs, addr, signed=signed)
    return lookup.get(raw, 'Unknown(%d)' % raw)

def decode_ascii(regs, start, end):
    """Decode ASCII from consecutive registers."""
    s = ''
    for a in range(start, end + 1):
        if a in regs:
            v = regs[a]
            hi = (v >> 8) & 0xFF
            lo = v & 0xFF
            if hi > 0: s += chr(hi) if 32 <= hi < 127 else ''
            if lo > 0: s += chr(lo) if 32 <= lo < 127 else ''
    return s

def decode_time(regs):
    """Decode inverter date/time from registers.

    Block-read layout (confirmed via diagnostic):
      696 = year, 697 = month, 698 = day
      699 = hour (0-23), 700 = minute (0-59), 701 = second (0-59)

    Write-path: reg 699 accepts HHMM (e.g. 1032 for 10:32); reg 700 accepts seconds.
    Block-read of 699 returns just the hour component (inverter splits internally).

    reg 198 is FROZEN at power-on value and does NOT tick over Modbus — ignore.
    """
    year   = get_reg(regs, 696, default=0)
    month  = get_reg(regs, 697, default=0)
    day    = get_reg(regs, 698, default=0)
    hour   = get_reg(regs, 699, default=0)  # block-read: hours only
    minute = get_reg(regs, 700, default=0)  # block-read: minutes
    seconds = get_reg(regs, 701, default=0) # block-read: seconds
    if year > 0:
        return '%04d-%02d-%02d %02d:%02d:%02d' % (year, month, day, hour, minute, seconds)
    return 'N/A'

# ─── Enum Lookups ─────────────────────────────────────────────────

OPERATING_MODES = {
    0: 'Power on mode',
    1: 'Standby mode',
    2: 'Mains mode',
    3: 'Off-grid mode',
    4: 'Bypass mode',
    5: 'Charging mode',
    6: 'Fault mode',
}

OUTPUT_PRIORITIES = {
    0: 'UTI',   # Utility-PV-Battery
    1: 'SOL',   # PV-Utility-Battery
    2: 'SBU',   # PV-Battery-Utility
    3: 'SUB',   # PV-Utility-Battery (sub)
}

CHARGE_PRIORITIES = {
    0: 'Utility priority',
    1: 'SOF',   # PV priority / Solar first
    2: 'SNU',   # PV and mains at the same level
    3: 'OSO',   # Only PV charging allowed
}

OUTPUT_MODES = {
    0: 'Single',
    1: 'Parallel',
    2: '3 Phase-P1',
    3: '3 Phase-P2',
    4: '3 Phase-P3',
}

INPUT_MODES = {
    0: 'APL',
    1: 'UPS',
    2: 'GNT',
}

BATTERY_TYPES = {
    0: 'AGM',
    1: 'Flooded',
    2: 'User Defined',
    3: 'Li1/Pylontech',
    4: 'LiFePO4',
    5: 'Li3',
    6: 'Li4',
    8: 'Lib',
}

# ─── Register Map Documentation ──────────────────────────────────
# Confidence: [C]=Confirmed  [P]=Probable  [L]=Likely  [U]=Unconfirmed  [X]=Unknown
#
# ── Device Identity ──
# [C] 171:     Equipment type
# [C] 186-192: Serial number (ASCII)
# [C] 754-761: Firmware version (ASCII)
# [C] 691:     Rated power (W)
# [C] 696-698: Date year/month/day (individual reads return 0; must use block read)
# [C] 699-701: Block-read layout: 699=hour, 700=minute, 701=second (live, ticking clock)
#              Write-path: reg 699 accepts HHMM (e.g. 1032 \u2192 10:32); reg 700 accepts seconds.
# [L] 198:     FROZEN at power-on HHMM value — NOT a running clock; ignore for time display.
#
# ── Live Measurements ──
# [C] 201: Operating mode (same as SMG-II)
# [C] 203: Mains/grid frequency (0.01Hz, same as SMG-II)
# [L] 204: Grid/mains power (1W, signed) — 0 in dump, matches expected 0W
# [L] 209: AC charging power (1W, signed) — 0 in dump, matches expected 0W
# [C] 227: Output frequency (0.01Hz) — confirmed, 0 when eco mode ON (no AC out), live value in off-grid
# [C] 231: INV module temperature (1C)
# [C] 277: Battery voltage (0.1V)
# [C] 278: Battery current (0.1A, signed; negative = discharge)
# [C] 279: Battery power (1W, signed; negative = discharge)
# [C] 280: SOC (1%)
# [C] 281: DC module temperature (1C)
# [C] 305: PV temperature (1C)
# [C] 338: Grid voltage (0.1V)
# [U] 342: Second output / AC bus voltage (0.1V) — mirrors reg 346 in off-grid mode; NOT PV voltage
# [U] 343: Unknown (possibly PV current, 0.1A — value ~3-4 with no panels, likely phantom)
# [X] 345: Not output frequency on this firmware (always 0); use reg 227 instead
# [C] 346: Output voltage (0.1V)
# [C] 347: Output current (0.1A)
# [P] 348: Output active power (1W, signed)
# [P] 349: Output apparent power (1VA)
# [L] 225: Load percentage (1%) — SMG-II addr, 0 matches expected
# [L] 223: Total PV power (1W) — SMG-II addr, 0 in dump
# [L] 224: Total PV charging power (1W) — SMG-II addr, 0 in dump
#
# ── Settings (600+ range, unique to this firmware) ──
# [C] 601: Main output priority (enum)
# [C] 605: Charger source priority (enum)
# [C] 606: Output voltage setting (0.1V)
# [C] 607: Output frequency setting (0.01Hz)
# [C] 630: Battery type (enum)
# [C] 631: Battery overvoltage protection point (0.1V)
# [P] 632: Current output priority (enum)
# [P] 636: Current charging priority (enum)
# [C] 637: Maximum charging voltage (0.1V)
# [C] 638: Floating charge voltage (0.1V)
# [L] 639: Constant pressure to float waiting time (min)
# [C] 640: Maximum charging current (0.1A)
# [C] 641: Maximum mains charging current (0.1A)
# [C] 642: Maximum discharge current protection (1A)
# [C] 643: Mains mode battery discharge recovery point (0.1V)
# [C] 644: Mains mode battery low voltage protection point (0.1V)
# [C] 646: Off-grid mode battery low voltage protection point (0.1V)
# [C] 647: Low DC protection SOC in AC mode (1%)
# [C] 648: Low DC recovery SOC in AC mode (1%)
# [C] 650: Battery Low Cut-off SOC (1%)
# [C] 654: Equalization timeout exit (min)
#
# ── Toggle Settings (register addresses unconfirmed) ──
# [U] 656: Battery equalisation mode enable (0=Prohibit, 1=Enable)
# [U] 677: Input mode (0=APL, 1=UPS, 2=GNT)
# [U] 679: LCD backlight (0=Timed off, 1=Always on)
# [U] 681: Energy-saving mode (0=Off, 1=On)
# [U] 689: Remote switch (0=Remote shutdown, 1=Remote boot)
# [L] 406: Boot method (0=Local+Remote, 1=Local only, 2=Remote only)
# [X] ???: Dry contact mode
# [X] ???: Automatic mains output enable
# [X] ???: Secondary output priority start time
# [X] ???: Output mode

# ─── Output formatting ───────────────────────────────────────────

def print_human(regs):
    """Print all properties in the exact order specified by the user."""

    serial = decode_ascii(regs, 186, 192)
    firmware = decode_ascii(regs, 754, 761)

    # Confidence markers for output
    U = '  \u26a0 register unconfirmed'
    Z = '  \u26a0 value 0 \u2014 may be unread or genuinely zero'
    X = '  \u26a0 register unknown'

    w = 46  # label width for alignment

    print('\u2554' + '\u2550' * 72 + '\u2557')
    print('\u2551  Anenji ANJ-HHS-11000W-48V \u2014 Full Status Report' + ' ' * 24 + '\u2551')
    print('\u2551  Serial: %-16s  Firmware: %-20s       \u2551' % (serial, firmware))
    print('\u2551  Rated Power: %-6d W' % get_reg(regs, 691) + ' ' * 49 + '\u2551')
    print('\u2560' + '\u2550' * 72 + '\u2563')
    print('\u2551  LIVE MEASUREMENTS' + ' ' * 53 + '\u2551')
    print('\u2560' + '\u2550' * 72 + '\u2563')

    # 1. Equipment type [C]
    print('  %-*s %d' % (w, 'Equipment type:', get_reg(regs, 171)))

    # 2. Device serial number [C]
    print('  %-*s %s' % (w, 'Device serial number:', serial))

    # 3. Operating mode [C]
    print('  %-*s %s' % (w, 'Operating mode:', get_enum(regs, 201, OPERATING_MODES)))

    # 4. AC charging power [L]
    v = get_reg(regs, 209, signed=True)
    note = Z if v == 0 else ''
    print('  %-*s %d W%s' % (w, 'AC charging power:', v, note))

    # 5. INV module temperature [C]
    print('  %-*s %d\u00b0C' % (w, 'INV module temperature:', get_reg(regs, 231, signed=True)))

    # 6. Output frequency [C] reg 227 (was wrongly 345 — always 0 on this firmware)
    v = get_reg(regs, 227, scale=0.01, signed=True)
    note = Z if v == 0 else ''
    print('  %-*s %.2f Hz%s' % (w, 'Output frequency:', v, note))

    # 7. Battery voltage [C]
    print('  %-*s %.1f V' % (w, 'Battery voltage:', get_reg(regs, 277, scale=0.1, signed=True)))

    # 8. Battery current [C]
    print('  %-*s %.1f A' % (w, 'Battery current:', get_reg(regs, 278, scale=0.1, signed=True)))

    # 9. Battery power [C]
    print('  %-*s %d W' % (w, 'Battery power:', get_reg(regs, 279, signed=True)))

    # 10. SOC [C]
    print('  %-*s %d%%' % (w, 'SOC:', get_reg(regs, 280)))

    # 11. DC module temperature [C]
    print('  %-*s %d\u00b0C' % (w, 'DC module temperature:', get_reg(regs, 281, signed=True)))

    # 12. Total PV power [L]
    v = get_reg(regs, 223, signed=True)
    note = Z if v == 0 else ''
    print('  %-*s %d W%s' % (w, 'Total PV power:', v, note))

    # 13. Total PV charging power [L]
    v = get_reg(regs, 224, signed=True)
    note = Z if v == 0 else ''
    print('  %-*s %d W%s' % (w, 'Total PV charging power:', v, note))

    # 14. PV temperature [C]
    print('  %-*s %d\u00b0C' % (w, 'PV temperature:', get_reg(regs, 305, signed=True)))

    # 15. Grid voltage [C]
    print('  %-*s %.1f V' % (w, 'Grid voltage:', get_reg(regs, 338, scale=0.1, signed=True)))

    # 16. Grid power [L]
    gp = get_reg(regs, 340, signed=True)
    if gp == 0:
        gp = get_reg(regs, 204, signed=True)
    note = Z if gp == 0 else ''
    print('  %-*s %d W%s' % (w, 'Grid power:', gp, note))

    # 17. Output voltage [P]
    print('  %-*s %.1f V' % (w, 'Output voltage:', get_reg(regs, 346, scale=0.1, signed=True)))

    # 18. Output current [C]
    print('  %-*s %.1f A' % (w, 'Output current:', get_reg(regs, 347, scale=0.1, signed=True)))

    # 19. Output active power [P]
    print('  %-*s %d W' % (w, 'Output active power:', get_reg(regs, 348, signed=True)))

    # 20. Output apparent power [P]
    print('  %-*s %d VA' % (w, 'Output apparent power:', get_reg(regs, 349, signed=True)))

    # 21. Load percentage [L]
    v = get_reg(regs, 225, signed=True)
    note = Z if v == 0 else ''
    print('  %-*s %d%%%s' % (w, 'Load percentage:', v, note))

    print('\u2560' + '\u2550' * 72 + '\u2563')
    print('\u2551  SETTINGS' + ' ' * 63 + '\u2551')
    print('\u2560' + '\u2550' * 72 + '\u2563')

    # 22. Output mode [U]
    v = get_reg(regs, 300)
    print('  %-*s %s%s' % (w, 'Output mode:', OUTPUT_MODES.get(v, 'Unknown(%d)' % v), U))

    # 23. Main output priority [C]
    print('  %-*s %s' % (w, 'Main output priority:', get_enum(regs, 601, OUTPUT_PRIORITIES)))

    # 24. Secondary output priority start time [X]
    print('  %-*s N/A%s' % (w, 'Secondary output priority start time:', X))

    # 25. Current output priority [P]
    print('  %-*s %s%s' % (w, 'Current output priority:', get_enum(regs, 632, OUTPUT_PRIORITIES), U))

    # 26. Output voltage setting [C]
    print('  %-*s %.0f V' % (w, 'Output voltage setting:', get_reg(regs, 606, scale=0.1)))

    # 27. Battery overvoltage protection point [C]
    print('  %-*s %.1f V' % (w, 'Battery overvoltage protection point:', get_reg(regs, 631, scale=0.1)))

    # 28. Charger source priority [C]
    print('  %-*s %s' % (w, 'Charger source priority:', get_enum(regs, 605, CHARGE_PRIORITIES)))

    # 29. Current charging priority [P]
    print('  %-*s %s' % (w, 'Current charging priority:', get_enum(regs, 636, CHARGE_PRIORITIES)))

    # 30. Maximum charging voltage [C]
    print('  %-*s %.1f V' % (w, 'Maximum charging voltage:', get_reg(regs, 637, scale=0.1)))

    # 31. Floating charge voltage [C]
    print('  %-*s %.1f V' % (w, 'Floating charge voltage:', get_reg(regs, 638, scale=0.1)))

    # 32. Constant pressure to float waiting time [L]
    v = get_reg(regs, 639)
    note = Z if v == 0 else U
    print('  %-*s %d min%s' % (w, 'Constant pressure to float waiting time:', v, note))

    # 33. Maximum charging current [C]
    print('  %-*s %.1f A' % (w, 'Maximum charging current:', get_reg(regs, 640, scale=0.1)))

    # 34. Maximum mains charging current [C]
    print('  %-*s %.1f A' % (w, 'Maximum mains charging current:', get_reg(regs, 641, scale=0.1)))

    # 35. Maximum discharge current protection [C]
    print('  %-*s %d A' % (w, 'Maximum discharge current protection:', get_reg(regs, 642)))

    # 36. Mains mode battery discharge recovery point [C]
    print('  %-*s %.1f V' % (w, 'Mains mode battery discharge recovery:', get_reg(regs, 643, scale=0.1)))

    # 37. Mains mode battery low voltage protection point [C]
    print('  %-*s %.1f V' % (w, 'Mains mode battery low voltage prot.:', get_reg(regs, 644, scale=0.1)))

    # 38. Off-grid mode battery low voltage protection point [C]
    print('  %-*s %.1f V' % (w, 'Off-grid mode battery low voltage prot.:', get_reg(regs, 646, scale=0.1)))

    # 39. Low DC protection SOC in AC mode [C]
    print('  %-*s %d%%' % (w, 'Low DC protection SOC in AC mode:', get_reg(regs, 647)))

    # 40. Low DC recovery SOC in AC mode [C]
    print('  %-*s %d%%' % (w, 'Low DC recovery SOC in AC mode:', get_reg(regs, 648)))

    # 41. Battery Low Cut-off SOC [C]
    print('  %-*s %d%%' % (w, 'Battery Low Cut-off SOC:', get_reg(regs, 650)))

    # 42. Battery equalisation mode enable [U]
    v = get_reg(regs, 656)
    label = 'Prohibit' if v == 0 else ('Enable' if v == 1 else str(v))
    note = U + ' (0 could be default or genuinely disabled)' if v == 0 else U
    print('  %-*s %s%s' % (w, 'Battery equalisation mode enable:', label, note))

    # 43. Equalisation timeout exit [C]
    print('  %-*s %d min' % (w, 'Equalisation timeout exit:', get_reg(regs, 654)))

    # 44. Input mode [U]
    print('  %-*s %s%s' % (w, 'Input mode:', get_enum(regs, 677, INPUT_MODES), U))

    # 45. LCD backlight [U]
    v = get_reg(regs, 679)
    label = 'Always on' if v == 1 else ('Timed off' if v == 0 else str(v))
    print('  %-*s %s%s' % (w, 'LCD backlight:', label, U))

    # 46. Energy-saving mode switch [U]
    v = get_reg(regs, 681)
    label = 'Energy saving mode is on' if v == 1 else ('Energy saving mode is off' if v == 0 else str(v))
    print('  %-*s %s%s' % (w, 'Energy-saving mode switch:', label, U))

    # 47. Overload automatic restart [U]
    v = get_reg(regs, 308)
    label = 'Does not restart' if v == 0 else ('Automatic restart' if v == 1 else str(v))
    note = U + ' (0 may be default)' if v == 0 else U
    print('  %-*s %s%s' % (w, 'Overload automatic restart:', label, note))

    # 48. Overload transfer to bypass enable [U]
    v = get_reg(regs, 310)
    label = 'Prohibit' if v == 0 else ('Enable' if v == 1 else str(v))
    note = U + ' (0 may be default)' if v == 0 else U
    print('  %-*s %s%s' % (w, 'Overload transfer to bypass enable:', label, note))

    # 49. Dry contact mode [X]
    print('  %-*s N/A%s' % (w, 'Dry contact mode:', X))

    # 50. Automatic mains output enable [X]
    print('  %-*s N/A%s' % (w, 'Automatic mains output enable:', X))

    # 51. Boot method [L]
    v = get_reg(regs, 406)
    labels = {0: 'Can be powered on locally or remotely', 1: 'Only local turn-on', 2: 'Only remote turn-on'}
    label = labels.get(v, str(v))
    note = U + ' (0 may be default)' if v == 0 else ''
    print('  %-*s %s%s' % (w, 'Boot method:', label, note))

    # 52. Remote switch [U]
    v = get_reg(regs, 689)
    label = 'Remote boot' if v == 1 else ('Remote shutdown' if v == 0 else str(v))
    print('  %-*s %s%s' % (w, 'Remote switch:', label, U))

    # 53. Inverter time [P]
    print('  %-*s %s' % (w, 'Inverter time:', decode_time(regs)))

    print('\u255a' + '\u2550' * 72 + '\u255d')

    # Additional info
    print()
    print('  Battery type: %s | Eq voltage: %.1f V | Eq time: %d min | Eq interval: %d day' % (
        get_enum(regs, 630, BATTERY_TYPES),
        get_reg(regs, 652, scale=0.1),
        get_reg(regs, 653),
        get_reg(regs, 655),
    ))
    print('  Mains frequency: %.2f Hz | Output freq setting: %.2f Hz' % (
        get_reg(regs, 203, scale=0.01, signed=True),
        get_reg(regs, 607, scale=0.01),
    ))
    if firmware:
        print('  Firmware: %s' % firmware)


def print_raw(regs):
    """Dump all non-zero registers."""
    print('addr  | raw   | signed | hex    ')
    print('------+-------+--------+--------')
    for addr in sorted(regs.keys()):
        v = regs[addr]
        if v != 0:
            sv = signed16(v)
            print('%4d  | %5d | %6d | 0x%04X' % (addr, v, sv, v))


def print_live(data):
    """Print compact live data line."""
    ts = datetime.now().strftime('%H:%M:%S')
    print('[%s] Batt: %.1fV %d%% %.1fA %dW | Grid: %.1fV | Out: %.1fV %.1fA %dW | PV: %dW | Load: %d%% | Temp: INV %d\u00b0C DC %d\u00b0C' % (
        ts,
        get_reg(data, 277, scale=0.1, signed=True),
        get_reg(data, 280),
        get_reg(data, 278, scale=0.1, signed=True),
        get_reg(data, 279, signed=True),
        get_reg(data, 338, scale=0.1, signed=True),
        get_reg(data, 346, scale=0.1, signed=True),
        get_reg(data, 347, scale=0.1, signed=True),
        get_reg(data, 348, signed=True),
        get_reg(data, 223, signed=True),
        get_reg(data, 225, signed=True),
        get_reg(data, 231, signed=True),
        get_reg(data, 281, signed=True),
    ))


def build_json(regs):
    """Build JSON-serializable dict of all properties."""
    d = {}
    d['timestamp'] = datetime.now().isoformat()
    d['equipment_type'] = get_reg(regs, 171)
    d['serial_number'] = decode_ascii(regs, 186, 192)
    d['firmware'] = decode_ascii(regs, 754, 761)
    d['operating_mode'] = get_enum(regs, 201, OPERATING_MODES)
    d['ac_charging_power_w'] = get_reg(regs, 209, signed=True)
    d['inv_module_temperature_c'] = get_reg(regs, 231, signed=True)
    d['output_frequency_hz'] = get_reg(regs, 227, scale=0.01, signed=True)  # reg 227 confirmed; 345 always 0 on this firmware
    d['battery_voltage_v'] = get_reg(regs, 277, scale=0.1, signed=True)
    d['battery_current_a'] = get_reg(regs, 278, scale=0.1, signed=True)
    d['battery_power_w'] = get_reg(regs, 279, signed=True)
    d['soc_pct'] = get_reg(regs, 280)
    d['dc_module_temperature_c'] = get_reg(regs, 281, signed=True)
    d['total_pv_power_w'] = get_reg(regs, 223, signed=True)
    d['total_pv_charging_power_w'] = get_reg(regs, 224, signed=True)
    d['pv_temperature_c'] = get_reg(regs, 305, signed=True)
    d['grid_voltage_v'] = get_reg(regs, 338, scale=0.1, signed=True)
    d['grid_power_w'] = get_reg(regs, 340, signed=True) or get_reg(regs, 204, signed=True)
    d['output_voltage_v'] = get_reg(regs, 346, scale=0.1, signed=True)
    d['output_current_a'] = get_reg(regs, 347, scale=0.1, signed=True)
    d['output_active_power_w'] = get_reg(regs, 348, signed=True)
    d['output_apparent_power_va'] = get_reg(regs, 349, signed=True)
    d['load_percentage_pct'] = get_reg(regs, 225, signed=True)
    d['main_output_priority'] = get_enum(regs, 601, OUTPUT_PRIORITIES)
    d['charger_source_priority'] = get_enum(regs, 605, CHARGE_PRIORITIES)
    d['output_voltage_setting_v'] = get_reg(regs, 606, scale=0.1)
    d['battery_overvoltage_protection_v'] = get_reg(regs, 631, scale=0.1)
    d['max_charging_voltage_v'] = get_reg(regs, 637, scale=0.1)
    d['floating_charge_voltage_v'] = get_reg(regs, 638, scale=0.1)
    d['max_charging_current_a'] = get_reg(regs, 640, scale=0.1)
    d['max_mains_charging_current_a'] = get_reg(regs, 641, scale=0.1)
    d['max_discharge_current_a'] = get_reg(regs, 642)
    d['mains_battery_discharge_recovery_v'] = get_reg(regs, 643, scale=0.1)
    d['mains_battery_low_voltage_v'] = get_reg(regs, 644, scale=0.1)
    d['offgrid_battery_low_voltage_v'] = get_reg(regs, 646, scale=0.1)
    d['low_dc_protection_soc_pct'] = get_reg(regs, 647)
    d['low_dc_recovery_soc_pct'] = get_reg(regs, 648)
    d['battery_low_cutoff_soc_pct'] = get_reg(regs, 650)
    d['equalization_timeout_min'] = get_reg(regs, 654)
    d['rated_power_w'] = get_reg(regs, 691)
    d['mains_frequency_hz'] = get_reg(regs, 203, scale=0.01, signed=True)
    d['inverter_time'] = decode_time(regs)
    return d


# ─── Optimized register read ranges ──────────────────────────────

LIVE_RANGES = [
    (196, 10),   # 196-205: time, status, mode, freq, grid power
    (209, 1),    # 209: AC charging power
    (212, 1),    # 212: output frequency (SMG-II addr)
    (223, 10),   # 223-232: PV power, load%, temps, SOC
    (277, 5),    # 277-281: battery V, I, P, SOC, DC temp
    (305, 1),    # 305: PV temperature
    (338, 14),   # 338-351: grid/output measurements
]

FULL_RANGES = LIVE_RANGES + [
    (171, 4),    # 171-174: equipment type
    (175, 25),   # 175-199: includes serial number (186-192), aligned to full-scan block
    (300, 15),   # 300-314: SMG-II-style settings (uncertain on this firmware)
    (406, 1),    # 406: boot method
    (601, 10),   # 601-610: priorities
    (630, 30),   # 630-659: battery/voltage/current settings
    (670, 33),   # 670-702: toggle settings, device info, live time (699=hr, 700=min, 701=sec)
    (750, 15),   # 750-764: firmware, power
]


def read_ranges(ser, ranges, slave=1):
    """Read specific register ranges."""
    all_regs = {}
    for start, count in ranges:
        r = read_holding_registers(ser, slave, start, count)
        if r:
            all_regs.update(r)
        time.sleep(0.01)
    return all_regs

def read_live_registers(ser, slave=1):
    """Read only the live measurement registers for fast updates."""
    return read_ranges(ser, LIVE_RANGES, slave)

def read_full_registers(ser, slave=1):
    """Read live + settings registers (faster than full 0-999 scan)."""
    return read_ranges(ser, FULL_RANGES, slave)


# ─── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Anenji ANJ-HHS-11000W-48V Inverter Reader')
    parser.add_argument('--port', default='/dev/ttyAMA0', help='Serial port (default: /dev/ttyAMA0)')
    parser.add_argument('--baud', type=int, default=9600, help='Baud rate (default: 9600)')
    parser.add_argument('--slave', type=int, default=1, help='Modbus slave ID (default: 1)')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--raw', action='store_true', help='Dump all non-zero registers')
    parser.add_argument('--live', action='store_true', help='Compact live-data-only output')
    parser.add_argument('--loop', type=float, metavar='SECS', help='Continuous read every N seconds')
    parser.add_argument('--fast', action='store_true', help='Only read live registers (faster)')
    parser.add_argument('--scan', action='store_true', help='Full 0-999 register scan (use with --raw)')
    args = parser.parse_args()

    ser = serial.Serial(args.port, args.baud, timeout=0.5)
    time.sleep(0.3)

    try:
        while True:
            if args.raw:
                regs = read_all_registers(ser, args.slave)
            elif args.fast or args.live:
                regs = read_live_registers(ser, args.slave)
            else:
                regs = read_full_registers(ser, args.slave)

            if not regs:
                print('ERROR: No response from inverter', file=sys.stderr)
                if args.loop:
                    time.sleep(args.loop)
                    continue
                sys.exit(1)

            if args.raw:
                print_raw(regs)
            elif args.json:
                data = build_json(regs)
                print(json.dumps(data, indent=2))
            elif args.live:
                print_live(regs)
            else:
                print_human(regs)

            if args.loop:
                sys.stdout.flush()
                time.sleep(args.loop)
            else:
                break
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()

if __name__ == '__main__':
    main()
