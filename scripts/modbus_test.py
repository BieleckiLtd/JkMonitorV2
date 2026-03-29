#!/usr/bin/env python3
"""Test Modbus RTU write approaches on JK BMS to diagnose exception 0x03."""
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
    return resp

ser = serial.Serial("/dev/ttyUSB0", 115200, timeout=1)

# balancerSwitch: byte offset 0x78, register = 0x1000 + 0x78/2 = 0x103C
# Current raw value = 1 (enabled). We will write 1 back (no actual change).
ADDR = 1
REG = 0x103C
VAL = 1

# Test 1: Function 0x10 (Write Multiple Registers) - 2 registers, 4 bytes (current impl)
pdu = struct.pack(">BBHHBBBBB", ADDR, 0x10, REG, 2, 4,
    (VAL >> 24) & 0xFF, (VAL >> 16) & 0xFF, (VAL >> 8) & 0xFF, VAL & 0xFF)
crc = crc16(pdu)
frame10 = pdu + struct.pack("<H", crc)
send_recv(ser, frame10, "FC 0x10 Write Multiple (2 regs) @ 0x103C = 1")

time.sleep(0.5)

# Test 2: Function 0x06 (Write Single Register) - high word at 0x103C
val_hi = (VAL >> 16) & 0xFFFF
pdu = struct.pack(">BBHH", ADDR, 0x06, REG, val_hi)
crc = crc16(pdu)
frame06_hi = pdu + struct.pack("<H", crc)
send_recv(ser, frame06_hi, "FC 0x06 Write Single @ 0x103C = hi word (0)")

time.sleep(0.5)

# Test 3: Function 0x06 (Write Single Register) - low word at 0x103D
val_lo = VAL & 0xFFFF
pdu = struct.pack(">BBHH", ADDR, 0x06, REG + 1, val_lo)
crc = crc16(pdu)
frame06_lo = pdu + struct.pack("<H", crc)
send_recv(ser, frame06_lo, "FC 0x06 Write Single @ 0x103D = lo word (1)")

time.sleep(0.5)

# Test 4: Function 0x10 but with 1 register, 2 bytes (just low word at 0x103C)
pdu = struct.pack(">BBHHBB", ADDR, 0x10, REG, 1, 2, (VAL >> 8) & 0xFF) + bytes([VAL & 0xFF])
crc = crc16(pdu)
frame10_1reg = pdu + struct.pack("<H", crc)
send_recv(ser, frame10_1reg, "FC 0x10 Write Multiple (1 reg) @ 0x103C = 1")

time.sleep(0.5)

# Test 5: Function 0x10 but with 1 register at 0x103D (low word)
pdu = struct.pack(">BBHHBB", ADDR, 0x10, REG + 1, 1, 2, (VAL >> 8) & 0xFF) + bytes([VAL & 0xFF])
crc = crc16(pdu)
frame10_lo = pdu + struct.pack("<H", crc)
send_recv(ser, frame10_lo, "FC 0x10 Write Multiple (1 reg) @ 0x103D = 1")

time.sleep(0.5)

# Test 6: Read back to confirm value
pdu = struct.pack(">BBHH", ADDR, 0x03, REG, 2)
crc = crc16(pdu)
read_frame = pdu + struct.pack("<H", crc)
resp = send_recv(ser, read_frame, "FC 0x03 Read @ 0x103C (2 regs)")
if len(resp) >= 9 and resp[1] == 0x03:
    val = struct.unpack(">I", resp[3:7])[0]
    print(f"  Read-back value: {val}")

ser.close()
print("\nDone.")
