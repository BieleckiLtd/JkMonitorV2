#!/usr/bin/env python3
"""UART loopback test - bridge GPIO14 to GPIO15 first!"""
import serial, time
s = serial.Serial('/dev/ttyAMA0', 9600, timeout=1)
msg = b'LOOPBACK_OK_12345'
s.write(msg)
s.flush()
time.sleep(0.1)
got = s.read(len(msg) + 10)
s.close()
if got == msg:
    print('PASS: Loopback received: %s' % got)
    print('UART hardware is working correctly.')
else:
    print('FAIL: Sent %d bytes, got %d bytes' % (len(msg), len(got)))
    if got:
        print('  Received: %s' % got)
    else:
        print('  Received: nothing')
    print('  Check: Is GPIO14 physically connected to GPIO15?')
