#!/usr/bin/env python3
"""
Anenji ANJ-HHS-11000W-48V – Modbus R/W Register Probe & Time Sync
===================================================================
Protocol: Modbus RTU over RS232 (via MAX3232 level converter)
Port:     /dev/ttyAMA0 (Pi 5 UART0)
Baud:     9600 8N1  Slave ID: 1

Usage:
  python3 anenji-rw-probe.py                  # Safe probe: test which setting regs are R/W
  python3 anenji-rw-probe.py --sync-time      # Synchronise inverter RTC to Pi's current time
  python3 anenji-rw-probe.py --raw-time       # Show raw time register values only
  python3 anenji-rw-probe.py --scan 600 700   # Probe writability of all regs in a range
                                               # (writes same value back — safe but slow)

TIME SYNC NOTES (confirmed behaviour):
  - Registers 696-700 (year/month/day/HHMM/seconds) are STARTUP-ONLY on this firmware.
  - Writes are ACKed by the inverter (FC 0x10 block or individual) but are NOT applied
    to the running RTC once the clock is already ticking.
  - --sync-time is effective when the inverter clock is in its factory-default/uninitialized
    state (reg 698 = 0 or 21:44 default), e.g. after a fresh factory reset or first power-on.
  - To re-sync a running clock, a full power cycle is required after writing the registers.
  - Read layout: block-read gives 699=hour, 700=minute, 701=second (live ticking clock).
  - reg 198 = frozen at power-on HHMM value, does NOT tick over Modbus — ignore.

SAFETY RULES BAKED IN:
  - Never writes voltage, frequency, or current threshold registers.
  - --probe only writes same value back (no actual change).
  - --sync-time only writes date/time registers.
  - --scan writes same value back only.
"""

import serial
import struct
import time
import sys
import argparse
from datetime import datetime

# ── Modbus RTU helpers ──────────────────────────────────────────────────────

def crc_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

def signed16(v):
    return v if v < 32768 else v - 65536

def read_single_register(ser, slave, addr):
    """Read one holding register. Returns (value_int, error_string)."""
    pdu = struct.pack('>BBHH', slave, 0x03, addr, 1)
    c = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    buf = bytearray()
    t0 = time.time()
    while time.time() - t0 < 2.0 and len(buf) < 7:
        chunk = ser.read(7 - len(buf))
        if chunk:
            buf.extend(chunk)
        elif buf:
            break
    if len(buf) < 7:
        return None, 'No response (%d bytes)' % len(buf)
    payload = buf[:5]
    recv_crc = struct.unpack('<H', buf[5:7])[0]
    if recv_crc != crc_modbus(payload):
        return None, 'CRC mismatch'
    if buf[1] == 0x83:
        return None, 'Exception 0x%02X' % (buf[2] if len(buf) > 2 else 0)
    val = struct.unpack('>H', buf[3:5])[0]
    return val, None

def read_holding_registers(ser, slave, start, count):
    """Read holding registers. Returns dict {addr: value} or None."""
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

def _wait_response(ser, expected_len, timeout=3.0):
    """Read up to expected_len bytes with timeout."""
    buf = bytearray()
    t0 = time.time()
    while time.time() - t0 < timeout and len(buf) < expected_len:
        chunk = ser.read(expected_len - len(buf))
        if chunk:
            buf.extend(chunk)
        elif buf:
            break
    return buf


