#!/usr/bin/env python3
"""Modbus RTU diagnostic: discover correct register addressing for JK Inverter BMS v19."""
import serial, struct, time, sys

PORT = '/dev/ttyUSB0'
BAUD = 115200
ADDR = 0x01
TIMEOUT = 1.0

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

def build_read(slave, start_reg, count):
    pdu = struct.pack('>BBHH', slave, 0x03, start_reg, count)
    c = crc16(pdu)
    return pdu + struct.pack('<H', c)

def try_read(ser, slave, start_reg, count, label=''):
    req = build_read(slave, start_reg, count)
    ser.reset_input_buffer()
    ser.write(req)
    time.sleep(0.2)
    resp = ser.read(512)
    status = 'no response'
    if resp:
        if len(resp) >= 5 and (resp[1] & 0x80):
            status = f'EXCEPTION func=0x{resp[1]:02X} code=0x{resp[2]:02X}'
        elif len(resp) >= 3 and resp[1] == 0x03:
            bc = resp[2]
            status = f'OK {bc} bytes data'
            if bc >= 2:
                status += f' first_word=0x{resp[3]:02X}{resp[4]:02X}={resp[3]*256+resp[4]}'
        else:
            status = f'unknown {len(resp)}B: {resp.hex()}'
    tag = f' ({label})' if label else ''
    print(f'  reg=0x{start_reg:04X} cnt={count:3d}{tag}: {status}')
    return resp

ser = serial.Serial(PORT, BAUD, timeout=TIMEOUT, parity='N', stopbits=1, bytesize=8)
time.sleep(0.1)

print(f'=== Modbus RTU diag on {PORT} @ {BAUD} baud, slave={ADDR} ===\n')

# Test 1: Try different slave addresses
print('--- Test 1: Slave address scan (read reg 0x1200 x1) ---')
for addr in [0x00, 0x01, 0x02]:
    req = build_read(addr, 0x1200, 1)
    ser.reset_input_buffer()
    ser.write(req)
    time.sleep(0.3)
    resp = ser.read(512)
    if resp:
        print(f'  addr={addr}: got {len(resp)}B: {resp[:10].hex()}...')
    else:
        print(f'  addr={addr}: no response')

# Test 2: Try the documented live-data base address
print('\n--- Test 2: Register base discovery (count=1) ---')
for base in [0x0000, 0x1000, 0x1200, 0x1400, 0x1600]:
    try_read(ser, ADDR, base, 1, f'base 0x{base:04X}')

# Test 3: If 0x1200 works with 1, try increasing counts
print('\n--- Test 3: Register count sweep at 0x1200 ---')
for count in [1, 10, 32, 50, 64, 80, 100, 115, 125]:
    try_read(ser, ADDR, 0x1200, count, f'{count} regs')

# Test 4: Try byte-offset-based addressing (offset/2 as register offset from base)
print('\n--- Test 4: Cell voltage reads (various offsets) ---')
# If offsets in PDF are byte offsets: register = base + byte_offset/2
# Cell 0 at offset 0x0000 -> register 0x1200+0 = 0x1200
# Cell status at offset 0x0040 -> register 0x1200+0x20 = 0x1220
# Avg cell V at offset 0x0044 -> register 0x1200+0x22 = 0x1222
# Total V at offset 0x0090 -> register 0x1200+0x48 = 0x1248
# SOC at offset 0x00A6 -> register 0x1200+0x53 = 0x1253
for reg, label in [
    (0x1200, 'cell0 (byte offset model)'),
    (0x1220, 'cell_status (byte offset model)'),
    (0x1248, 'total_V (byte offset model)'),
    (0x1253, 'SOC (byte offset model)'),
]:
    try_read(ser, ADDR, reg, 1, label)

# Test 5: Try register-offset-based addressing (offset as direct register from base)
print('\n--- Test 5: Register offset model (offset IS register) ---')
# If offsets in PDF are register offsets directly:
# Cell 0 at offset 0x0000 -> register 0x1200
# Cell status at offset 0x0040 -> register 0x1240
# Total V at offset 0x0090 -> register 0x1290
# SOC at offset 0x00A6 -> register 0x12A6
for reg, label in [
    (0x1200, 'cell0 (reg offset model)'),
    (0x1240, 'cell_status (reg offset model)'),
    (0x1290, 'total_V (reg offset model)'),
    (0x12A6, 'SOC (reg offset model)'),
]:
    try_read(ser, ADDR, reg, 1, label)

# Test 6: If we find the right model, read a block of cell voltages
print('\n--- Test 6: Read first 32 registers at 0x1200 (cells?) ---')
resp = try_read(ser, ADDR, 0x1200, 32, '32 cell registers')
if resp and len(resp) >= 3 and resp[1] == 0x03:
    bc = resp[2]
    data = resp[3:3+bc]
    print('  Data dump:')
    for i in range(0, min(bc, 64), 2):
        val = data[i]*256 + data[i+1] if i+1 < len(data) else 0
        print(f'    reg[{i//2:2d}] = {val:5d} (0x{val:04X})')

ser.close()
print('\nDone.')
