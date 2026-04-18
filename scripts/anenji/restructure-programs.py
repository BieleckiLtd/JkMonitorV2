#!/usr/bin/env python3
"""Restructure anenji-inverter-rs232.json:
- Number every setting with its manual program number (F0P01, F1P01, F2P01 etc.)
- Merge F2 Charger + F3 Battery → F2 Battery
- Add F0P10 Modbus address (reg 686) and F0P16 Dry contact mode (reg 690)
- Add F3 Time entities (regs 696-701)
- Add F4 Reset placeholder (no register known)
- Extend settings data source count 89 → 90 to cover reg 690
"""
import json, sys, os

path = os.path.join(os.path.dirname(__file__), '..', '..', 'devices', 'anenji-inverter-rs232.json')
with open(path, 'r', encoding='utf-8') as f:
    doc = json.load(f)

# ---------- 1. Extend settings data source to cover reg 690 ----------
for ds in doc['dataSources']:
    if ds['id'] == 'settings':
        ds['count'] = 90
        ds['_comment'] = 'Regs 601-690: all user-configurable settings (output/charge priority, voltages, currents, mode toggles, Modbus address, dry contact)'
        break

# ---------- 2. Entity name/category mappings ----------
# Map entity id → (new_name, new_category, optional _comment override)
rename_map = {
    # F0 System
    'input_mode':               ('F0P01 AC Input Voltage Range',        'F0 System', None),
    'energy_saving_mode':       ('F0P03 Power Saving Mode',             'F0 System', None),
    'overload_transfer_bypass': ('F0P04 Overload Transfer to Bypass',   'F0 System', None),
    'overload_auto_restart':    ('F0P05 Overload Auto Restart',         'F0 System', None),
    'over_temp_auto_restart':   ('F0P06 Over-temperature Auto Restart', 'F0 System', None),
    'lcd_auto_return':          ('F0P07 LCD Auto Return',               'F0 System', None),
    'lcd_backlight':            ('F0P08 LCD Backlight',                  'F0 System', None),
    'buzzer_mode':              ('F0P09 Buzzer Mode',                    'F0 System', None),
    'remote_switch':            ('Remote Switch',                        'F0 System', None),
    # F1 Output
    'output_priority':          ('F1P01 Output Source Priority',         'F1 Output', None),
    'output_voltage_setting':   ('F1P03 Output Voltage',                 'F1 Output', None),
    'output_frequency_setting': ('F1P04 Output Frequency',               'F1 Output', None),
    # F2 Battery (merged charger + battery)
    'battery_type':             ('F2P01 Battery Type',                   'F2 Battery', None),
    'charge_priority':          ('F2P02 Charge Source Priority',         'F2 Battery', None),
    'battery_ovp':              ('F2P03 Battery OVP',                    'F2 Battery', None),
    'max_charge_voltage':       ('F2P04 Bulk Charge Voltage',            'F2 Battery', None),
    'float_charge_voltage':     ('F2P05 Float Charge Voltage',           'F2 Battery', None),
    'constant_to_float_wait':   ('F2P06 Constant-to-Float Wait Time',   'F2 Battery', None),
    'max_charge_current':       ('F2P07 Max Charging Current',           'F2 Battery', None),
    'max_mains_charge_current': ('F2P08 Max Mains Charging Current',     'F2 Battery', None),
    'max_discharge_current':    ('F2P09 Max Discharge Current',          'F2 Battery', None),
    'mains_discharge_recovery_v': ('F2P10 Mains Discharge Recovery Voltage', 'F2 Battery', None),
    'mains_low_voltage_v':      ('F2P11 Mains Low Voltage Protection',   'F2 Battery', None),
    'offgrid_low_voltage_v':    ('F2P12 Off-grid Low Voltage Protection', 'F2 Battery', None),
    'low_dc_protection_soc':    ('F2P13 Low DC Protection SOC',          'F2 Battery', None),
    'low_dc_recovery_soc':      ('F2P14 Low DC Recovery SOC',            'F2 Battery', None),
    'offgrid_soc_protection':   ('F2P15 Off-grid Low DC SOC Protection', 'F2 Battery', None),
    'battery_cutoff_soc':       ('F2P16 Battery Low Cut-off SOC',        'F2 Battery', None),
    'eq_charge_voltage':        ('F2P17 Equalization Voltage',           'F2 Battery', None),
    'eq_time':                  ('F2P18 Equalization Time',              'F2 Battery', None),
    'eq_timeout':               ('F2P19 Equalization Timeout',           'F2 Battery', None),
    'eq_interval':              ('F2P20 Equalization Interval',          'F2 Battery', None),
}

