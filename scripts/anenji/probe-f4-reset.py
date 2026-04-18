#!/usr/bin/env python3
"""Probe for the F4P01 'Reset all stored data' register on the Anenji inverter.

Strategy:
- Standard GM6200 factory-reset command is at register 421 (write value 1).
- With Anenji's various offsets, candidates include:
    421+269 = 690 (already identified as F0P16 dry contact)
    421+300 = 721
    421+374 = 795
- Also scan the unknown gap registers: 702-710, 714-730, 790-800
- We READ first to see which registers respond (no writes = safe).
- Then report which candidates accept reads so we can decide whether to
  attempt a write probe.

NOTE: This script does NOT write to any register. Factory reset would be
destructive if triggered accidentally.
"""
import struct, serial, time, sys

PORT = '/dev/ttyAMA0'
BAUD = 9600
SLAVE = 1

def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

def read_register(ser, addr):
    """Read a single holding register. Returns value or None on error."""
    pdu = struct.pack('>BBHH', SLAVE, 3, addr, 1)
    pdu += struct.pack('<H', crc16(pdu))
    ser.reset_input_buffer()
    ser.write(pdu)
    time.sleep(0.12)
    resp = ser.read(64)
    if len(resp) >= 7 and resp[1] == 3:
        return struct.unpack('>H', resp[3:5])[0]
    elif len(resp) >= 5 and resp[1] == 0x83:
        exc = resp[2]
        return f"ERR:{exc}"
    return None

def write_register(ser, addr, value):
    """Write a single holding register via FC 0x10 (write multiple, qty=1).
    Returns True on success, error string on failure, None on no response."""
    pdu = struct.pack('>BBHHBH', SLAVE, 0x10, addr, 1, 2, value)
    pdu += struct.pack('<H', crc16(pdu))
    ser.reset_input_buffer()
    ser.write(pdu)
    time.sleep(0.12)
    resp = ser.read(64)
    if len(resp) >= 8 and resp[1] == 0x10:
        return True
    elif len(resp) >= 5 and resp[1] == 0x90:
        exc = resp[2]
        return f"ERR:{exc}"
    return None

ser = serial.Serial(PORT, BAUD, bytesize=8, parity='N', stopbits=1, timeout=0.3)
time.sleep(0.2)

# ---- Phase 1: Read candidate registers ----
print("=== Phase 1: Reading candidate registers (safe, no writes) ===\n")

# Primary candidates based on standard register 421 with different offsets
primary_candidates = [721, 795]  # 421+300, 421+374

# Unexplored ranges near settings
scan_ranges = list(range(690, 696)) + list(range(702, 730)) + list(range(790, 810))

# Combine and deduplicate
all_candidates = sorted(set(primary_candidates + scan_ranges))

writable_candidates = []
for reg in all_candidates:
    val = read_register(ser, reg)
    if val is not None:
        status = f"value={val}" if not isinstance(val, str) else val
        print(f"  Reg {reg:4d}: {status}")
        if not isinstance(val, str):  # Not an error
            writable_candidates.append((reg, val))
    # else: no response / timeout

print(f"\n=== Phase 1 complete: {len(writable_candidates)} registers responded ===\n")

# ---- Phase 2: Try write-and-restore on promising registers ----
# ONLY test registers that currently hold value 0 (less likely to be in-use settings)
# We write 0 (same as current) to check if the register accepts writes at all
print("=== Phase 2: Testing write-acceptance (writing current value back) ===\n")

for reg, val in writable_candidates:
    result = write_register(ser, reg, val)  # Write current value back = no change
    if result is True:
        print(f"  Reg {reg:4d}: WRITABLE (accepts writes, current value={val})")
    elif isinstance(result, str):
        print(f"  Reg {reg:4d}: {result} (write rejected, current value={val})")
    else:
        print(f"  Reg {reg:4d}: NO RESPONSE to write (current value={val})")

# ---- Phase 3: Special check for write-only registers ----
# Some factory-reset registers are write-only (read returns error but write succeeds)
# Check registers that gave read errors
print("\n=== Phase 3: Checking write-only candidates (registers that gave read errors) ===")
print("Testing if they accept a write of value 0 (a no-op for most reset commands)...\n")

# Standard reset command typically needs value 1 to trigger, so writing 0 should be safe
write_only_candidates = [721, 795]  # The main candidates
for reg in write_only_candidates:
    val = read_register(ser, reg)
    if isinstance(val, str) and val.startswith("ERR"):
        # This register gave a read error — might be write-only
        result = write_register(ser, reg, 0)
        if result is True:
            print(f"  Reg {reg:4d}: WRITE-ONLY CANDIDATE (read={val}, write of 0 accepted!)")
        elif isinstance(result, str):
            print(f"  Reg {reg:4d}: Both read and write error (read={val}, write={result})")
        else:
            print(f"  Reg {reg:4d}: Read error, write no response (read={val})")
    elif val is not None:
        print(f"  Reg {reg:4d}: Readable (value={val}), already tested in Phase 2")
    else:
        print(f"  Reg {reg:4d}: No response to read")

ser.close()
print("\n=== Probe complete ===")
print("Look for registers that are WRITE-ONLY or writable with value 0.")
print("The factory reset register likely needs write value=1 to trigger.")
