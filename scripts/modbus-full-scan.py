#!/usr/bin/env python3
"""Discover all register areas from JK Inverter BMS: config (0x1000), live (0x1200), device info (0x1400)."""
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
    time.sleep(0.2)
    resp = ser.read(1024)
    if resp and len(resp) >= 3 and resp[1] == 0x03:
        bc = resp[2]
        return resp[3:3+bc]
    elif resp and (resp[1] & 0x80):
        print(f'  EXCEPTION at 0x{start:04X} cnt={count}: code=0x{resp[2]:02X}')
    else:
        print(f'  No response at 0x{start:04X} cnt={count}')
    return None

def find_max_read(slave, base, max_try=125):
    """Find max readable register count from base."""
    lo, hi = 1, max_try
    best = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        data = read_regs(slave, base, mid)
        if data is not None:
            best = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return best

# =========================================================
# AREA 1: Config registers at 0x1000 (R/W per PDF)
# =========================================================
print('=== CONFIG AREA 0x1000 ===')
max_cfg = find_max_read(1, 0x1000)
print(f'Max readable registers from 0x1000: {max_cfg}')

if max_cfg > 0:
    # Read in chunks of up to max_cfg
    all_cfg = bytearray()
    offset = 0
    while offset < max_cfg:
        chunk = min(max_cfg - offset, 115)
        data = read_regs(1, 0x1000 + offset, chunk)
        if data:
            all_cfg.extend(data)
        else:
            break
        offset += chunk

    print(f'\nConfig data: {len(all_cfg)} bytes ({len(all_cfg)//2} registers)')
    for i in range(0, len(all_cfg), 2):
        val = all_cfg[i]*256 + all_cfg[i+1] if i+1 < len(all_cfg) else 0
        reg = 0x1000 + i // 2
        # Try to identify known config registers from PDF
        label = ''
        byte_off = i
        if byte_off == 0: label = 'Cell OVP (mV) [UINT32 hi]'
        elif byte_off == 2: label = 'Cell OVP (mV) [UINT32 lo]'
        elif byte_off == 4: label = 'Cell OVP Recovery (mV) [hi]'
        elif byte_off == 6: label = 'Cell OVP Recovery (mV) [lo]'
        elif byte_off == 8: label = 'Cell OVP Delay (s) [hi]'
        elif byte_off == 10: label = 'Cell OVP Delay (s) [lo]'
        elif byte_off == 12: label = 'Cell UVP (mV) [hi]'
        elif byte_off == 14: label = 'Cell UVP (mV) [lo]'
        elif byte_off == 16: label = 'Cell UVP Recovery (mV) [hi]'
        elif byte_off == 18: label = 'Cell UVP Recovery (mV) [lo]'
        elif byte_off == 20: label = 'Cell UVP Delay (s) [hi]'
        elif byte_off == 22: label = 'Cell UVP Delay (s) [lo]'
        # More known offsets
        elif byte_off == 0xD8: label = 'Cell Count [hi]'
        elif byte_off == 0xDA: label = 'Cell Count [lo]'
        elif byte_off == 0xE0: label = 'Charge Enable [hi]'
        elif byte_off == 0xE2: label = 'Charge Enable [lo]'
        elif byte_off == 0xE8: label = 'Discharge Enable [hi]'
        elif byte_off == 0xEA: label = 'Discharge Enable [lo]'
        elif byte_off == 0xF0: label = 'Balance Enable [hi]'
        elif byte_off == 0xF2: label = 'Balance Enable [lo]'
        elif byte_off == 0x010C*2: label = 'DevAddr [UINT32 hi]' if byte_off < len(all_cfg) else ''

        if label:
            print(f'  reg[{i//2:3d}] 0x{reg:04X} off=0x{byte_off:04X} = {val:6d} (0x{val:04X}) {label}')
        elif val != 0:
            print(f'  reg[{i//2:3d}] 0x{reg:04X} off=0x{byte_off:04X} = {val:6d} (0x{val:04X})')

# =========================================================
# AREA 2: Device Info at 0x1400 (R per PDF)
# =========================================================
print('\n=== DEVICE INFO AREA 0x1400 ===')
max_info = find_max_read(1, 0x1400)
print(f'Max readable registers from 0x1400: {max_info}')