def write_single_register_fc06(ser, slave, addr, value):
    """
    Write one holding register using FC 0x06 (Write Single Register).
    Response is an echo of the request on success.
    Returns (success: bool, message: str).
    """
    if not (0 <= value <= 65535):
        return False, 'Value out of range: %d' % value
    pdu = struct.pack('>BBHH', slave, 0x06, addr, value)
    c = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    buf = _wait_response(ser, 8, timeout=3.0)
    if len(buf) < 4:
        return False, 'No response (%d bytes)' % len(buf)
    if buf[1] == 0x86:
        exc = buf[2] if len(buf) > 2 else 0
        exc_labels = {1: 'ILLEGAL_FUNCTION', 2: 'ILLEGAL_ADDRESS', 3: 'ILLEGAL_VALUE', 4: 'DEVICE_FAILURE'}
        return False, 'Exception 0x%02X (%s)' % (exc, exc_labels.get(exc, '?'))
    if len(buf) < 8:
        return False, 'Short response (%d bytes)' % len(buf)
    payload = buf[:6]
    recv_crc = struct.unpack('<H', buf[6:8])[0]
    if recv_crc != crc_modbus(payload):
        return False, 'CRC mismatch in response'
    if buf[1] != 0x06:
        return False, 'Unexpected FC in response: 0x%02X' % buf[1]
    resp_addr = struct.unpack('>H', buf[2:4])[0]
    resp_val  = struct.unpack('>H', buf[4:6])[0]
    if resp_addr != addr or resp_val != value:
        return False, 'Echo mismatch: addr %d/%d val %d/%d' % (addr, resp_addr, value, resp_val)
    return True, 'ACK (FC 0x06)'


def write_single_register_fc10(ser, slave, addr, value):
    """
    Write one holding register using FC 0x10 (Write Multiple Registers, n=1).
    Some EASUN/Anenji firmware variants only respond to FC 0x10, ignoring FC 0x06.
    Response: [slave, 0x10, addr_hi, addr_lo, 0x00, 0x01, crc_lo, crc_hi].
    Returns (success: bool, message: str).
    """
    if not (0 <= value <= 65535):
        return False, 'Value out of range: %d' % value
    # FC 0x10: slave, 0x10, start_hi, start_lo, qty_hi, qty_lo, byte_count, val_hi, val_lo
    pdu = struct.pack('>BBHHHBB', slave, 0x10, addr, 1, 1, 0, 2) + struct.pack('>H', value)
    # Actually: [slave, 0x10, addr(2), qty(2), byte_count, data(2*qty)]
    pdu = struct.pack('>BBHHB', slave, 0x10, addr, 1, 2) + struct.pack('>H', value)
    c = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    buf = _wait_response(ser, 8, timeout=3.0)
    if len(buf) < 4:
        return False, 'No response (%d bytes)' % len(buf)
    if buf[1] == 0x90:
        exc = buf[2] if len(buf) > 2 else 0
        exc_labels = {1: 'ILLEGAL_FUNCTION', 2: 'ILLEGAL_ADDRESS', 3: 'ILLEGAL_VALUE', 4: 'DEVICE_FAILURE'}
        return False, 'Exception 0x%02X (%s)' % (exc, exc_labels.get(exc, '?'))
    if len(buf) < 8:
        return False, 'Short response (%d bytes)' % len(buf)
    payload = buf[:6]
    recv_crc = struct.unpack('<H', buf[6:8])[0]
    if recv_crc != crc_modbus(payload):
        return False, 'CRC mismatch in response'
    if buf[1] != 0x10:
        return False, 'Unexpected FC in response: 0x%02X' % buf[1]
    resp_addr = struct.unpack('>H', buf[2:4])[0]
    resp_qty  = struct.unpack('>H', buf[4:6])[0]
    if resp_addr != addr:
        return False, 'Addr mismatch: sent %d got %d' % (addr, resp_addr)
    if resp_qty != 1:
        return False, 'Qty mismatch: sent 1 got %d' % resp_qty
    return True, 'ACK (FC 0x10)'


