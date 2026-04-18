#!/usr/bin/env python3
"""Comprehensive register probe for Anenji inverter.
Reads ALL registers in settings range 600-700, plus standard ranges,
to create a complete register map.
"""
import serial, struct, time, sys

def crc_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

def read_regs(ser, slave, start, count):
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
    if buf[1] != 0x03:
        return None
    bc = buf[2]
    data = buf[3:3+bc]
    regs = {}
    for i in range(0, len(data), 2):
        if i + 1 < len(data):
            regs[start + i // 2] = struct.unpack('>H', data[i:i+2])[0]
    return regs

def write_reg(ser, slave, addr, value):
    """Write a single register using FC 0x10 (same as device definition)."""
    pdu = struct.pack('>BBHHBH', slave, 0x10, addr, 1, 2, value)
    c = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    buf = bytearray()
    t0 = time.time()
    while time.time() - t0 < 2.0 and len(buf) < 8:
        chunk = ser.read(8 - len(buf))
        if chunk:
            buf.extend(chunk)
        elif buf:
            break
    if len(buf) >= 4 and buf[1] == 0x10:
        return True  # success
    if len(buf) >= 3 and buf[1] == 0x90:
        return buf[2]  # error code
    return None  # timeout

ser = serial.Serial('/dev/ttyAMA0', 9600, timeout=2, write_timeout=1)
time.sleep(0.1)

print("=" * 70)
print("ANENJI INVERTER COMPLETE REGISTER PROBE")
print("=" * 70)

# Read ALL registers 600-700 (settings range)
print("\n=== SETTINGS REGISTERS 600-700 (ALL values including zeros) ===")
print(f"{'Addr':>5s}  {'Raw':>6s}  {'Signed':>7s}  {'Hex':>6s}")
print("-" * 35)
for base in range(600, 701, 25):
    count = min(25, 701 - base)
    r = read_regs(ser, 1, base, count)
    if r:
        for addr in sorted(r.keys()):
            v = r[addr]
            sv = v if v < 32768 else v - 65536
            marker = " *" if v != 0 else ""
            print(f"{addr:5d}  {v:6d}  {sv:7d}  0x{v:04X}{marker}")
    else:
        print(f"  (read failed for range {base}-{base+count-1})")
    time.sleep(0.05)

# Read live data ranges for reference
print("\n=== LIVE DATA: BATTERY 275-285 ===")
r = read_regs(ser, 1, 275, 11)
if r:
    for addr in sorted(r.keys()):
        v = r[addr]
        sv = v if v < 32768 else v - 65536
        marker = " *" if v != 0 else ""
        print(f"{addr:5d}  {v:6d}  {sv:7d}  0x{v:04X}{marker}")

print("\n=== LIVE DATA: AC/OUTPUT 335-355 ===")
r = read_regs(ser, 1, 335, 21)
if r:
    for addr in sorted(r.keys()):
        v = r[addr]
        sv = v if v < 32768 else v - 65536
        marker = " *" if v != 0 else ""
        print(f"{addr:5d}  {v:6d}  {sv:7d}  0x{v:04X}{marker}")

# Read standard live data 196-236
print("\n=== STANDARD LIVE DATA 196-236 ===")
for base in range(196, 237, 25):
    count = min(25, 237 - base)
    r = read_regs(ser, 1, base, count)
    if r:
        for addr in sorted(r.keys()):
            v = r[addr]
            sv = v if v < 32768 else v - 65536
            marker = " *" if v != 0 else ""
            print(f"{addr:5d}  {v:6d}  {sv:7d}  0x{v:04X}{marker}")
    time.sleep(0.05)

# Read info registers 171-198
print("\n=== INFO REGISTERS 171-198 ===")
r = read_regs(ser, 1, 171, 28)
if r:
    for addr in sorted(r.keys()):
        v = r[addr]
        sv = v if v < 32768 else v - 65536
        marker = " *" if v != 0 else ""
        print(f"{addr:5d}  {v:6d}  {sv:7d}  0x{v:04X}{marker}")

# Read firmware/rated info 690-700
print("\n=== FIRMWARE/RATED 690-770 ===")
for base in range(690, 771, 25):
    count = min(25, 771 - base)
    r = read_regs(ser, 1, base, count)
    if r:
        for addr in sorted(r.keys()):
            v = r[addr]
            sv = v if v < 32768 else v - 65536
            marker = " *" if v != 0 else ""
            print(f"{addr:5d}  {v:6d}  {sv:7d}  0x{v:04X}{marker}")
    time.sleep(0.05)

# Now test writability of ALL settings registers 600-700
# Method: read current value, write it back, check for success/error
print("\n" + "=" * 70)
print("WRITABILITY TEST: REGISTERS 600-700")
print("(Writing current value back - safe, no actual changes)")
print("=" * 70)

# First read all current values
all_vals = {}
for base in range(600, 701, 25):
    count = min(25, 701 - base)
    r = read_regs(ser, 1, base, count)
    if r:
        all_vals.update(r)
    time.sleep(0.05)

# Test writability
print(f"\n{'Addr':>5s}  {'Value':>6s}  {'Write Result':>15s}")
print("-" * 35)
for addr in range(600, 701):
    if addr not in all_vals:
        continue
    val = all_vals[addr]
    result = write_reg(ser, 1, addr, val)
    time.sleep(0.1)  # Wait between writes
    if result is True:
        print(f"{addr:5d}  {val:6d}  OK (writable)")
    elif isinstance(result, int):
        errmap = {1: "read-only", 3: "out-of-range", 7: "mode-restricted"}
        errmsg = errmap.get(result, f"error 0x{result:02X}")
        print(f"{addr:5d}  {val:6d}  ERR: {errmsg}")
    else:
        print(f"{addr:5d}  {val:6d}  TIMEOUT")

# Also test some specific addresses that might be settings
print("\n=== TESTING SPECIFIC ADDRESSES ===")
extra_addrs = [
    (300, "std:output_mode"),
    (301, "std:output_priority"),
    (302, "std:input_voltage_range"),
    (305, "std:lcd_backlight"),
    (307, "std:energy_saving"),
    (320, "std:output_voltage"),
    (331, "std:charge_priority"),
    (420, "std:remote_switch"),
]
for addr, label in extra_addrs:
    r = read_regs(ser, 1, addr, 1)
    if r and addr in r:
        val = r[addr]
        result = write_reg(ser, 1, addr, val)
        time.sleep(0.1)
        if result is True:
            print(f"{addr:5d}  {val:6d}  OK (writable)  [{label}]")
        elif isinstance(result, int):
            errmap = {1: "read-only", 3: "out-of-range", 7: "mode-restricted"}
            errmsg = errmap.get(result, f"error 0x{result:02X}")
            print(f"{addr:5d}  {val:6d}  ERR: {errmsg}  [{label}]")
        else:
            print(f"{addr:5d}  {val:6d}  TIMEOUT  [{label}]")
    time.sleep(0.05)

ser.close()
print("\nDone.")