if max_info > 0:
    data = read_regs(1, 0x1400, max_info)
    if data:
        print(f'Device info data: {len(data)} bytes')
        # Try ASCII interpretation
        ascii_str = ''
        for b in data:
            if 32 <= b < 127:
                ascii_str += chr(b)
            else:
                ascii_str += '.'
        print(f'  ASCII: {ascii_str}')
        for i in range(0, len(data), 2):
            val = data[i]*256 + data[i+1]
            reg = 0x1400 + i // 2
            label = ''
            if i == 0: label = 'Manufacturer Device ID (ASCII 16 bytes start)'
            elif i == 16: label = 'Hardware Version (ASCII 8 bytes start)'
            elif i == 24: label = 'Software Version (ASCII 8 bytes start)'
            print(f'  reg[{i//2:3d}] 0x{reg:04X} = {val:6d} (0x{val:04X}) chars="{chr(data[i]) if 32<=data[i]<127 else "."}{chr(data[i+1]) if 32<=data[i+1]<127 else "."}" {label}')

# =========================================================
# AREA 3: Full config dump (need to know exact register count)
# =========================================================
print('\n=== FULL CONFIG REGISTER MAP (non-zero values) ===')
# PDF says config at 0x1000 with UINT32 values at 4-byte boundaries
# Let's read what we can in chunks of 115
all_data = bytearray()
base = 0x1000
total_regs = max_cfg
for start_off in range(0, total_regs, 115):
    chunk = min(115, total_regs - start_off)
    d = read_regs(1, base + start_off, chunk)
    if d:
        all_data.extend(d)
    else:
        break

# Print UINT32 values (2 registers each)
print(f'Total config: {len(all_data)} bytes = {len(all_data)//4} UINT32 values')
for i in range(0, len(all_data)-3, 4):
    val32 = struct.unpack('>I', all_data[i:i+4])[0]
    reg_off = i // 2  # register offset from base
    if val32 != 0:
        print(f'  offset=0x{i:04X} reg_off={reg_off:3d} regs=0x{base+reg_off:04X}..0x{base+reg_off+1:04X} = {val32:10d} (0x{val32:08X})')

# =========================================================
# AREA 4: Test write capability with 0x10 (Write Multiple Registers)
# =========================================================
print('\n=== WRITE TEST (0x10) ===')
# Read current device address at config offset 0x0108 (register 0x1084)
addr_data = read_regs(1, 0x1084, 2)
if addr_data and len(addr_data) >= 4:
    dev_addr = struct.unpack('>I', addr_data[:4])[0]
    print(f'Current device address: {dev_addr}')

# Test write function code 0x10 support (write same value back)
# We'll write a known read-only-safe value back to test function code support
# Actually, let's test with function code 0x06 (write single register) on a safe reg
print('Testing function 0x06 (Write Single Register) support...')
# Read register 0x1000 first
test_data = read_regs(1, 0x1000, 2)
if test_data and len(test_data) >= 4:
    orig_val = struct.unpack('>I', test_data[:4])[0]
    print(f'  Register 0x1000+0x1001 current UINT32 value: {orig_val}')
    # Try writing same value back with 0x10 (Write Multiple Registers)
    # Frame: [addr][0x10][start_hi][start_lo][count_hi][count_lo][byte_count][data...][crc]
    pdu = struct.pack('>BBHHB', 1, 0x10, 0x1000, 2, 4) + test_data[:4]
    c = crc16(pdu)
    req = pdu + struct.pack('<H', c)
    ser.reset_input_buffer()
    ser.write(req)
    time.sleep(0.3)
    resp = ser.read(512)
    if resp:
        if resp[1] == 0x10:
            print(f'  Write 0x10 SUPPORTED! Response: {resp.hex()}')
        elif resp[1] & 0x80:
            print(f'  Write 0x10 EXCEPTION: func=0x{resp[1]:02X} code=0x{resp[2]:02X}')
        else:
            print(f'  Write 0x10 unknown response: {resp.hex()}')
    else:
        print('  Write 0x10 no response')

    # Also test 0x06
    pdu06 = struct.pack('>BBHH', 1, 0x06, 0x1000, test_data[0]*256+test_data[1])
    c06 = crc16(pdu06)
    req06 = pdu06 + struct.pack('<H', c06)
    ser.reset_input_buffer()
    ser.write(req06)
    time.sleep(0.3)
    resp06 = ser.read(512)
    if resp06:
        if resp06[1] == 0x06:
            print(f'  Write 0x06 SUPPORTED! Response: {resp06.hex()}')
        elif resp06[1] & 0x80:
            print(f'  Write 0x06 EXCEPTION: func=0x{resp06[1]:02X} code=0x{resp06[2]:02X}')
        else:
            print(f'  Write 0x06 unknown response: {resp06.hex()}')
    else:
        print('  Write 0x06 no response')

ser.close()
print('\nDone.')