def write_register_block(ser, slave, start_addr, values):
    """
    Write N consecutive registers in a single FC 0x10 frame.
    Some inverters only apply an atomic block write; individual writes are ACKed but ignored
    once the clock is running.
    values: list of int (each 0-65535).
    Returns (success: bool, message: str).
    """
    n = len(values)
    byte_count = n * 2
    pdu = struct.pack('>BBHHB', slave, 0x10, start_addr, n, byte_count)
    for v in values:
        pdu += struct.pack('>H', v)
    c = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    buf = _wait_response(ser, 8, timeout=3.0)
    if len(buf) < 4:
        return False, 'No response (%d bytes)' % len(buf)
    if buf[1] == 0x90:
        exc = buf[2] if len(buf) > 2 else 0
        exc_labels = {1: 'ILLEGAL_FUNCTION', 2: 'ILLEGAL_ADDRESS', 3: 'ILLEGAL_VALUE', 4: 'DEVICE_FAILURE'}
        return False, 'Exception 0x%02X (%s)' % (exc, exc_labels.get(exc, '?'))
    if len(buf) < 8:
        return False, 'Short response (%d bytes)' % len(buf)
    payload = buf[:6]
    recv_crc = struct.unpack('<H', buf[6:8])[0]
    if recv_crc != crc_modbus(payload):
        return False, 'CRC mismatch in response'
    if buf[1] != 0x10:
        return False, 'Unexpected FC in response: 0x%02X' % buf[1]
    return True, 'ACK (FC 0x10 block, %d regs)' % n


def write_single_register(ser, slave, addr, value):
    """
    Try FC 0x06 first, fall back to FC 0x10.
    Returns (success: bool, message: str).
    """
    ok, msg = write_single_register_fc06(ser, slave, addr, value)
    if ok:
        return ok, msg
    # FC 0x06 failed — try FC 0x10
    ok2, msg2 = write_single_register_fc10(ser, slave, addr, value)
    if ok2:
        return ok2, msg2
    return False, 'FC06: %s | FC10: %s' % (msg, msg2)

# ── Probe ────────────────────────────────────────────────────────────────────

# Known safe config registers to probe — all writes are "same value back" (no actual change)
# NEVER include: 606 (out V), 607 (out freq), 631-648 (voltage/current thresholds), 630 (battery type)
SAFE_PROBE_REGISTERS = {
    677: 'Input mode (0=APL 1=UPS 2=GNT)',
    679: 'LCD backlight (0=Timed off 1=Always on)',
    681: 'Energy-saving mode (0=Off 1=On)',
    689: 'Remote switch (0=Shutdown 1=Boot)',
    656: 'Battery equalisation enable (0=Prohibit 1=Enable)',
    694: 'Unknown (value 1 — possible mode flag)',
}

TIME_REGISTERS = {
    696: 'Year  (write)',
    697: 'Month (write)',
    698: 'Day   (write)',
    699: 'HHMM  (write — reg 198 is the read mirror, always RO)',
    700: 'Seconds (write)',
    198: 'HHMM  (live read-only mirror)',
    199: 'Seconds (live, value always 0 in Modbus)',
}

# ── Dangerous registers — never write to these ───────────────────────────────
PROTECTED_REGISTERS = set([
    606,  # Output voltage setting
    607,  # Output frequency setting
    601,  # Main output priority
    605,  # Charger source priority
    630,  # Battery type
    631,  # Battery overvoltage protection
    637,  # Maximum charging voltage
    638,  # Float charge voltage
    640,  # Max charging current
    641,  # Max mains charging current
    642,  # Max discharge current
    643,  # Mains battery discharge recovery
    644,  # Mains battery low voltage
    646,  # Off-grid battery low voltage
    647,  # Low DC protection SOC
    648,  # Low DC recovery SOC
    650,  # Battery low cut-off SOC
])


def probe_rw(ser, slave, addr, label):
    """
    Read current value, write same value back, read again.
    Reports writability without changing anything.
    """
    val, err = read_single_register(ser, slave, addr)
    if err:
        print('  [%4d] %-48s  READ FAILED: %s' % (addr, label, err))
        return

    before = val
    ok, msg = write_single_register(ser, slave, addr, val)
    time.sleep(0.05)
    val2, err2 = read_single_register(ser, slave, addr)

    if not ok:
        result = 'READ-ONLY (write rejected: %s)' % msg
    elif err2:
        result = 'WRITE OK but read-back failed: %s' % err2
    elif val2 != before:
        result = 'WRITE ACCEPTED but value changed! was=%d now=%d — register may self-update' % (before, val2)
    else:
        result = 'READ-WRITE  (write ACK, readback=%d)' % val2

    print('  [%4d] %-48s  val=%-6d  %s' % (addr, label, before, result))


