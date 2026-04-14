#!/usr/bin/env python3
"""
Comprehensive Anenji inverter connection tester.
Tests UART hardware, then tries PI30 and Modbus protocols.
"""
import serial, struct, time, subprocess, sys, os

PORT = '/dev/ttyAMA0'

def crc_xmodem(data: bytes) -> int:
    """CRC-16/XMODEM for Voltronic PI protocol."""
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1) & 0xFFFF
    return crc

def crc_modbus(data: bytes) -> int:
    """CRC-16/Modbus."""
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

def pi_frame(cmd: str) -> bytes:
    payload = cmd.encode('ascii')
    crc = crc_xmodem(payload)
    return payload + struct.pack('>H', crc) + b'\r'

def modbus_frame(slave, func, start, count):
    pdu = struct.pack('>BBHH', slave, func, start, count)
    c = crc_modbus(pdu)
    return pdu + struct.pack('<H', c)

def get_tty_stats():
    try:
        r = subprocess.run(['sudo', 'cat', '/proc/tty/driver/ttyAMA'],
                           capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if line.lstrip().startswith('0:'):
                return line.strip()
    except:
        pass
    return None

# ── 1. Hardware status ──
print('='*60)
print('ANENJI INVERTER CONNECTION TESTER')
print('='*60)
print(f'\nPort: {PORT}')

stats = get_tty_stats()
if stats:
    print(f'UART stats: {stats}')
else:
    print('UART stats: could not read (run as root?)')

# Check pin config
try:
    r = subprocess.run(['pinctrl', 'get', '14'], capture_output=True, text=True, timeout=5)
    print(f'GPIO14 (TX): {r.stdout.strip()}')
    r = subprocess.run(['pinctrl', 'get', '15'], capture_output=True, text=True, timeout=5)
    print(f'GPIO15 (RX): {r.stdout.strip()}')
except:
    print('Could not read pinctrl')

# ── 2. Protocol tests ──
BAUDS = [2400, 9600, 4800, 19200, 115200]
PI_CMDS = ['QPI', 'QPIGS', 'QPIRI', 'QMOD', 'QID', 'QVFW']
PARITIES = [('N', serial.PARITY_NONE), ('E', serial.PARITY_EVEN), ('O', serial.PARITY_ODD)]

found = False

for baud in BAUDS:
    for pname, pval in PARITIES:
        if found:
            break
        tag = f'{baud}:{pname}'

        try:
            ser = serial.Serial(PORT, baud, timeout=2.0, bytesize=8,
                                parity=pval, stopbits=1,
                                rtscts=False, dsrdtr=False, xonxoff=False)
        except Exception as e:
            print(f'  [{tag}] Cannot open: {e}')
            continue

        time.sleep(0.05)

        # Try PI30 protocol
        for cmd in PI_CMDS:
            frame = pi_frame(cmd)
            ser.reset_input_buffer()
            ser.write(frame)
            ser.flush()
            time.sleep(0.6 if baud <= 2400 else 0.3)
            resp = ser.read(1024)
            if resp:
                print(f'\n*** RESPONSE at {tag} PI30 [{cmd}] ***')
                print(f'  Raw ({len(resp)}B): {resp[:60].hex(" ")}')
                try:
                    text = resp.decode('latin-1')
                    print(f'  Text: {text[:120]}')
                except:
                    pass
                found = True
                break

        if not found:
            # Try Modbus RTU
            for slave in [1, 2, 0]:
                for base in [0x0000, 0x0001, 0x0100, 0x1000]:
                    for func in [0x03, 0x04]:  # holding / input registers
                        frame = modbus_frame(slave, func, base, 1)
                        ser.reset_input_buffer()
                        ser.write(frame)
                        ser.flush()
                        time.sleep(0.3 if baud >= 9600 else 0.6)
                        resp = ser.read(256)
                        if resp:
                            print(f'\n*** RESPONSE at {tag} Modbus FC=0x{func:02X} slave={slave} reg=0x{base:04X} ***')
                            print(f'  Raw ({len(resp)}B): {resp.hex(" ")}')
                            found = True
                            break
                    if found:
                        break
                if found:
                    break

        ser.close()

    if found:
        break

# ── 3. Final status ──
print('\n' + '='*60)
stats2 = get_tty_stats()
if stats2:
    print(f'UART stats after test: {stats2}')

if not found:
    print("""
NO RESPONSE RECEIVED from the inverter.

PHYSICAL CONNECTION CHECKLIST:
1. RS232 cable: Inverter TX → MAX3232 R1IN, MAX3232 R1OUT → Pi GPIO15 (RXD, pin 10)
              : Pi GPIO14 (TXD, pin 8) → MAX3232 T1IN, MAX3232 T1OUT → Inverter RX
              : Inverter GND ↔ MAX3232 GND ↔ Pi GND (pin 6)
2. MAX3232 power: VCC = 3.3V from Pi (pin 1 or 17), GND from Pi
3. The RS232 cable between inverter and MAX3232 may need TX↔RX crossover (null modem)
4. Verify which port on the inverter is the monitoring/datalogger port
   (it might be labeled COM, RS232, DATA, or be the same port the WiFi stick uses)

QUICK LOOPBACK TEST:
   Temporarily disconnect the inverter cable and connect GPIO14 (pin 8) to
   GPIO15 (pin 10) on the Pi header. Then run:
   python3 -c "import serial,time; s=serial.Serial('/dev/ttyAMA0',9600,timeout=1); s.write(b'HELLO'); time.sleep(0.1); print(s.read(10))"
   If you see b'HELLO' back, the UART works and the issue is the cable/inverter.

AFTER REBOOT:
   The UART0 overlay has been made persistent in /boot/firmware/config.txt.
   Reboot once for persistent UART: sudo reboot
""")
else:
    print('SUCCESS - Response received! Protocol identified.')
    print('Run the full reader script next.')
