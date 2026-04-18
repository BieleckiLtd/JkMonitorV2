"""Restructure anenji-inverter-rs232.json:
- Remove ZEC mode from output_priority
- Add BMS data source and charge_request_voltage entity
- Reorganize settings categories to F0-F4 matching manual
- Reorder settings entities to match manual program order
- Add charge_request_voltage to timeSeries and charts
"""
import json, sys, os

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'devices', 'anenji-inverter-rs232.json')
with open(path, encoding='utf-8') as f:
    d = json.load(f)

# === 1. Add BMS data source ===
bms_ds = {
    "_comment": "Regs 971-986: BMS communication data (charge request V, discharge cutoff V, current limits)",
    "id": "bms_data",
    "name": "BMS Data",
    "address": 971,
    "count": 16,
    "functionCode": 3,
    "pollGroup": "fast"
}
# Insert after the last existing data source
d["dataSources"].append(bms_ds)

# === 2. Entity modifications ===
ents = d["entities"]

# Build a lookup by id
by_id = {e["id"]: e for e in ents}

# Remove ZEC from output_priority options
op = by_id["output_priority"]
op["options"] = [o for o in op["options"] if o["value"] != 4]

# Remove ZEC from current_output_priority options  
cop = by_id["current_output_priority"]
cop["options"] = [o for o in cop["options"] if o["value"] != 4]

# === 3. Category renames and name updates ===
f0_system = {
    "input_mode": 1,
    "energy_saving_mode": 2,
    "overload_transfer_bypass": 3,
    "overload_auto_restart": 4,
    "over_temp_auto_restart": 5,
    "buzzer_mode": 6,
    "remote_switch": 7,
    "lcd_auto_return": 8,
    "lcd_backlight": 9,
}

f1_output = {
    "output_priority": 1,
    "output_voltage_setting": 3,
    "output_frequency_setting": 4,
}

f2_charger = {
    "charge_priority": 1,
    "battery_type": 2,
    "max_charge_voltage": 3,
    "float_charge_voltage": 4,
}

f3_battery = {
    "battery_ovp": 1,
    "max_charge_current": 2,
    "max_mains_charge_current": 3,
    "max_discharge_current": 4,
    "constant_to_float_wait": 5,
    "mains_discharge_recovery_v": 6,
    "mains_low_voltage_v": 7,
    "offgrid_low_voltage_v": 8,
    "low_dc_protection_soc": 9,
    "low_dc_recovery_soc": 10,
    "offgrid_soc_protection": 11,
    "battery_cutoff_soc": 12,
    "eq_charge_voltage": 13,
    "eq_time": 14,
    "eq_timeout": 15,
    "eq_interval": 16,
}

for eid, order in f0_system.items():
    by_id[eid]["category"] = "F0 System"
    by_id[eid]["_sort"] = (30, order)

for eid, order in f1_output.items():
    by_id[eid]["category"] = "F1 Output"
    by_id[eid]["_sort"] = (40, order)

for eid, order in f2_charger.items():
    by_id[eid]["category"] = "F2 Charger"
    by_id[eid]["_sort"] = (60, order)

for eid, order in f3_battery.items():
    by_id[eid]["category"] = "F3 Battery"
    by_id[eid]["_sort"] = (70, order)

# Status entities (read-only priority mirrors)
by_id["current_output_priority"]["_sort"] = (50, 1)
by_id["current_charge_priority"]["_sort"] = (50, 2)

# Rename max_charge_voltage to Bulk Charge Voltage
by_id["max_charge_voltage"]["name"] = "Bulk Charge Voltage"

# Add _comment markers for sections
by_id["input_mode"]["_comment"] = "=== F0 SYSTEM — Manual Setting F0, programs 01-09 ==="
by_id["output_priority"]["_comment"] = "=== F1 OUTPUT — Manual Setting F1, programs 01-04 ==="
by_id["current_output_priority"]["_comment"] = "=== STATUS — Read-only active priority mirrors ==="
by_id["charge_priority"]["_comment"] = "=== F2 CHARGER — Manual Setting F2, programs 01-04 ==="
by_id["battery_ovp"]["_comment"] = "=== F3 BATTERY — Manual Setting F3 ==="

# === 4. Add charge_request_voltage entity ===
charge_rv = {
    "_comment": "=== BMS DATA — Battery management system live values (addr 971) ===",
    "id": "charge_request_voltage",
    "type": "sensor",
    "name": "Charge Request Voltage",
    "category": "Battery",
    "icon": "battery",
    "source": {
        "bank": "bms_data",
        "byteOffset": 0,
        "dataType": "uint16",
        "scale": 0.1,
        "unit": "V"
    },
    "display": {"precision": 1},
    "_sort": (80, 1)
}
ents.append(charge_rv)

# === 5. Reorder entities ===
# Live entities: keep in current order (they don't have _sort)
# Settings/status entities: sort by _sort tuple
# Info entities: keep at end

live_ids = {"operating_mode", "mains_frequency", "grid_power_alt", "ac_charging_power",
            "pv_power", "pv_charging_power", "load_percent", "output_frequency",
            "inv_temperature", "battery_voltage", "battery_current", "battery_power",
            "state_of_charge", "dc_temperature", "pv_temperature",
            "grid_voltage", "grid_power", "output_voltage", "output_current",
            "output_active_power", "output_apparent_power"}
info_ids = {"equipment_type", "serial_number", "rated_power", "firmware_version"}

live_ents = [e for e in ents if e["id"] in live_ids]
info_ents = [e for e in ents if e["id"] in info_ids]
settings_ents = [e for e in ents if e["id"] not in live_ids and e["id"] not in info_ids]

# Sort settings by _sort key
settings_ents.sort(key=lambda e: e.get("_sort", (99, 99)))

# Remove _sort keys
for e in settings_ents:
    e.pop("_sort", None)
charge_rv.pop("_sort", None)

# Also clean up any old _comment markers that are now wrong
for e in settings_ents:
    if e.get("_comment", "").startswith("=== SETTINGS"):
        del e["_comment"]

# Reassemble
d["entities"] = live_ents + settings_ents + info_ents

# === 6. Add timeSeries entry ===
ts = d["storage"]["timeSeries"]
ts.append({"entity": "charge_request_voltage", "aggregate": "avg", "column": "charge_req_voltage_v"})

# === 7. Add charge request voltage to Battery chart ===
charts = d["ui"]["pages"]["history"]["charts"]
for chart in charts:
    if chart["title"] == "Battery":
        chart["traces"].append({
            "entity": "charge_request_voltage",
            "label": "Charge Request",
            "color": "yellow",
            "dashed": True
        })
        break

# === 8. Write back ===
with open(path, 'w', encoding='utf-8') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')

print("Done. Changes applied:")
print("  - Removed ZEC from output_priority and current_output_priority")
print("  - Added BMS data source (addr 971, count 16)")
print("  - Added charge_request_voltage entity")
print("  - Reorganized categories: F0 System, F1 Output, F2 Charger, F3 Battery")
print("  - Reordered settings entities to match manual F0-F4 program order")
print("  - Added timeSeries entry for charge_request_voltage")
print("  - Added charge_request_voltage to Battery history chart")
print("  - Renamed max_charge_voltage to 'Bulk Charge Voltage'")
