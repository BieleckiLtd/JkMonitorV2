#!/usr/bin/env python3
"""Test writing at base address 0x1000 with current value to verify write mechanism."""
import serial, struct, time

def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

def send_recv(ser, frame, label):
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    print(f"\n--- {label} ---")
    print(f"TX: {frame.hex(' ')}")
    ser.write(frame)
    ser.flush()
    time.sleep(0.3)
    resp = ser.read(256)
    print(f"RX ({len(resp)} bytes): {resp.hex(' ')}")
    if len(resp) >= 3 and (resp[1] & 0x80):
        print(f"  EXCEPTION: func=0x{resp[1]:02X} code=0x{resp[2]:02X}")
    elif len(resp) >= 8 and resp[1] == 0x10:
        start = struct.unpack(">H", resp[2:4])[0]
        count = struct.unpack(">H", resp[4:6])[0]
        print(f"  WRITE OK: start=0x{start:04X} count={count}")
    return resp

ser = serial.Serial("/dev/ttyUSB0", 115200, timeout=1)
ADDR = 1

# Test: Write smartSleepVoltage (byte offset 0x00 -> register 0x1000) with current value 3500
# This should be safe since we're writing back the current value
REG = 0x1000
VAL = 3500  # current value

# Function 0x10, 2 registers, 4 bytes
pdu = struct.pack(">BBHHBBBBB", ADDR, 0x10, REG, 2, 4,
    (VAL >> 24) & 0xFF, (VAL >> 16) & 0xFF, (VAL >> 8) & 0xFF, VAL & 0xFF)
crc = crc16(pdu)
frame = pdu + struct.pack("<H", crc)
send_recv(ser, frame, "FC 0x10 Write @ 0x1000 val=3500 (smartSleepVoltage, 2 regs)")

time.sleep(0.5)

# Try 1 register too
pdu = struct.pack(">BBHHBBB", ADDR, 0x10, REG, 1, 2,
    (VAL >> 8) & 0xFF, VAL & 0xFF)
crc = crc16(pdu)
frame = pdu + struct.pack("<H", crc)
send_recv(ser, frame, "FC 0x10 Write @ 0x1000 val=3500 (smartSleepVoltage, 1 reg)")

time.sleep(0.5)

# Now check: maybe the BMS uses per-parameter indexing?
# Parameter 0 = register 0x1000, parameter 1 = register 0x1001, etc.
# Each parameter is a 32-bit value addressed as a single "register" in the BMS.
# Try writing balancerSwitch as parameter index 30 -> address 0x101E
# Writing value 1 (keeping same value)
REG_PARAM30 = 0x1000 + 30  # 0x101E
pdu = struct.pack(">BBHHBBBBB", ADDR, 0x10, REG_PARAM30, 2, 4, 0, 0, 0, 1)
crc = crc16(pdu)
frame = pdu + struct.pack("<H", crc)
send_recv(ser, frame, "FC 0x10 Write @ 0x101E val=1 (balancerSwitch as param #30, 2 regs)")

time.sleep(0.5)

# Try single-register write at 0x101E
pdu = struct.pack(">BBHHBBB", ADDR, 0x10, REG_PARAM30, 1, 2, 0, 1)
crc = crc16(pdu)
frame = pdu + struct.pack("<H", crc)
send_recv(ser, frame, "FC 0x10 Write @ 0x101E val=1 (balancerSwitch as param #30, 1 reg)")

time.sleep(0.5)

# Now try the byte offset as the register offset directly
# balancerSwitch byte offset = 0x78 -> address 0x1078?
REG_BYTE = 0x1000 + 0x78  # 0x1078
pdu = struct.pack(">BBHHBBBBB", ADDR, 0x10, REG_BYTE, 2, 4, 0, 0, 0, 1)
crc = crc16(pdu)
frame = pdu + struct.pack("<H", crc)
send_recv(ser, frame, "FC 0x10 Write @ 0x1078 val=1 (byte offset as reg, 2 regs)")

time.sleep(0.5)

# Read back smartSleepVoltage to verify nothing changed
pdu = struct.pack(">BBHH", ADDR, 0x03, 0x1000, 2)
crc = crc16(pdu)
frame = pdu + struct.pack("<H", crc)
ser.reset_input_buffer()
ser.write(frame)
ser.flush()
time.sleep(0.3)
resp = ser.read(256)
if len(resp) >= 7 and resp[1] == 0x03:
    val = struct.unpack(">I", resp[3:7])[0]
    print(f"\nRead back smartSleepVoltage: {val} (expected 3500)")

ser.close()
print("\nDone.")
