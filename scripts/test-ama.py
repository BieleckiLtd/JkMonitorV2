#!/usr/bin/env python3
"""Test ttyAMA10 (GPIO UART) for JK BMS data."""
import serial
import time
import binascii

for port in ["/dev/ttyAMA10"]:
    for baud in [115200, 9600]:
        print(f"Testing {port} at {baud} baud...")
        try:
            ser = serial.Serial(port, baud, timeout=2)
            ser.reset_input_buffer()
            time.sleep(3)
            avail = ser.in_waiting
            if avail > 0:
                data = ser.read(min(avail, 512))
                print(f"  Got {len(data)} bytes: {binascii.hexlify(data[:100]).decode()}")
            else:
                print("  No passive data")
            ser.close()
        except Exception as e:
            print(f"  Error: {e}")
print("Done")
