#!/usr/bin/env python3
"""Dump all readable registers from JK Inverter BMS."""
import serial, struct, time

PORT = '/dev/ttyUSB0'
ser = serial.Serial(PORT, 115200, timeout=1.0, parity='N', stopbits=1, bytesize=8)
time.sleep(0.1)

def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1: crc = (crc >> 1) ^ 0xA001
            else: crc >>= 1
    return crc

def read_regs(slave, start, count):
    pdu = struct.pack('>BBHH', slave, 0x03, start, count)
    c = crc16(pdu)
    req = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(req)
    time.sleep(0.15)
    resp = ser.read(512)
    if resp and len(resp) >= 3 and resp[1] == 0x03:
        bc = resp[2]
        return resp[3:3+bc]
    elif resp and (resp[1] & 0x80):
        print(f'  EXCEPTION at 0x{start:04X}: code=0x{resp[2]:02X}')
    return None

# Read 115 registers from 0x1200
print('=== Live data area (0x1200, 115 registers) ===')
data = read_regs(1, 0x1200, 115)
if data:
    print(f'Got {len(data)} bytes ({len(data)//2} registers)')
    for i in range(0, len(data), 2):
        val = data[i]*256 + data[i+1] if i+1 < len(data) else 0
        reg_num = i // 2
        abs_reg = 0x1200 + reg_num
        print(f'  reg[{reg_num:3d}] abs=0x{abs_reg:04X} offset=0x{i:04X} = {val:6d} (0x{val:04X})')

# Also check: does register offset model work for known fields?
print('\n=== Spot-check register offset model ===')
# PDF says total voltage at offset 0x0090 (UINT32 = 2 registers)
# If register offset: reg 0x1290, count 2
tdata = read_regs(1, 0x1290, 2)
if tdata and len(tdata) >= 4:
    val32 = struct.unpack('>I', tdata[:4])[0]
    print(f'  0x1290 (total_V reg-offset): {val32} mV = {val32/1000:.3f} V')

# PDF says current at offset 0x0098 (INT32 = 2 registers)
cdata = read_regs(1, 0x1298, 2)
if cdata and len(cdata) >= 4:
    val32 = struct.unpack('>i', cdata[:4])[0]
    print(f'  0x1298 (current reg-offset): {val32} mA = {val32/1000:.3f} A')

# PDF says SOC at offset 0x00A6 low byte
sdata = read_regs(1, 0x12A6, 1)
if sdata and len(sdata) >= 2:
    print(f'  0x12A6 (balance+SOC reg-offset): high={sdata[0]} low={sdata[1]} -> SOC={sdata[1]}%')

# Check 16 cells = registers 0x1200..0x120F (each cell = 1 register in register-offset model)
# But wait, cell 0 is at offset 0x0000, cell 1 at offset 0x0002
# If register offsets: cell 0 = reg 0x1200, cell 1 = reg 0x1202
# That means cells are NOT contiguous registers!
# Let's check: 16 cells from reg[0]..reg[15] in the dump above
# vs specific register reads for cells
print('\n=== Verify cell addressing ===')
# Read cell 0 from reg 0x1200
c0 = read_regs(1, 0x1200, 1)
if c0: print(f'  Cell 0 (reg 0x1200): {c0[0]*256+c0[1]} mV')
# Read cell 1 from reg 0x1201 (if consecutive registers)
c1a = read_regs(1, 0x1201, 1)
if c1a: print(f'  Cell 1? (reg 0x1201): {c1a[0]*256+c1a[1]} mV')
# Read cell 1 from reg 0x1202 (if register offsets = PDF offsets)
c1b = read_regs(1, 0x1202, 1)
if c1b: print(f'  Cell 1? (reg 0x1202): {c1b[0]*256+c1b[1]} mV')

ser.close()
print('\nDone.')
