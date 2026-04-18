#!/usr/bin/env python3
"""Probe for Modbus address (F0P10) and Dry contact mode (F0P16) registers.

Strategy:
- Modbus address register should hold current slave address (1)
- Try writing 1 to candidate regs (686, 685) and read back
- For dry contact, check if reg 680 or 690 holds the setting
"""
import struct, serial, time

ser = serial.Serial('/dev/ttyAMA0', 9600, timeout=2)

def calc_crc(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

def read_reg(slave, addr, count=1):
    frame = struct.pack('>BBHH', slave, 3, addr, count)
    frame += struct.pack('<H', calc_crc(frame))
    ser.reset_input_buffer()
    ser.write(frame)
    time.sleep(0.15)
    resp = ser.read(256)
    if len(resp) >= 5 + count * 2:
        vals = []
        for i in range(count):
            vals.append(struct.unpack('>H', resp[3 + i * 2:5 + i * 2])[0])
        return vals if count > 1 else vals[0]
    return None

def write_reg(slave, addr, value):
    """Write single register using FC 0x10 (write multiple, qty=1)."""
    frame = struct.pack('>BBHHBH', slave, 0x10, addr, 1, 2, value)
    frame += struct.pack('<H', calc_crc(frame))
    ser.reset_input_buffer()
    ser.write(frame)
    time.sleep(0.15)
    resp = ser.read(256)
    if len(resp) >= 6:
        fc = resp[1]
        if fc == 0x10:
            return True  # Success
        elif fc == 0x90:
            exc = resp[2]
            return f"ERR:0x{exc:02X}"
    return None

# First, read current values of all candidate registers
print("=== Current values of candidate registers ===")
for r in [680, 685, 686, 690]:
    v = read_reg(1, r)
    print(f"  Reg {r} = {v}")

# Test: Write 1 to reg 686, read back (Modbus address candidate)
print("\n=== Test reg 686 (Modbus address candidate, std 312+374) ===")
result = write_reg(1, 686, 1)
print(f"  Write 1 to 686: {result}")
time.sleep(0.1)
v = read_reg(1, 686)
print(f"  Read back 686: {v}")
# Restore to 0
write_reg(1, 686, 0)
time.sleep(0.1)
v = read_reg(1, 686)
print(f"  Restored 686 to 0, read: {v}")

# Test: Write 1 to reg 685, read back
print("\n=== Test reg 685 (alternative Modbus address candidate) ===")
result = write_reg(1, 685, 1)
print(f"  Write 1 to 685: {result}")
time.sleep(0.1)
v = read_reg(1, 685)
print(f"  Read back 685: {v}")
# Restore to 0
write_reg(1, 685, 0)
time.sleep(0.1)
v = read_reg(1, 685)
print(f"  Restored 685 to 0, read: {v}")

# Test: Write 1 to reg 680, read back (dry contact candidate)
print("\n=== Test reg 680 (Dry contact mode candidate) ===")
result = write_reg(1, 680, 1)
print(f"  Write 1 to 680: {result}")
time.sleep(0.1)
v = read_reg(1, 680)
print(f"  Read back 680: {v}")
# Restore to 0
write_reg(1, 680, 0)
time.sleep(0.1)
v = read_reg(1, 680)
print(f"  Restored 680 to 0, read: {v}")

# Test: Write 1 to reg 690, read back (dry contact candidate alt)
print("\n=== Test reg 690 (Dry contact mode candidate alt) ===")
result = write_reg(1, 690, 1)
print(f"  Write 1 to 690: {result}")
time.sleep(0.1)
v = read_reg(1, 690)
print(f"  Read back 690: {v}")
# Restore to 0
write_reg(1, 690, 0)
time.sleep(0.1)
v = read_reg(1, 690)
print(f"  Restored 690 to 0, read: {v}")

# Also read the full 680-690 block to see if any values changed
print("\n=== Full read 680-690 ===")
vals = read_reg(1, 680, 11)
if vals:
    for i, v in enumerate(vals):
        print(f"  Reg {680+i} = {v}")

ser.close()
print("\nDone.")
