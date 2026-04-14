#!/usr/bin/env python3
"""
Anenji inverter - exhaustive physical layer diagnostics.
Run as: sudo python3 anenji-physical-diag.py

Tests:
1. UART loopback self-test (temporarily short GPIO14→GPIO15)
2. Try all UARTs (ttyAMA0, ttyS0)
3. Try with hardware flow control
4. Passive sniff for any data from inverter
5. Long listen for slow/periodic data
"""
import serial, struct, time, subprocess, sys, os

def crc_xmodem(data):
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1) & 0xFFFF
    return crc

def crc_modbus(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

def pi_frame(cmd):
    payload = cmd.encode('ascii')
    crc = crc_xmodem(payload)
    return payload + struct.pack('>H', crc) + b'\r'

def modbus_frame(slave, func, start, count):
    pdu = struct.pack('>BBHH', slave, func, start, count)
    c = crc_modbus(pdu)
    return pdu + struct.pack('<H', c)

def try_port(port, baud, parity='N', rtscts=False, label=''):
    tag = '%s@%d/%s%s' % (port, baud, parity, '+RTS/CTS' if rtscts else '')
    try:
        ser = serial.Serial(port, baud, timeout=2, bytesize=8,
                            parity=parity, stopbits=1,
                            rtscts=rtscts, dsrdtr=False)
    except Exception as e:
        print('  [%s] Cannot open: %s' % (tag, e))
        return False

    time.sleep(0.05)

    # PI30 at this baud
    for cmd in ['QPI', 'QPIGS', 'Q1']:
        frame = pi_frame(cmd)
        ser.reset_input_buffer()
        ser.write(frame)
        ser.flush()
        time.sleep(1.0 if baud <= 2400 else 0.5)
        resp = ser.read(1024)
        if resp:
            print('  [%s] PI30 %s -> %d bytes: %s' % (tag, cmd, len(resp), resp[:40].hex(' ')))
            try:
                print('    Text: %s' % resp.decode('latin-1', errors='replace')[:80])
            except:
                pass
            ser.close()
            return True

    # Modbus
    for slave in [1, 0]:
        for func in [0x03, 0x04]:
            for base in [0x0000, 0x0001]:
                frame = modbus_frame(slave, func, base, 1)
                ser.reset_input_buffer()
                ser.write(frame)
                ser.flush()
                time.sleep(0.5 if baud <= 2400 else 0.3)
                resp = ser.read(256)
                if resp:
                    print('  [%s] Modbus s=%d FC=0x%02X reg=0x%04X -> %d bytes: %s' %
                          (tag, slave, func, base, len(resp), resp[:20].hex(' ')))
                    ser.close()
                    return True

    ser.close()
    return False

# ═══════════════════════════════════════
print('=' * 60)
print('PHYSICAL LAYER DIAGNOSTICS')
print('=' * 60)

# ── 1. List available ports ──
print('\n--- Available serial ports ---')
ports_found = []
for port in ['/dev/ttyAMA0', '/dev/ttyAMA10', '/dev/ttyS0',
             '/dev/ttyUSB0', '/dev/ttyUSB1', '/dev/ttyACM0', '/dev/serial0']:
    exists = os.path.exists(port)
    if exists:
        real = os.path.realpath(port)
        symlink = ' -> %s' % real if real != port else ''
        print('  %s%s EXISTS' % (port, symlink))
        if port not in ['/dev/serial0']:  # skip symlinks
            ports_found.append(port)
    # else skip silently

# ── 2. GPIO pin status ──
print('\n--- GPIO pin status ---')
for pin in [14, 15, 16, 17, 0, 1, 2, 3, 4, 5]:
    try:
        r = subprocess.run(['pinctrl', 'get', str(pin)],
                           capture_output=True, text=True, timeout=3)
        line = r.stdout.strip()
        if 'TX' in line or 'RX' in line or 'UART' in line.upper() or 'TXD' in line or 'RXD' in line:
            print('  GPIO%d: %s' % (pin, line))
    except:
        pass

# ── 3. Try ttyAMA0 with various configs ──
print('\n--- Protocol sweep on ttyAMA0 ---')
found = False
for baud in [2400, 9600, 4800, 19200, 115200]:
    for parity in ['N', 'E', 'O']:
        for rtscts in [False, True]:
            if try_port('/dev/ttyAMA0', baud, parity, rtscts):
                found = True
                break
        if found:
            break
    if found:
        break

# ── 4. Try ttyS0 if available ──
if not found and '/dev/ttyS0' in ports_found:
    print('\n--- Protocol sweep on ttyS0 ---')
    for baud in [2400, 9600]:
        for parity in ['N']:
            if try_port('/dev/ttyS0', baud, parity):
                found = True
                break
        if found:
            break

# ── 5. Passive listen on ttyAMA0 ──
if not found:
    print('\n--- Passive listen (5 seconds each baud) ---')
    print('  Listening for any spontaneous data from inverter...')
    for baud in [2400, 9600, 19200, 115200]:
        try:
            ser = serial.Serial('/dev/ttyAMA0', baud, timeout=5)
            data = ser.read(256)
            ser.close()
            if data:
                print('  %d baud: %d bytes: %s' % (baud, len(data), data.hex(' ')))
                found = True
                break
            else:
                print('  %d baud: silence' % baud)
        except:
            pass

# ── 6. UART counter report ──
print('\n--- UART counters ---')
try:
    r = subprocess.run(['cat', '/proc/tty/driver/ttyAMA'],
                       capture_output=True, text=True, timeout=3)
    for line in r.stdout.splitlines():
        print('  %s' % line.strip())
except:
    pass
try:
    r = subprocess.run(['cat', '/proc/tty/driver/serial'],
                       capture_output=True, text=True, timeout=3)
    for line in r.stdout.splitlines():
        print('  %s' % line.strip())
except:
    pass

print('\n' + '=' * 60)
if not found:
    print("""
DIAGNOSIS: No response from inverter on any port/baud/parity.
The Pi UART transmits fine (TX counter increases) but RX = 0.

MOST LIKELY CAUSE: Physical wiring issue.

STEP 1 — LOOPBACK TEST (verify Pi UART hardware works):
  Disconnect the MAX3232 cable. Use a jumper wire to connect
  GPIO14 (pin 8, TXD) directly to GPIO15 (pin 10, RXD).
  Then run:
    python3 -c "
import serial, time
s = serial.Serial('/dev/ttyAMA0', 9600, timeout=1)
s.write(b'loopback_test')
time.sleep(0.1)
d = s.read(20)
print('Loopback result:', d)
s.close()
"
  If you see b'loopback_test' → UART hardware is fine.

STEP 2 — CHECK MAX3232 WIRING:
  Pi side (3.3V TTL):
    GPIO14 (pin 8)  → MAX3232 T1IN  (TTL input)
    GPIO15 (pin 10) ← MAX3232 R1OUT (TTL output)
    3.3V (pin 1)    → MAX3232 VCC
    GND (pin 6)     → MAX3232 GND

  Inverter side (RS232 ±12V):
    MAX3232 T1OUT   → Inverter RX (pin 2 on DB9, or as labeled)
    MAX3232 R1IN    ← Inverter TX (pin 3 on DB9, or as labeled)
    MAX3232 GND     ↔ Inverter GND (pin 5 on DB9)

  NOTE: Some inverters use RJ45 or custom connectors. Check the
  inverter manual for the EXACT pinout of the communication port.

STEP 3 — TX/RX CROSSOVER:
  If using a straight-through cable, the inverter TX goes to
  the other device TX — which is WRONG. You need a null modem
  crossover (pin 2 ↔ pin 3 on RS232 side).

STEP 4 — CHECK THE RIGHT PORT:
  The Anenji inverter may have multiple ports:
  - RS232 DB9 (for monitoring)
  - RJ45/RJ11 (for WiFi dongle / data logger)
  - USB (for direct PC connection)
  Make sure you're connected to the RS232 monitoring port,
  NOT the WiFi dongle port (which may use a different protocol).

STEP 5 — INVERTER RS232 ENABLE:
  Some inverters have RS232 communication disabled by default
  in their menu. Check the inverter LCD menu for a "Communication"
  or "RS232" setting and ensure it's enabled.
""")
else:
    print('SUCCESS! Response received from inverter.')
