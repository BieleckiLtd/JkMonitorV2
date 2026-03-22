#!/usr/bin/env python3
"""Test JK BMS over UART protocol (different from RS485 protocol)."""
import serial
import time
import binascii
import sys

PORT = "/dev/ttyUSB0"
TIMEOUT = 2

def build_uart_cell_info_request():
    """JK UART protocol: request cell info (command 0x96)."""
    frame = bytearray(20)
    frame[0] = 0xAA
    frame[1] = 0x55
    frame[2] = 0x90
    frame[3] = 0xEB
    frame[4] = 0x96  # cell info command
    frame[19] = 0x00
    # Compute checksum: sum of bytes 0..18 & 0xFF
    frame[19] = sum(frame[:19]) & 0xFF
    return bytes(frame)

def build_uart_device_info_request():
    """JK UART protocol: request device info (command 0x97)."""
    frame = bytearray(20)
    frame[0] = 0xAA
    frame[1] = 0x55
    frame[2] = 0x90
    frame[3] = 0xEB
    frame[4] = 0x97  # device info command
    frame[19] = sum(frame[:19]) & 0xFF
    return bytes(frame)

def try_request(ser, name, req):
    """Send request and read response."""
    print(f"  {name}: tx={binascii.hexlify(req).decode()}")
    ser.reset_input_buffer()
    ser.write(req)
    time.sleep(1.5)
    avail = ser.in_waiting
    if avail > 0:
        resp = ser.read(min(avail, 512))
        print(f"    RX ({len(resp)} bytes): {binascii.hexlify(resp[:100]).decode()}{'...' if len(resp) > 100 else ''}")
        return True
    else:
        print(f"    No response")
        return False

print("=== JK BMS UART Protocol Test ===")
print(f"Port: {PORT}")

for baud in [115200, 9600]:
    print(f"\nBaud {baud}:")
    try:
        ser = serial.Serial(PORT, baud, timeout=TIMEOUT)
        ser.reset_input_buffer()
        time.sleep(0.3)

        # Passive listen first
        print("  Passive listen 3s...")
        start = time.time()
        all_data = b""
        while time.time() - start < 3:
            avail = ser.in_waiting
            if avail > 0:
                all_data += ser.read(avail)
            time.sleep(0.1)
        if all_data:
            print(f"    Got {len(all_data)} bytes: {binascii.hexlify(all_data[:100]).decode()}")
            ser.close()
            print("*** BMS is sending data! ***")
            sys.exit(0)
        else:
            print("    Nothing passive")

        # Try UART commands
        if try_request(ser, "Cell info (0x96)", build_uart_cell_info_request()):
            ser.close()
            sys.exit(0)
        if try_request(ser, "Device info (0x97)", build_uart_device_info_request()):
            ser.close()
            sys.exit(0)

        ser.close()
    except Exception as e:
        print(f"  Error: {e}")

print("\nNo response on UART protocol either.")
sys.exit(1)