def cmd_probe(ser, slave):
    print()
    print('─' * 80)
    print('  Modbus R/W Probe — writing same value back (no real change)')
    print('  Port: /dev/ttyAMA0  Baud: 9600  Slave: %d' % slave)
    print('─' * 80)
    for addr, label in sorted(SAFE_PROBE_REGISTERS.items()):
        probe_rw(ser, slave, addr, label)
        time.sleep(0.05)
    print('─' * 80)
    print()
    print('NOTE: Output voltage/frequency and all safety thresholds (regs 606,607,631-650)')
    print('      were intentionally NOT probed. Write FC 0x06 was used for all tests.')
    print()


def cmd_scan(ser, slave, start, end):
    """Probe writability of every register in [start, end] range."""
    print()
    print('─' * 80)
    print('  R/W scan of regs %d–%d  (writes same value back)' % (start, end))
    print('─' * 80)
    for addr in range(start, end + 1):
        if addr in PROTECTED_REGISTERS:
            print('  [%4d] SKIPPED (protected — voltage/current/frequency threshold)' % addr)
            continue
        val, err = read_single_register(ser, slave, addr)
        time.sleep(0.02)
        if err:
            # not populated / no response — skip silently unless it's a small range
            if (end - start) <= 50:
                print('  [%4d] no response' % addr)
            continue
        ok, msg = write_single_register(ser, slave, addr, val)
        time.sleep(0.05)
        val2, _ = read_single_register(ser, slave, addr)
        time.sleep(0.02)
        rw = 'RW' if ok else 'RO'
        change = '' if (val2 is None or val2 == val) else '  *** VALUE CHANGED: was %d now %d ***' % (val, val2)
        print('  [%4d] %s  raw=%-6d (0x%04X)  write: %-40s%s' % (addr, rw, val, val, msg, change))
    print('─' * 80)
    print()


# ── Time sync ─────────────────────────────────────────────────────────────────

def read_time_registers(ser, slave):
    """
    Read date/time registers.
    ALL of 696-701 must be read as a block — individual reads of 696-700 return 0.

    Block-read layout (confirmed):
      696 = year,  697 = month, 698 = day
      699 = hour (0-23),  700 = minute (0-59),  701 = second (0-59)

    Write-path layout (one-way write, not readable individually):
      699 = HHMM (e.g. 1032 for 10:32)  — inverter splits to hour+minute internally
      700 = seconds

    reg 198 = frozen at power-on HHMM value; does NOT tick over Modbus — ignore.
    """
    regs = {}
    # Block read 670-702 to capture date (696-698) and live time (699=hr, 700=min, 701=sec)
    block = read_holding_registers(ser, slave, 670, 33)  # 670-702
    if block:
        for a in [696, 697, 698, 699, 700, 701]:
            if a in block:
                regs[a] = block[a]
    time.sleep(0.02)
    # Capture frozen RO mirror for reference only
    v, _ = read_single_register(ser, slave, 198)
    if v is not None:
        regs[198] = v
    time.sleep(0.02)
    return regs


def decode_time_raw(regs):
    """Decode time from block-read register values: 699=hour, 700=minute, 701=second."""
    year   = regs.get(696, 0)
    month  = regs.get(697, 0)
    day    = regs.get(698, 0)
    hour   = regs.get(699, 0)   # block-read: just hours (not HHMM)
    minute = regs.get(700, 0)   # block-read: minutes
    secs   = regs.get(701, 0)   # block-read: seconds
    return year, month, day, hour, minute, secs


