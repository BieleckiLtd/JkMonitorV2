#!/usr/bin/env python3
"""Compare bulk config read with targeted reads to verify register address mapping."""
import serial, struct, time

def crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

def read_regs(ser, addr, start_reg, count, label):
    pdu = struct.pack(">BBHH", addr, 0x03, start_reg, count)
    crc = crc16(pdu)
    frame = pdu + struct.pack("<H", crc)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    time.sleep(0.3)
    resp = ser.read(512)
    if len(resp) >= 5 and resp[1] == 0x03:
        data = resp[3:3+resp[2]]
        print(f"{label}: {len(data)} data bytes")
        return data
    elif len(resp) >= 3 and (resp[1] & 0x80):
        print(f"{label}: EXCEPTION 0x{resp[2]:02X}")
    else:
        print(f"{label}: unexpected response ({len(resp)} bytes)")
    return None

ser = serial.Serial("/dev/ttyUSB0", 115200, timeout=2)
ADDR = 1

# Known register definitions with byte offsets and expected values from health API
regs = [
    (0x00, "smartSleepVoltage", 3500),
    (0x04, "cellUvp", 2950),
    (0x08, "cellUvpRecovery", 3100),
    (0x0C, "cellOvp", 3650),
    (0x10, "cellOvpRecovery", 3400),
    (0x14, "balanceTriggerVoltage", 50),
    (0x18, "soc100Voltage", 3430),
    (0x1C, "soc0Voltage", 3000),
    (0x20, "cellChargeRequestVoltage", 3450),
    (0x24, "cellFloatVoltage", 3350),
    (0x28, "powerOffVoltage", 2490),
    (0x2C, "maxChargeCurrent", 200000),
    (0x30, "chargeOcpDelay", 3),
    (0x34, "chargeOcpRecoveryDelay", 60),
    (0x38, "maxDischargeCurrent", 200000),
    (0x3C, "dischargeOcpDelay", 300),
    (0x40, "dischargeOcpRecoveryDelay", 60),
    (0x44, "scpRecoveryTime", 30),
    (0x48, "maxBalanceCurrent", 2000),
    (0x4C, "chargeOtp", 700),
    (0x50, "chargeOtpRecovery", 600),
    (0x54, "dischargeOtp", 500),
    (0x58, "dischargeOtpRecovery", 300),
    (0x5C, "chargeUtp", 50),
    (0x60, "chargeUtpRecovery", 70),
    (0x64, "mosOtp", 800),
    (0x68, "mosOtpRecovery", 700),
    (0x6C, "cellCount", 16),
    (0x70, "chargeSwitch", 1),
    (0x74, "dischargeSwitch", 1),
    (0x78, "balancerSwitch", 1),
    (0x7C, "nominalBatteryCapacity", 280000),
    (0x80, "scpDelay", 5),
    (0x84, "startBalanceVoltage", 3420),
]

# 1. Bulk read all config registers
print("=== BULK READ (115 regs from 0x1000) ===")
bulk_data = read_regs(ser, ADDR, 0x1000, 115, "Bulk")
time.sleep(0.3)

if bulk_data:
    print("\n=== REGISTER MAPPING CHECK ===")
    print(f"{'Name':<30} {'ByteOff':>7} {'RegAddr':>7} {'BulkVal':>10} {'Expected':>10} {'Match':>6}")
    print("-" * 80)
    
    mismatches = []
    for byte_off, name, expected in regs:
        if byte_off + 4 <= len(bulk_data):
            raw = struct.unpack(">I", bulk_data[byte_off:byte_off+4])[0]
            reg_addr = 0x1000 + byte_off // 2
            match = "OK" if raw == expected else "MISMATCH"
            if raw != expected:
                mismatches.append((name, byte_off, reg_addr, raw, expected))
            print(f"{name:<30} 0x{byte_off:04X} 0x{reg_addr:04X} {raw:>10} {expected:>10} {match:>6}")

# 2. Targeted reads for a few values to compare
print("\n=== TARGETED READS (direct register access) ===")
time.sleep(0.3)
for byte_off, name, expected in [(0x78, "balancerSwitch", 1), (0x3C, "dischargeOcpDelay", 300), (0x00, "smartSleepVoltage", 3500), (0x6C, "cellCount", 16)]:
    reg_addr = 0x1000 + byte_off // 2
    data = read_regs(ser, ADDR, reg_addr, 2, f"Read 0x{reg_addr:04X} ({name})")
    time.sleep(0.3)
    if data and len(data) >= 4:
        val = struct.unpack(">I", data[0:4])[0]
        bulk_val = struct.unpack(">I", bulk_data[byte_off:byte_off+4])[0] if bulk_data else "?"
        print(f"  Targeted={val}, Bulk@byte{byte_off}={bulk_val}, Expected={expected}")

ser.close()
print("\nDone.")
