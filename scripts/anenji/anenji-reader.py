#!/usr/bin/env python3
"""
Anenji ANJ-HHS-11000W-48V Inverter - Full Register/Data Reader

This inverter is a Voltronic Power derivative. It uses the PI30 text protocol
over RS232 at 2400 baud (8N1). The protocol sends ASCII commands with a
CRC16-XMODEM checksum.

Alternatively, some models support Modbus RTU at 9600 baud.
This script tries both.

Usage: python3 anenji-reader.py [--port /dev/ttyAMA0] [--baud 2400] [--protocol auto|pi30|modbus]
"""
import serial, struct, time, sys, json, argparse
from datetime import datetime

# ── CRC routines ─────────────────────────────────────────

def crc_xmodem(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021 if crc & 0x8000 else crc << 1) & 0xFFFF
    return crc

def crc_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc

# ── PI30 Protocol ────────────────────────────────────────

def pi30_send(ser, cmd: str, timeout: float = 2.0) -> bytes:
    """Send a PI30 command, return raw response bytes (including CRC and \\r)."""
    payload = cmd.encode('ascii')
    crc = crc_xmodem(payload)
    frame = payload + struct.pack('>H', crc) + b'\r'
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    time.sleep(timeout)
    return ser.read(4096)

def pi30_decode(resp: bytes) -> str:
    """Strip leading '(' and trailing CRC+CR from PI30 response, return text."""
    if not resp or len(resp) < 4:
        return ''
    text = resp.decode('latin-1', errors='replace')
    # Response format: (data<CRC_HI><CRC_LO>\r
    if text.startswith('('):
        text = text[1:]
    # Remove last 3 chars (2 CRC bytes + \r)
    if len(text) >= 3:
        text = text[:-3]
    return text

def pi30_query(ser, cmd: str, timeout: float = 1.0) -> str:
    """Send PI30 command, return decoded text or empty string."""
    resp = pi30_send(ser, cmd, timeout)
    if resp:
        return pi30_decode(resp)
    return ''

# ── PI30 Response Parsers ────────────────────────────────

def parse_qpi(data: str) -> dict:
    """Protocol ID (e.g. 'PI30')"""
    return {'protocol_id': data.strip()}

def parse_qid(data: str) -> dict:
    """Serial number"""
    return {'serial_number': data.strip()}

def parse_qvfw(data: str) -> dict:
    """Firmware version"""
    return {'firmware_version': data.strip()}

def parse_qmod(data: str) -> dict:
    """Operating mode"""
    modes = {
        'P': 'Power on', 'S': 'Standby', 'L': 'Line/Grid',
        'B': 'Battery/Off-grid', 'F': 'Fault', 'H': 'Power saving', 'Y': 'Bypass'
    }
    mode_char = data.strip()
    return {'mode': modes.get(mode_char, f'Unknown ({mode_char})')}

def parse_qpiri(data: str) -> dict:
    """Current settings / rating info."""
    parts = data.split()
    if len(parts) < 21:
        return {'raw': data}

    out_source = {'0': 'Utility first', '1': 'Solar first', '2': 'SBU'}
    charger_source = {'0': 'Utility first', '1': 'Solar first', '2': 'Solar+Utility', '3': 'Solar only'}
    input_range = {'0': 'Appliance', '1': 'UPS'}
    machine_type = {'00': 'Grid tie', '01': 'Off Grid', '10': 'Hybrid'}
    topology = {'0': 'Transformerless', '1': 'Transformer'}
    output_mode = {'0': 'Single', '1': 'Parallel', '2': 'Phase1/3', '3': 'Phase2/3', '4': 'Phase3/3'}

    result = {
        'ac_input_voltage': float(parts[0]),
        'ac_input_current': float(parts[1]),
        'ac_output_voltage': float(parts[2]),
        'ac_output_frequency': float(parts[3]),
        'ac_output_current': float(parts[4]),
        'ac_output_apparent_power_va': int(parts[5]),
        'ac_output_active_power_w': int(parts[6]),
        'battery_voltage': float(parts[7]),
        'battery_recharge_voltage': float(parts[8]),
        'battery_under_voltage': float(parts[9]),
        'battery_bulk_charge_voltage': float(parts[10]),
        'battery_float_charge_voltage': float(parts[11]),
        'battery_type': parts[12],
        'max_ac_charging_current_a': int(parts[13]),
        'max_charging_current_a': int(parts[14]),
        'input_voltage_range': input_range.get(parts[15], parts[15]),
        'output_source_priority': out_source.get(parts[16], parts[16]),
        'charger_source_priority': charger_source.get(parts[17], parts[17]),
        'max_parallel_units': int(parts[18]),
        'machine_type': machine_type.get(parts[19], parts[19]),
        'topology': topology.get(parts[20], parts[20]),
    }
    if len(parts) > 21:
        result['output_mode'] = output_mode.get(parts[21], parts[21])
    if len(parts) > 22:
        result['battery_redischarge_voltage'] = float(parts[22])
    return result