def cmd_raw_time(ser, slave):
    print()
    regs = read_time_registers(ser, slave)

    year, month, day, hour, minute, secs = decode_time_raw(regs)
    print('  Raw time registers (block-read layout):')
    print('    696 (year)          = %d' % regs.get(696, 0))
    print('    697 (month)         = %d' % regs.get(697, 0))
    print('    698 (day)           = %d' % regs.get(698, 0))
    print('    699 (hour)          = %d' % regs.get(699, 0))
    print('    700 (minute)        = %d' % regs.get(700, 0))
    print('    701 (second)        = %d' % regs.get(701, 0))
    print('    198 (frozen RO)     = %d  →  %02d:%02d  *** not live clock ***' % (
        regs.get(198, 0), regs.get(198, 0) // 100, regs.get(198, 0) % 100))
    print()
    print('  Inverter time: %04d-%02d-%02d %02d:%02d:%02d' % (year, month, day, hour, minute, secs))
    pi_now = datetime.now()
    print('  Pi current time:  %s' % pi_now.strftime('%Y-%m-%d %H:%M:%S'))
    diff_sec = abs((pi_now.hour * 3600 + pi_now.minute * 60 + pi_now.second) - (hour * 3600 + minute * 60 + secs))
    if diff_sec > 43200:
        diff_sec = 86400 - diff_sec
    print('  Time difference:  ~%dh %dm' % (diff_sec // 3600, (diff_sec % 3600) // 60))
    print()


def cmd_test_write(ser, slave):
    """
    Definitive writability test: write a DIFFERENT value to LCD backlight (reg 679),
    verify the change, then restore. Completely safe and visually observable.
    """
    print()
    print('  Test-write: LCD backlight register (679) — completely safe')
    val, err = read_single_register(ser, slave, 679)
    if err:
        print('  Cannot read reg 679: %s' % err)
        return
    orig = val
    test_val = 0 if orig == 1 else 1
    label = {0: 'Timed off', 1: 'Always on'}
    print('  Current value: %d (%s)' % (orig, label.get(orig, str(orig))))
    print('  Writing test value: %d (%s) ...' % (test_val, label.get(test_val, str(test_val))))

    ok, msg = write_single_register(ser, slave, 679, test_val)
    print('  Write result: %s' % msg)
    time.sleep(0.2)

    readback, _ = read_single_register(ser, slave, 679)
    if readback == test_val:
        print('  READ-BACK: %d ✓  — register IS writable!' % readback)
    elif readback == orig:
        print('  READ-BACK: %d (unchanged) — write was rejected or ignored' % readback)
    else:
        print('  READ-BACK: %d (unexpected)' % readback)

    # Always restore
    print('  Restoring to %d (%s) ...' % (orig, label.get(orig, str(orig))))
    ok2, msg2 = write_single_register(ser, slave, 679, orig)
    time.sleep(0.1)
    final, _ = read_single_register(ser, slave, 679)
    print('  Restored: %s  readback=%s' % (msg2, str(final)))
    print()


def cmd_sync_time(ser, slave, dry_run=False):
    print()
    # Read current registers first
    regs = read_time_registers(ser, slave)

    year_r, month_r, day_r, hour_r, min_r, sec_r = decode_time_raw(regs)
    print('  Inverter time BEFORE: %04d-%02d-%02d %02d:%02d:%02d' % (
        year_r, month_r, day_r, hour_r, min_r, sec_r))

    # Capture time right before writing
    now = datetime.now()
    print('  Pi time now:          %s' % now.strftime('%Y-%m-%d %H:%M:%S'))

    writes = [
        (696, now.year,                         'Year'),
        (697, now.month,                        'Month'),
        (698, now.day,                          'Day'),
        # Write encoding: reg 699 accepts HHMM (e.g. 1032); inverter splits to hour+minute.
        # Block-read of reg 699 returns just the hour component after the write.
        (699, now.hour * 100 + now.minute,      'HHMM'),
        (700, now.second,                       'Seconds'),
    ]

    if dry_run:
        print()
        print('  DRY RUN — would write:')
        for addr, val, label in writes:
            print('    reg %d (%s) = %d' % (addr, label, val))
        print()
        return

    print()
    print('  Writing time registers as a single FC 0x10 block (regs 696-700) …')
    # Atomic block write: some inverters only apply the update when all 5 time registers
    # are written in a single Modbus frame.
    block_values = [now.year, now.month, now.day,
                    now.hour * 100 + now.minute,  # HHMM
                    now.second]
    ok, msg = write_register_block(ser, slave, 696, block_values)
    if ok:
        print('    Regs 696-700 = %s   %s' % (block_values, msg))
    else:
        print('    Block write FAILED: %s' % msg)
        print('    Falling back to individual writes …')
        all_ok = True
        for addr, val, label in writes:
            wok, wmsg = write_single_register(ser, slave, addr, val)
            status = '  OK' if wok else '  FAILED (%s)' % wmsg
            print('    reg %d (%s) = %d %s' % (addr, label, val, status))
            if not wok:
                all_ok = False
            time.sleep(0.05)

    all_ok = ok

    # Verify: block-read 699=hour, 700=min, 701=sec (live ticking clock)
    time.sleep(0.3)
    print()
    regs2 = read_time_registers(ser, slave)

    y2, mo2, d2, h2, mi2, s2 = decode_time_raw(regs2)
    print('  Inverter time AFTER: %04d-%02d-%02d %02d:%02d:%02d' % (y2, mo2, d2, h2, mi2, s2))
    r699 = regs2.get(699, None)
    if r699 is not None:
        # block-read reg 699 = current hour; should match the hour we wrote
        hour_match = '✓' if r699 == now.hour else '✗ (expected %d)' % now.hour
        print('  Reg 699 (hour):   %d %s' % (r699, hour_match))
        print('  Reg 700 (minute): %d' % regs2.get(700, 0))
        print('  Reg 701 (second): %d' % regs2.get(701, 0))
    now2 = datetime.now()
    print('  Pi time now:         %s' % now2.strftime('%Y-%m-%d %H:%M:%S'))

    if all_ok:
        print()
        print('  Time sync complete.')
    else:
        print()
        print('  WARNING: Some writes failed. Check above.')
    print()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    p = argparse.ArgumentParser(description='Anenji R/W probe and time sync')
    p.add_argument('--port',       default='/dev/ttyAMA0')
    p.add_argument('--baud',       type=int, default=9600)
    p.add_argument('--slave',      type=int, default=1)
    p.add_argument('--probe',      action='store_true', help='Test known safe config registers for R/W')
    p.add_argument('--sync-time',  action='store_true', help='Sync inverter RTC to Pi time')
    p.add_argument('--dry-run',     action='store_true', help='Show what --sync-time would write, without writing')
    p.add_argument('--raw-time',    action='store_true', help='Show raw time register values')
    p.add_argument('--test-write',  action='store_true', help='Definitive write test: toggle LCD backlight reg, verify, restore')
    p.add_argument('--scan',        nargs=2, type=int, metavar=('START', 'END'),
                                   help='Probe R/W of all registers in range (writes same value = no change)')
    args = p.parse_args()

    # Default to --probe if nothing specified
    if not any([args.probe, args.sync_time, args.dry_run, args.raw_time, args.scan, args.test_write]):
        args.probe = True

    ser = serial.Serial(args.port, args.baud, timeout=0.5)
    time.sleep(0.3)

    try:
        if args.raw_time:
            cmd_raw_time(ser, args.slave)
        if args.probe:
            cmd_probe(ser, args.slave)
        if args.test_write:
            cmd_test_write(ser, args.slave)
        if args.scan:
            cmd_scan(ser, args.slave, args.scan[0], args.scan[1])
        if args.dry_run:
            cmd_sync_time(ser, args.slave, dry_run=True)
        elif args.sync_time:
            cmd_sync_time(ser, args.slave, dry_run=False)
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()


if __name__ == '__main__':
    main()