# Apply renames
for ent in doc['entities']:
    eid = ent['id']
    if eid in rename_map:
        new_name, new_cat, new_comment = rename_map[eid]
        ent['name'] = new_name
        ent['category'] = new_cat
        if new_comment:
            ent['_comment'] = new_comment

# ---------- 3. Add new entities ----------

# F0P10 Modbus Address (reg 686, settings bank, byteOffset = (686-601)*2 = 170)
modbus_address_entity = {
    "id": "modbus_address",
    "type": "number",
    "name": "F0P10 Modbus Address",
    "category": "F0 System",
    "source": {
        "bank": "settings",
        "byteOffset": 170,
        "dataType": "uint16"
    },
    "display": {
        "precision": 0
    },
    "writable": True,
    "write": {
        "address": 686
    }
}

# F0P16 Dry Contact Mode (reg 690, settings bank, byteOffset = (690-601)*2 = 178)
dry_contact_entity = {
    "id": "dry_contact_mode",
    "type": "number",
    "name": "F0P16 Dry Contact Mode",
    "category": "F0 System",
    "source": {
        "bank": "settings",
        "byteOffset": 178,
        "dataType": "uint16"
    },
    "display": {
        "precision": 0
    },
    "writable": True,
    "write": {
        "address": 690
    }
}

# F3 Time entities (regs 696-701 in info_fw, addr 691)
time_entities = [
    {
        "id": "clock_year",
        "type": "sensor",
        "name": "F3P00 Year",
        "category": "F3 Time",
        "source": {
            "bank": "info_fw",
            "byteOffset": 10,
            "dataType": "uint16"
        },
        "display": {"precision": 0}
    },
    {
        "id": "clock_month",
        "type": "sensor",
        "name": "F3P01 Month",
        "category": "F3 Time",
        "source": {
            "bank": "info_fw",
            "byteOffset": 12,
            "dataType": "uint16"
        },
        "display": {"precision": 0}
    },
    {
        "id": "clock_day",
        "type": "sensor",
        "name": "F3P02 Day",
        "category": "F3 Time",
        "source": {
            "bank": "info_fw",
            "byteOffset": 14,
            "dataType": "uint16"
        },
        "display": {"precision": 0}
    },
    {
        "id": "clock_hour",
        "type": "sensor",
        "name": "F3P03 Hour",
        "category": "F3 Time",
        "source": {
            "bank": "info_fw",
            "byteOffset": 16,
            "dataType": "uint16"
        },
        "display": {"precision": 0}
    },
    {
        "id": "clock_minute",
        "type": "sensor",
        "name": "F3P04 Minute",
        "category": "F3 Time",
        "source": {
            "bank": "info_fw",
            "byteOffset": 18,
            "dataType": "uint16"
        },
        "display": {"precision": 0}
    },
    {
        "id": "clock_second",
        "type": "sensor",
        "name": "F3P05 Second",
        "category": "F3 Time",
        "source": {
            "bank": "info_fw",
            "byteOffset": 20,
            "dataType": "uint16"
        },
        "display": {"precision": 0}
    }
]

# ---------- 4. Insert new entities at correct positions ----------

# Find insertion points
entities = doc['entities']

# Insert modbus_address and dry_contact_mode after the last F0 System entity
last_f0_idx = -1
for i, ent in enumerate(entities):
    if ent.get('category') == 'F0 System':
        last_f0_idx = i
# Insert dry_contact after last F0, then modbus_address before it
if last_f0_idx >= 0:
    entities.insert(last_f0_idx + 1, dry_contact_entity)
    entities.insert(last_f0_idx + 1, modbus_address_entity)

# Insert time entities before Device Info entities
first_info_idx = -1
for i, ent in enumerate(entities):
    if ent.get('category') == 'Device Info':
        first_info_idx = i
        break
if first_info_idx >= 0:
    for j, tent in enumerate(time_entities):
        entities.insert(first_info_idx + j, tent)

