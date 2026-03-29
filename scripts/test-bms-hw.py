#!/usr/bin/env python3
"""Test RS485 with RTS direction control and loopback."""
import serial
import time
import binascii
import sys

PORT = "/dev/ttyUSB0"

def build_rs485_request(address):
    frame = bytearray(21)
    frame[0] = 0x4E
    frame[1] = 0x57
    frame[2] = 0x00
    frame[3] = 0x13
    frame[8] = 0x06
    frame[9] = 0x02
    frame[10] = 0x00
    frame[11] = address
    frame[16] = 0x68
    checksum = sum(frame[:17]) & 0xFFFF
    frame[19] = (checksum >> 8) & 0xFF
    frame[20] = checksum & 0xFF
    return bytes(frame)

# Test 1: Check if kernel RS485 mode is available
print("=== RS485 ioctl mode test ===")
import fcntl, struct, array
TIOCSRS485 = 0x542F
TIOCGRS485 = 0x542E
SER_RS485_ENABLED = 0x00000001
SER_RS485_RTS_ON_SEND = 0x00000002
SER_RS485_RTS_AFTER_SEND = 0x00000004

try:
    ser = serial.Serial(PORT, 115200, timeout=2)
    fd = ser.fileno()

    # Try to read current RS485 config
    buf = array.array('i', [0] * 8)
    try:
        fcntl.ioctl(fd, TIOCGRS485, buf)
        print(f"  Current RS485 flags: 0x{buf[0]:08X}")
    except Exception as e:
        print(f"  Cannot read RS485 config: {e}")

    # Enable kernel RS485 mode with RTS control
    flags = SER_RS485_ENABLED | SER_RS485_RTS_ON_SEND
    buf = array.array('i', [flags, 0, 0, 0, 0, 0, 0, 0])
    try:
        fcntl.ioctl(fd, TIOCSRS485, buf)
        print("  Kernel RS485 mode enabled (RTS on send)")
    except Exception as e:
        print(f"  Cannot set RS485 mode: {e} (FTDI may not support kernel RS485)")

    # Try polling with kernel RS485
    req = build_rs485_request(0x01)
    ser.reset_input_buffer()
    ser.write(req)
    time.sleep(1)
    avail = ser.in_waiting
    if avail > 0:
        resp = ser.read(min(avail, 512))
        print(f"  RX (kernel RS485): {binascii.hexlify(resp[:100]).decode()}")
    else:
        print("  No response with kernel RS485")

    ser.close()
except Exception as e:
    print(f"  Error: {e}")

# Test 2: Try with manual RTS control
print("\n=== Manual RTS control test ===")
for rts_val in [True, False]:
    try:
        ser = serial.Serial(PORT, 115200, timeout=2, rtscts=False)
        ser.rts = rts_val
        ser.reset_input_buffer()
        time.sleep(0.1)

        req = build_rs485_request(0x01)
        ser.write(req)
        ser.flush()
        ser.rts = not rts_val  # flip for receive
        time.sleep(1)
        avail = ser.in_waiting
        if avail > 0:
            resp = ser.read(min(avail, 512))
            print(f"  RTS={rts_val}->{'not '+str(rts_val)}: RX ({len(resp)} bytes): {binascii.hexlify(resp[:100]).decode()}")
        else:
            print(f"  RTS={rts_val}: No response")
        ser.close()
    except Exception as e:
        print(f"  RTS={rts_val}: Error: {e}")

# Test 3: Loopback (checks if adapter itself works)
print("\n=== Loopback test (is the adapter working?) ===")
try:
    ser = serial.Serial(PORT, 115200, timeout=1)
    ser.reset_input_buffer()
    test_data = b"HELLO"
    ser.write(test_data)
    time.sleep(0.2)
    avail = ser.in_waiting
    if avail > 0:
        echo = ser.read(avail)
        print(f"  Adapter echoes (loopback detected): {echo}")
        print("  NOTE: This means TX->RX are shorted or adapter is in loopback!")
    else:
        print("  No loopback echo (normal - TX and RX are separate)")
    ser.close()
except Exception as e:
    print(f"  Error: {e}")

# Test 4: Check dmesg for USB-serial info
import subprocess
result = subprocess.run(["dmesg"], capture_output=True, text=True)
for line in result.stdout.split("\n"):
    if "ttyUSB" in line or "ftdi" in line.lower() or "usb" in line.lower() and "serial" in line.lower():
        print(f"  dmesg: {line.strip()}")
