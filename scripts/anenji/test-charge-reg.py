#!/usr/bin/env python3
"""Test whether register 632 controls charge priority on the Anenji inverter."""
import serial, struct, time

def crc_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

def write_reg(ser, slave, addr, value):
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
        if chunk: buf.extend(chunk)
        elif buf: break
    if len(buf) >= 4 and buf[1] == 0x10:
        return 'OK'
    if len(buf) >= 3 and buf[1] == 0x90:
        return 'ERR code=%d' % buf[2]
    return 'TIMEOUT'

def read_reg(ser, slave, addr):
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
        if chunk: buf.extend(chunk)
        elif buf: break
    if len(buf) >= 5 and buf[1] == 0x03:
        return struct.unpack('>H', buf[3:5])[0]
    return None

ser = serial.Serial('/dev/ttyAMA0', 9600, timeout=2, write_timeout=1)
time.sleep(0.1)

print('Before write:')
for r in [600, 601, 605]:
    v = read_reg(ser, 1, r)
    time.sleep(0.05)
    print('  reg %d = %s' % (r, v))

print()
print('Writing 1 (SUB) to reg 601...')
result = write_reg(ser, 1, 601, 1)
print('  Result: %s' % result)
time.sleep(0.5)

print()
print('After write:')
for r in [600, 601, 605]:
    v = read_reg(ser, 1, r)
    time.sleep(0.05)
    print('  reg %d = %s' % (r, v))

print()
print('CHECK THE LCD NOW - F1 Program 01 should show SUB')
print('Waiting 30 seconds before restoring...')
time.sleep(30)

print('Restoring reg 601 to 2 (SBU)...')
result = write_reg(ser, 1, 601, 2)
print('  Result: %s' % result)
time.sleep(0.5)

print()
print('After restore:')
for r in [600, 601, 605]:
    v = read_reg(ser, 1, r)
    time.sleep(0.05)
    print('  reg %d = %s' % (r, v))

ser.close()
print('Done.')