# ---------- 5. Reorder entities within each category by program number ----------
# Define the desired order by entity id
desired_order = [
    # Live data (unchanged order)
    'operating_mode', 'mains_frequency', 'grid_power_alt', 'ac_charging_power',
    'pv_power', 'pv_charging_power', 'load_percent', 'output_frequency',
    'inv_temperature',
    'battery_voltage', 'battery_current', 'battery_power', 'state_of_charge', 'dc_temperature',
    'pv_temperature',
    'grid_voltage', 'grid_power', 'output_voltage', 'output_current',
    'output_active_power', 'output_apparent_power',
    # F0 System (by program number)
    'input_mode',               # F0P01
    'energy_saving_mode',       # F0P03
    'overload_transfer_bypass', # F0P04
    'overload_auto_restart',    # F0P05
    'over_temp_auto_restart',   # F0P06
    'lcd_auto_return',          # F0P07
    'lcd_backlight',            # F0P08
    'buzzer_mode',              # F0P09
    'modbus_address',           # F0P10
    'dry_contact_mode',         # F0P16
    'remote_switch',            # no program number
    # F1 Output (by program number)
    'output_priority',          # F1P01
    'output_voltage_setting',   # F1P03
    'output_frequency_setting', # F1P04
    # Status
    'current_output_priority',
    'current_charge_priority',
    # F2 Battery (by program number)
    'battery_type',             # F2P01
    'charge_priority',          # F2P02
    'battery_ovp',              # F2P03
    'max_charge_voltage',       # F2P04
    'float_charge_voltage',     # F2P05
    'constant_to_float_wait',   # F2P06
    'max_charge_current',       # F2P07
    'max_mains_charge_current', # F2P08
    'max_discharge_current',    # F2P09
    'mains_discharge_recovery_v', # F2P10
    'mains_low_voltage_v',      # F2P11
    'offgrid_low_voltage_v',    # F2P12
    'low_dc_protection_soc',    # F2P13
    'low_dc_recovery_soc',      # F2P14
    'offgrid_soc_protection',   # F2P15
    'battery_cutoff_soc',       # F2P16
    'eq_charge_voltage',        # F2P17
    'eq_time',                  # F2P18
    'eq_timeout',               # F2P19
    'eq_interval',              # F2P20
    # BMS
    'charge_request_voltage',
    # F3 Time
    'clock_year',   # F3P00
    'clock_month',  # F3P01
    'clock_day',    # F3P02
    'clock_hour',   # F3P03
    'clock_minute', # F3P04
    'clock_second', # F3P05
    # Device Info
    'equipment_type',
    'serial_number',
    'rated_power',
    'firmware_version',
]

# Build a sort key from desired_order
order_map = {eid: i for i, eid in enumerate(desired_order)}

def sort_key(ent):
    eid = ent['id']
    if eid in order_map:
        return order_map[eid]
    # Entities not in the list go to the end
    return 9999

doc['entities'] = sorted(doc['entities'], key=sort_key)

# ---------- 6. Update section _comments ----------
for ent in doc['entities']:
    eid = ent['id']
    if eid == 'input_mode':
        ent['_comment'] = '=== F0 SYSTEM — Manual Setting F0 ==='
    elif eid == 'output_priority':
        ent['_comment'] = '=== F1 OUTPUT — Manual Setting F1 ==='
    elif eid == 'current_output_priority':
        ent['_comment'] = '=== STATUS — Read-only active priority mirrors ==='
    elif eid == 'battery_type':
        ent['_comment'] = '=== F2 BATTERY — Manual Setting F2 ==='
    elif eid == 'charge_request_voltage':
        ent['_comment'] = '=== BMS DATA — Battery management system live values (addr 971) ==='
    elif eid == 'clock_year':
        ent['_comment'] = '=== F3 TIME — Manual Setting F3 ==='
    elif eid == 'equipment_type':
        ent['_comment'] = '=== INFO_ID — Device Identity (addr 171) ==='
    elif eid == 'rated_power':
        ent['_comment'] = '=== INFO_FW — Firmware (addr 691) ==='
    else:
        # Clear old section comments that are no longer accurate
        if '_comment' in ent and '===' in ent.get('_comment', ''):
            del ent['_comment']

# ---------- 7. Validate ----------
entity_ids = [e['id'] for e in doc['entities']]
assert len(entity_ids) == len(set(entity_ids)), f"Duplicate entity IDs: {[x for x in entity_ids if entity_ids.count(x) > 1]}"

# Check all entities in desired_order exist
for eid in desired_order:
    assert eid in entity_ids, f"Entity {eid} in desired_order but not in entities"

# Check no F3 Battery or F2 Charger categories remain
cats = set(e.get('category', '') for e in doc['entities'])
assert 'F3 Battery' not in cats, "F3 Battery category still exists"
assert 'F2 Charger' not in cats, "F2 Charger category still exists"

print(f"Total entities: {len(doc['entities'])}")
print(f"Categories: {sorted(cats)}")

# Print entity order for verification
for i, ent in enumerate(doc['entities']):
    print(f"  {i+1:2d}. [{ent.get('category',''):15s}] {ent['id']:35s} → {ent['name']}")

# Write
with open(path, 'w', encoding='utf-8') as f:
    json.dump(doc, f, indent=2, ensure_ascii=False)
    f.write('\n')

print(f"\nWrote {path}")