def parse_qpigs(data: str) -> dict:
    """General status parameters - the main live data query."""
    parts = data.split()
    if len(parts) < 17:
        return {'raw': data}

    result = {
        'grid_voltage': float(parts[0]),
        'grid_frequency': float(parts[1]),
        'output_voltage': float(parts[2]),
        'output_frequency': float(parts[3]),
        'output_apparent_power_va': int(parts[4]),
        'output_active_power_w': int(parts[5]),
        'output_load_percent': int(parts[6]),
        'bus_voltage': int(parts[7]),
        'battery_voltage': float(parts[8]),
        'battery_charging_current_a': int(parts[9]),
        'battery_capacity_percent': int(parts[10]),
        'inverter_heatsink_temp_c': int(parts[11]),
        'pv_input_current_a': float(parts[12]),
        'pv_input_voltage': float(parts[13]),
        'battery_voltage_from_scc': float(parts[14]),
        'battery_discharge_current_a': int(parts[15]),
    }
    if len(parts) > 16:
        flags = parts[16]
        result['status_flags'] = {
            'sbu_priority': bool(int(flags[0])) if len(flags) > 0 else None,
            'config_changed': bool(int(flags[1])) if len(flags) > 1 else None,
            'scc_firmware_updated': bool(int(flags[2])) if len(flags) > 2 else None,
            'load_on': bool(int(flags[3])) if len(flags) > 3 else None,
            'battery_steady_charging': bool(int(flags[4])) if len(flags) > 4 else None,
            'charging_on': bool(int(flags[5])) if len(flags) > 5 else None,
            'scc_charging': bool(int(flags[6])) if len(flags) > 6 else None,
            'ac_charging': bool(int(flags[7])) if len(flags) > 7 else None,
        }
    if len(parts) > 19:
        result['pv_input_power_w'] = int(parts[19])
    return result

def parse_qflag(data: str) -> dict:
    """Flag status (enabled/disabled features)."""
    flags_info = {
        'a': 'buzzer', 'b': 'overload_bypass', 'j': 'power_saving',
        'k': 'lcd_reset_default', 'u': 'overload_restart',
        'v': 'overtemp_restart', 'x': 'lcd_backlight',
        'y': 'primary_source_alarm', 'z': 'fault_code_record'
    }
    result = {}
    enabled = True
    for ch in data.strip():
        if ch == 'E':
            enabled = True
        elif ch == 'D':
            enabled = False
        elif ch in flags_info:
            result[flags_info[ch]] = 'enabled' if enabled else 'disabled'
    return result

def parse_qdi(data: str) -> dict:
    """Default settings."""
    return {'raw_defaults': data}

def parse_qpiws(data: str) -> dict:
    """Warning status flags."""
    warnings = [
        '', 'inverter_fault', 'bus_over', 'bus_under', 'bus_soft_fail',
        'line_fail', 'opv_short', 'inv_voltage_low', 'inv_voltage_high',
        'overtemp', 'fan_locked', 'battery_voltage_high', 'battery_low_alarm',
        '', 'battery_under_shutdown', '', 'overload', 'eeprom_fault',
        'inv_overcurrent', 'inv_soft_fail', 'self_test_fail', 'op_dc_over',
        'battery_open', 'current_sensor_fail', 'battery_short', 'power_limit',
        'pv_voltage_high', 'mppt_overload_fault', 'mppt_overload_warning',
        'battery_too_low_to_charge'
    ]
    result = {}
    for i, ch in enumerate(data.strip()):
        if i < len(warnings) and warnings[i] and ch == '1':
            result[warnings[i]] = True
    return result

# ── Modbus RTU helpers ───────────────────────────────────

def modbus_read(ser, slave, func, start_reg, count):
    """Send Modbus read request, return data bytes or None."""
    pdu = struct.pack('>BBHH', slave, func, start_reg, count)
    crc = crc_modbus(pdu)
    frame = pdu + struct.pack('<H', crc)
    ser.reset_input_buffer()
    ser.write(frame)
    ser.flush()
    time.sleep(0.3)
    resp = ser.read(5 + count * 2)
    if resp and len(resp) >= 5 and resp[1] == func:
        bc = resp[2]
        return resp[3:3+bc]
    return None

