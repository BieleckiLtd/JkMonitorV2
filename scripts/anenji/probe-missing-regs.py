#!/usr/bin/env python3
"""Probe for F0P10 (Modbus address) and F0P16 (Dry contact mode) registers."""
import struct, serial, time

ser = serial.Serial('/dev/ttyAMA0', 9600, timeout=2)

def read_reg(slave, addr, count=1):
    frame = struct.pack('>BBHH', slave, 3, addr, count)
    crc = 0xFFFF
    for b in frame:
        crc ^= b
        for _ in range(8):
            if crc & 1: crc = (crc >> 1) ^ 0xA001
            else: crc >>= 1
    frame += struct.pack('<H', crc)
    ser.reset_input_buffer()
    ser.write(frame)
    time.sleep(0.15)
    resp = ser.read(256)
    if len(resp) >= 5 + count * 2:
        vals = []
        for i in range(count):
            vals.append(struct.unpack('>H', resp[3 + i * 2:5 + i * 2])[0])
        return vals
    return None

print("=== Info ID block (regs 171-192) ===")
vals = read_reg(1, 171, 22)
if vals:
    for i, v in enumerate(vals):
        print(f"  Reg {171+i} = {v}")

print("\n=== Settings block unknowns (608-629) ===")
vals = read_reg(1, 608, 22)
if vals:
    nonzero = [(608+i, v) for i, v in enumerate(vals) if v != 0]
    if nonzero:
        for reg, v in nonzero:
            print(f"  Reg {reg} = {v} (NON-ZERO)")
    else:
        print("  All zero")

print("\n=== Reg 690 (just outside settings block) ===")
v = read_reg(1, 690)
print(f"  Reg 690 = {v}")

print("\n=== Reg 685-686 (unknown in settings) ===")
vals = read_reg(1, 685, 2)
if vals:
    for i, v in enumerate(vals):
        print(f"  Reg {685+i} = {v}")

print("\n=== Reg 602, 604 (unknown in settings) ===")
for r in [602, 604]:
    v = read_reg(1, r)
    print(f"  Reg {r} = {v}")

print("\n=== Looking for Modbus address: scanning regs 0-20 ===")
vals = read_reg(1, 0, 21)
if vals:
    for i, v in enumerate(vals):
        if v != 0:
            print(f"  Reg {i} = {v}")
    if all(v == 0 for v in vals):
        print("  All zero")
else:
    print("  Read failed (regs 0-20)")

ser.close()
print("\nDone.")
