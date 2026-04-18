#!/usr/bin/env python3
"""Probe uncharted register gaps to find BMS charge request voltage (~552 = 55.2V)."""
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
    expect = 5 + count * 2
    buf = bytearray()
    t0 = time.time()
    while time.time() - t0 < 2.0 and len(buf) < expect:
        chunk = ser.read(expect - len(buf))
        if chunk:
            buf.extend(chunk)
        elif buf:
            break
    if len(buf) >= 5 + count * 2 and buf[1] == 0x03:
        values = []
        for i in range(count):
            off = 3 + i * 2
            values.append(struct.unpack('>H', buf[off:off+2])[0])
        return values
    if len(buf) >= 3 and buf[1] == 0x83:
        return None  # error
    return None

ser = serial.Serial('/dev/ttyAMA0', 9600, timeout=2, write_timeout=1)
time.sleep(0.1)

# Probe all uncharted gaps looking for charge request voltage
ranges = [
    (0, 50),     # 0-49
    (50, 50),    # 50-99
    (100, 50),   # 100-149
    (150, 21),   # 150-170 (before info_id at 171)
    (771, 50),   # 771-820 (after firmware area)
    (821, 50),   # 821-870
    (871, 50),   # 871-920
    (921, 50),   # 921-970
    (971, 30),   # 971-1000
]

print("=== Probing uncharted register ranges ===")
print("Looking for BMS charge request voltage (~552 = 55.2V)")
print()

all_found = []
for start, count in ranges:
    vals = read_regs(ser, 1, start, count)
    time.sleep(0.1)
    if vals is None:
        print("  Range %d-%d: READ ERROR" % (start, start + count - 1))
        # Try smaller blocks
        for s in range(start, start + count, 10):
            c = min(10, start + count - s)
            v2 = read_regs(ser, 1, s, c)
            time.sleep(0.05)
            if v2:
                for i, v in enumerate(v2):
                    if v != 0:
                        reg = s + i
                        signed = v - 65536 if v > 32767 else v
                        print("  reg %d = %d (0x%04X) signed=%d" % (reg, v, v, signed))
                        all_found.append((reg, v, signed))
    else:
        for i, v in enumerate(vals):
            if v != 0:
                reg = start + i
                signed = v - 65536 if v > 32767 else v
                print("  reg %d = %d (0x%04X) signed=%d" % (reg, v, v, signed))
                all_found.append((reg, v, signed))

print()
print("=== Summary: all non-zero registers in gaps ===")
for reg, v, signed in all_found:
    x01 = v * 0.1
    x001 = v * 0.01
    note = ""
    if 540 <= v <= 560:
        note = " *** LIKELY CHARGE REQUEST VOLTAGE (x0.1V = %.1fV) ***" % x01
    elif 5400 <= v <= 5600:
        note = " *** LIKELY CHARGE REQUEST VOLTAGE (x0.01V = %.2fV) ***" % x001
    print("  reg %d = %d (x0.1=%.1f, x0.01=%.2f)%s" % (reg, v, x01, x001, note))

ser.close()
print()
print("Done.")