# ── Modbus register map for Voltronic/EASUN-style inverters ──
# Common register addresses (based on known EASUN/Voltronic Modbus maps)
MODBUS_INPUT_REGS = {
    # Input registers (FC 0x04) - live data
    0x0000: ('grid_voltage', 0.1, 'V'),
    0x0001: ('grid_frequency', 0.01, 'Hz'),
    0x0002: ('output_voltage', 0.1, 'V'),
    0x0003: ('output_frequency', 0.01, 'Hz'),
    0x0004: ('output_apparent_power', 1, 'VA'),
    0x0005: ('output_active_power', 1, 'W'),
    0x0006: ('output_load_percent', 1, '%'),
    0x0007: ('bus_voltage', 1, 'V'),
    0x0008: ('battery_voltage', 0.1, 'V'),
    0x0009: ('battery_charging_current', 1, 'A'),
    0x000A: ('battery_capacity', 1, '%'),
    0x000B: ('heatsink_temperature', 1, '°C'),
    0x000C: ('pv_input_current', 0.1, 'A'),
    0x000D: ('pv_input_voltage', 0.1, 'V'),
    0x000E: ('battery_voltage_scc', 0.1, 'V'),
    0x000F: ('battery_discharge_current', 1, 'A'),
    0x0010: ('device_status', 1, ''),
    0x0013: ('pv_input_power', 1, 'W'),
}

MODBUS_HOLDING_REGS = {
    # Holding registers (FC 0x03) - configuration
    0x0000: ('output_source_priority', 1, ''),
    0x0001: ('charger_source_priority', 1, ''),
    0x0002: ('max_charging_current', 1, 'A'),
    0x0003: ('max_ac_charging_current', 1, 'A'),
    0x0004: ('battery_type', 1, ''),
    0x0005: ('input_voltage_range', 1, ''),
    0x0006: ('output_voltage_setting', 0.1, 'V'),
    0x0007: ('battery_recharge_voltage', 0.1, 'V'),
    0x0008: ('battery_redischarge_voltage', 0.1, 'V'),
    0x0009: ('battery_under_voltage', 0.1, 'V'),
    0x000A: ('battery_bulk_voltage', 0.1, 'V'),
    0x000B: ('battery_float_voltage', 0.1, 'V'),
}

# ── Main reader ──────────────────────────────────────────

def read_pi30(port, baud):
    """Read all data using PI30 protocol."""
    print(f'\n{"="*60}')
    print(f'PI30 PROTOCOL READER - {port} @ {baud} baud')
    print(f'{"="*60}')

    ser = serial.Serial(port, baud, timeout=2.0, bytesize=8,
                        parity='N', stopbits=1, rtscts=False, dsrdtr=False)
    time.sleep(0.1)

    all_data = {}
    queries = [
        ('QPI',   'Protocol ID',       parse_qpi),
        ('QID',   'Serial Number',      parse_qid),
        ('QVFW',  'Firmware Version',   parse_qvfw),
        ('QMOD',  'Operating Mode',     parse_qmod),
        ('QPIRI', 'Settings/Rating',    parse_qpiri),
        ('QPIGS', 'Live Status',        parse_qpigs),
        ('QFLAG', 'Feature Flags',      parse_qflag),
        ('QPIWS', 'Warnings',           parse_qpiws),
        ('QDI',   'Default Settings',   parse_qdi),
    ]

    success_count = 0
    for cmd, label, parser in queries:
        raw = pi30_query(ser, cmd, timeout=1.0 if baud > 2400 else 1.5)
        if raw:
            success_count += 1
            parsed = parser(raw)
            all_data[cmd] = parsed
            print(f'\n--- {label} [{cmd}] ---')
            if isinstance(parsed, dict):
                for k, v in parsed.items():
                    if isinstance(v, dict):
                        for k2, v2 in v.items():
                            print(f'  {k2}: {v2}')
                    else:
                        print(f'  {k}: {v}')
            else:
                print(f'  {parsed}')
        else:
            print(f'\n--- {label} [{cmd}] --- no response')
        time.sleep(0.2)

    # Try parallel status queries if available
    for i in range(3):
        raw = pi30_query(ser, f'QPGS{i}', timeout=1.5)
        if raw and 'NAK' not in raw:
            print(f'\n--- Parallel Unit {i} [QPGS{i}] ---')
            print(f'  {raw}')
            all_data[f'QPGS{i}'] = raw
        time.sleep(0.1)

    # Try Q1 extended query
    raw = pi30_query(ser, 'Q1', timeout=1.5)
    if raw and 'NAK' not in raw:
        print(f'\n--- Extended Status [Q1] ---')
        print(f'  {raw}')
        all_data['Q1'] = raw

    ser.close()

    print(f'\n{"="*60}')
    print(f'PI30 Summary: {success_count}/{len(queries)} queries responded')
    print(f'Timestamp: {datetime.now().isoformat()}')

    return all_data

