#!/usr/bin/env python3
"""Quick JK BMS RS485 connectivity test."""
import serial
import time
import binascii
import struct
import sys

PORT = "/dev/ttyUSB0"
BAUD = 115200
TIMEOUT = 2

def build_request(address):
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

try:
    ser = serial.Serial(PORT, BAUD, timeout=TIMEOUT)
    ser.reset_input_buffer()
    ser.reset_output_buffer()
    
    for addr in [0x00, 0x01]:
        req = build_request(addr)
        print(f"Trying address 0x{addr:02X}: request = {binascii.hexlify(req).decode()}")
        ser.write(req)
        time.sleep(1)
        avail = ser.in_waiting
        print(f"  Bytes available: {avail}")
        if avail > 0:
            data = ser.read(min(avail, 512))
            print(f"  Response ({len(data)} bytes): {binascii.hexlify(data).decode()}")
            if len(data) > 10 and data[0] == 0x4E and data[1] == 0x57:
                print(f"  Valid JK frame header detected!")
        else:
            print(f"  No response")
        ser.reset_input_buffer()
        time.sleep(0.5)
    
    ser.close()
    print("Done.")
except Exception as e:
    print(f"Error: {e}", file=sys.stderr)
    sys.exit(1)
