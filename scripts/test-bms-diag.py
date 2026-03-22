#!/usr/bin/env python3
"""Comprehensive JK BMS RS485 connectivity diagnostic."""
import serial
import time
import binascii
import sys

PORT = "/dev/ttyUSB0"
TIMEOUT = 2

def build_rs485_request(address):
    """Build a JK RS485 read-all request."""
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

def listen_passive(ser, duration):
    """Listen passively for any data the BMS might broadcast."""
    print(f"Passive listen for {duration}s...")
    start = time.time()
    all_data = b""
    while time.time() - start < duration:
        avail = ser.in_waiting
        if avail > 0:
            data = ser.read(avail)
            all_data += data
        time.sleep(0.1)
    if all_data:
        print(f"  Received {len(all_data)} bytes: {binascii.hexlify(all_data[:100]).decode()}{'...' if len(all_data) > 100 else ''}")
    else:
        print("  No data received.")
    return all_data

def test_baud(baud):
    """Test multiple addresses at a given baud rate."""
    print(f"\n=== Testing baud rate {baud} ===")
    try:
        ser = serial.Serial(PORT, baud, timeout=TIMEOUT)
        ser.reset_input_buffer()
        ser.reset_output_buffer()
        time.sleep(0.2)

        # First, passive listen
        data = listen_passive(ser, 3)
        if data:
            return True

        # Try multiple addresses
        for addr in range(0, 5):
            req = build_rs485_request(addr)
            print(f"  Address 0x{addr:02X}: tx={binascii.hexlify(req).decode()}")
            ser.reset_input_buffer()
            ser.write(req)
            time.sleep(1)
            avail = ser.in_waiting
            if avail > 0:
                resp = ser.read(min(avail, 512))
                print(f"    RX ({len(resp)} bytes): {binascii.hexlify(resp).decode()}")
                ser.close()
                return True
            else:
                print(f"    No response")
            time.sleep(0.2)

        ser.close()
    except Exception as e:
        print(f"  Error: {e}")
    return False

# Check USB adapter info
import subprocess
result = subprocess.run(["ls", "-la", "/dev/ttyUSB0"], capture_output=True, text=True)
print(f"Port: {result.stdout.strip()}")
result = subprocess.run(["udevadm", "info", "-a", "-n", "/dev/ttyUSB0"], capture_output=True, text=True)
for line in result.stdout.split("\n"):
    if any(k in line.lower() for k in ["product", "manufacturer", "serial", "idvendor", "idproduct"]):
        print(f"  {line.strip()}")

# Test common baud rates
for baud in [115200, 9600]:
    if test_baud(baud):
        print(f"\n*** Got data at {baud} baud! ***")
        sys.exit(0)

print("\nNo response at any baud rate or address.")
print("Check: 1) RS485 A/B wiring  2) BMS RS485 enabled  3) USB adapter TX/RX")
sys.exit(1)