def read_modbus(port, baud, slave=1):
    """Read all data using Modbus RTU."""
    print(f'\n{"="*60}')
    print(f'MODBUS RTU READER - {port} @ {baud} baud, slave={slave}')
    print(f'{"="*60}')

    ser = serial.Serial(port, baud, timeout=1.0, bytesize=8,
                        parity='N', stopbits=1, rtscts=False, dsrdtr=False)
    time.sleep(0.1)

    all_data = {}

    # Try input registers (FC 0x04) - live data
    print('\n--- Input Registers (Live Data) ---')
    data = modbus_read(ser, slave, 0x04, 0x0000, 20)
    if data and len(data) >= 2:
        for reg_addr, (name, scale, unit) in MODBUS_INPUT_REGS.items():
            offset = reg_addr * 2
            if offset + 1 < len(data):
                raw = struct.unpack('>H', data[offset:offset+2])[0]
                val = raw * scale
                print(f'  {name}: {val:.1f} {unit}' if scale != 1 else f'  {name}: {val:.0f} {unit}')
                all_data[name] = val
    else:
        # Try FC 0x03 instead
        print('  No input registers, trying holding registers for live data...')
        data = modbus_read(ser, slave, 0x03, 0x0000, 20)
        if data:
            print(f'  Got {len(data)} bytes from holding registers')
            for i in range(0, min(len(data), 40), 2):
                val = struct.unpack('>H', data[i:i+2])[0]
                print(f'  reg[{i//2}] = {val}')

    # Try holding registers (FC 0x03) - configuration
    print('\n--- Holding Registers (Configuration) ---')
    cfg_data = modbus_read(ser, slave, 0x03, 0x0000, 12)
    if cfg_data:
        for reg_addr, (name, scale, unit) in MODBUS_HOLDING_REGS.items():
            offset = reg_addr * 2
            if offset + 1 < len(cfg_data):
                raw = struct.unpack('>H', cfg_data[offset:offset+2])[0]
                val = raw * scale
                print(f'  {name}: {val:.1f} {unit}' if scale != 1 else f'  {name}: {val:.0f} {unit}')
                all_data[name] = val

    # Scan for responsive register ranges
    print('\n--- Register Range Scan ---')
    for func, fname in [(0x03, 'holding'), (0x04, 'input')]:
        for base in range(0, 0x200, 0x10):
            d = modbus_read(ser, slave, func, base, 1)
            if d and len(d) >= 2:
                val = struct.unpack('>H', d[:2])[0]
                print(f'  {fname} 0x{base:04X}: {val} (0x{val:04X})')

    ser.close()
    return all_data

def auto_detect(port):
    """Try to auto-detect the protocol."""
    print('Auto-detecting protocol...')

    # Try PI30 at 2400 baud first (most common)
    for baud in [2400, 9600]:
        try:
            ser = serial.Serial(port, baud, timeout=2.0)
            resp = pi30_send(ser, 'QPI', timeout=1.5)
            ser.close()
            if resp and len(resp) > 3:
                text = resp.decode('latin-1', errors='replace')
                if 'PI' in text:
                    print(f'  Detected PI30 protocol at {baud} baud')
                    return 'pi30', baud
                else:
                    print(f'  Got response at {baud} baud (PI30): {text[:40]}')
                    return 'pi30', baud
        except:
            pass

    # Try Modbus RTU
    for baud in [9600, 2400, 19200]:
        try:
            ser = serial.Serial(port, baud, timeout=1.0)
            for slave in [1, 2]:
                for func in [0x03, 0x04]:
                    frame = struct.pack('>BBHH', slave, func, 0, 1)
                    c = crc_modbus(frame)
                    frame = frame + struct.pack('<H', c)
                    ser.reset_input_buffer()
                    ser.write(frame)
                    ser.flush()
                    time.sleep(0.3)
                    resp = ser.read(64)
                    if resp and len(resp) >= 5:
                        print(f'  Detected Modbus RTU at {baud} baud, slave={slave}')
                        ser.close()
                        return 'modbus', baud
            ser.close()
        except:
            pass

    print('  No protocol detected. Check physical connection.')
    return None, None

# ── Entry point ──────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Anenji inverter data reader')
    parser.add_argument('--port', default='/dev/ttyAMA0', help='Serial port')
    parser.add_argument('--baud', type=int, default=0, help='Baud rate (0=auto)')
    parser.add_argument('--protocol', choices=['auto', 'pi30', 'modbus'], default='auto')
    parser.add_argument('--slave', type=int, default=1, help='Modbus slave address')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    args = parser.parse_args()

    proto = args.protocol
    baud = args.baud

    if proto == 'auto' or baud == 0:
        detected_proto, detected_baud = auto_detect(args.port)
        if detected_proto is None:
            sys.exit(1)
        if proto == 'auto':
            proto = detected_proto
        if baud == 0:
            baud = detected_baud

    if proto == 'pi30':
        data = read_pi30(args.port, baud)
    else:
        data = read_modbus(args.port, baud, args.slave)

    if args.json and data:
        print(json.dumps(data, indent=2, default=str))

if __name__ == '__main__':
    main()
