# Device Definition Specification v1

A **device definition** is a single JSON file that completely describes a hardware device — how to connect to it, what data it exposes, how to parse register data, what alarms it can raise, how to store its telemetry, and how to lay out the UI.

The application loads one or more device definition files at startup. There is **no device-specific code** in the application itself. The JK BMS, a solar inverter, a smart meter — they are all just JSON files.

> Think of it as ESPHome (device description) + Home Assistant (runtime & UI) in one app.

---

## Design Principles

| Principle | Meaning |
|-----------|---------|
| **Device-agnostic core** | The application contains zero device-specific logic. All device knowledge lives in JSON definition files. |
| **UI-framework agnostic** | The JSON describes *what* to show (a gauge, a chart, a table) — never *how* (no React, no HTML). The app's renderer decides the implementation. |
| **Entity model** | Every data point is an *entity* with a type, source, and display metadata — inspired by Home Assistant's entity registry. |
| **Self-contained** | One JSON file per device type. Everything the app needs is in that file. |
| **Extensible** | New entity types, protocols, and UI components can be added without changing existing definitions. |

---

## File Structure

```
devices/
  jk-inverter-bms.json      # JK Inverter BMS (RS485 Modbus RTU)
  growatt-inverter.json      # Growatt Solar Inverter (future)
  eastron-sdm630.json        # Eastron Smart Meter (future)
```

The application scans a configured directory (default: `devices/`) for `*.json` files matching the device definition schema.

---

## Schema Overview

```
DeviceDefinition
├── $schema            # JSON Schema URI for validation
├── version            # Schema version ("1")
├── device             # Device metadata
├── connection         # Transport + protocol settings
│   ├── transport      # Physical layer (serial, TCP, MQTT)
│   └── protocol       # Application layer (modbus-rtu, modbus-tcp, mqtt, http)
├── registerBanks[]    # Groups of registers read together (modbus)
├── pollGroups{}       # Named polling intervals
├── entities[]         # All data points (sensors, switches, numbers, text)
├── computedEntities[] # Derived values (delta, average, power from V×I)
├── alarms             # Warning/alarm flag decoding
├── storage            # What to persist and retention policy
├── ui                 # Layout for dashboard, monitor, history pages
└── notifications      # Alert/notification rules
```

---

## Sections

### 1. `device` — Metadata

```json
{
  "device": {
    "id": "jk-inverter-bms",
    "name": "JK Inverter BMS",
    "manufacturer": "JK",
    "model": "B2A8S20P",
    "category": "energy-storage",
    "description": "JK Inverter BMS with RS485 Modbus RTU interface for LiFePO4 battery packs",
    "icon": "battery",
    "documentationUrl": "https://github.com/BieleckiLtd/JkMonitorV2"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier, used as the profile ID in app config |
| `name` | yes | Human-readable name |
| `manufacturer` | no | Device manufacturer |
| `model` | no | Model number |
| `category` | yes | Device category: `energy-storage`, `solar-inverter`, `smart-meter`, `sensor`, `controller` |
| `description` | no | Longer description |
| `icon` | no | Icon hint (Lucide icon name) |
| `documentationUrl` | no | Link to docs |

---

### 2. `connection` — Transport & Protocol

```json
{
  "connection": {
    "transport": {
      "type": "serial",
      "defaults": {
        "baudRate": 115200,
        "dataBits": 8,
        "parity": "none",
        "stopBits": 1,
        "readTimeoutMs": 1000,
        "writeTimeoutMs": 1000
      }
    },
    "protocol": {
      "type": "modbus-rtu",
      "settings": {
        "defaultSlaveAddress": 1,
        "interFrameDelayMs": 50,
        "retries": 1
      }
    }
  }
}
```

**Transport types:** `serial`, `tcp`, `mqtt`, `http`

**Protocol types:** `modbus-rtu`, `modbus-tcp`, `mqtt-json`, `http-json`, `http-rest`

Transport and protocol defaults can be overridden per-device in the application's `appsettings.json`.

---

### 3. `registerBanks[]` — Register Groups (Modbus)

A register bank is a contiguous block of registers read in a single Modbus request.

```json
{
  "registerBanks": [
    {
      "id": "live",
      "name": "Live Data",
      "address": 4608,
      "count": 115,
      "functionCode": 3,
      "pollGroup": "fast"
    },
    {
      "id": "config",
      "name": "Configuration",
      "address": 4096,
      "count": 115,
      "functionCode": 3,
      "pollGroup": "slow",
      "write": {
        "functionCode": 16,
        "registersPerWrite": 2
      }
    },
    {
      "id": "info",
      "name": "Device Information",
      "address": 5120,
      "count": 123,
      "functionCode": 3,
      "pollGroup": "slow"
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Referenced by entities |
| `name` | yes | Human label |
| `address` | yes | Start register address (decimal). `4608` = `0x1200` |
| `count` | yes | Number of registers to read |
| `functionCode` | yes | Modbus function code (3 = Read Holding Registers) |
| `pollGroup` | yes | References a poll group by name |
| `write` | no | If present, the bank supports writes |
| `write.functionCode` | yes | Modbus write function code (16 = Write Multiple Registers) |
| `write.registersPerWrite` | no | Registers per write operation (default 1) |

---

### 4. `pollGroups` — Polling Intervals

```json
{
  "pollGroups": {
    "fast": {
      "intervalMs": 1000,
      "description": "Real-time sensor data"
    },
    "slow": {
      "intervalMs": 30000,
      "description": "Configuration and device info (slow-changing)"
    }
  }
}
```

The device instance's `pollIntervalMilliseconds` in `appsettings.json` overrides the `fast` group interval. The `slow` group is always relative (e.g., 30× the fast interval).

---

### 5. `entities[]` — Data Points

Every piece of data the device exposes is an **entity**. Entity types determine how the app treats the value.

#### Entity Types

| Type | Description | Read | Write | Example |
|------|-------------|------|-------|---------|
| `sensor` | Numeric measurement | ✓ | | Voltage, current, temperature |
| `binary_sensor` | Boolean state | ✓ | | Charging enabled, battery online |
| `number` | Numeric config parameter | ✓ | ✓ | OVP threshold, max current |
| `switch` | Boolean config toggle | ✓ | ✓ | Charge switch, balance switch |
| `text` | String value | ✓ | | Serial number, firmware version |
| `cell_array` | Array of numeric values | ✓ | | Cell voltages (variable length) |

#### Entity Definition

```json
{
  "entities": [
    {
      "id": "total_voltage",
      "type": "sensor",
      "name": "Total Voltage",
      "category": "Pack Status",
      "icon": "zap",
      "source": {
        "bank": "live",
        "byteOffset": 144,
        "dataType": "uint32",
        "scale": 0.001,
        "unit": "V"
      },
      "display": {
        "precision": 2,
        "format": "number"
      },
      "role": "total-voltage"
    },
    {
      "id": "cell_voltages",
      "type": "cell_array",
      "name": "Cell Voltages",
      "category": "Cells",
      "source": {
        "bank": "live",
        "byteOffset": 0,
        "elementDataType": "uint16",
        "elementByteSize": 2,
        "maxElements": 32,
        "skipZero": true,
        "scale": 0.001,
        "unit": "V"
      },
      "display": {
        "precision": 3,
        "format": "number"
      },
      "role": "cell-voltages"
    },
    {
      "id": "cell_ovp",
      "type": "number",
      "name": "Cell OVP",
      "category": "Cell Protection",
      "source": {
        "bank": "config",
        "byteOffset": 12,
        "dataType": "uint32",
        "scale": 0.001,
        "unit": "V"
      },
      "display": {
        "precision": 3,
        "format": "number"
      },
      "writable": true
    },
    {
      "id": "charge_switch",
      "type": "switch",
      "name": "Charge Switch",
      "category": "System",
      "source": {
        "bank": "config",
        "byteOffset": 112,
        "dataType": "uint32"
      },
      "writable": true
    },
    {
      "id": "serial_number",
      "type": "text",
      "name": "Serial Number",
      "category": "Device Info",
      "source": {
        "bank": "info",
        "byteOffset": 40,
        "dataType": "ascii",
        "length": 16
      }
    }
  ]
}
```

#### Source Object

| Field | Required | Description |
|-------|----------|-------------|
| `bank` | yes | Register bank ID |
| `byteOffset` | yes | Byte offset within the bank's response data |
| `dataType` | yes | `uint16`, `uint32`, `int16`, `int32`, `uint8`, `int8`, `ascii`, `float32` |
| `scale` | no | Multiply raw value by this (e.g., 0.001 to convert mV→V) |
| `unit` | no | Unit after scaling |
| `length` | no | For `ascii` type: byte length |
| `elementDataType` | no | For `cell_array`: data type of each element |
| `elementByteSize` | no | For `cell_array`: bytes per element |
| `maxElements` | no | For `cell_array`: max array size |
| `skipZero` | no | For `cell_array`: skip elements with value 0 |
| `signed` | no | Override sign interpretation |
| `byteOrder` | no | `big-endian` (default) or `little-endian` |

#### Semantic Roles

Entities can declare a **role** that the app understands semantically. This allows the app to provide special rendering or behaviour without device-specific code.

| Role | Meaning |
|------|---------|
| `total-voltage` | Pack/system voltage |
| `current` | System current |
| `power` | System power |
| `state-of-charge` | Battery SOC percentage |
| `cell-voltages` | Array of cell voltages |
| `temperature` | A temperature reading |
| `alarm-flags` | Bitmask of alarm conditions |
| `cycle-count` | Battery charge cycles |
| `manufacturer-id` | Device manufacturer string |
| `software-version` | Firmware/software version |
| `charging-enabled` | Charge circuit state |
| `discharging-enabled` | Discharge circuit state |
| `balancing-enabled` | Balancer state |

Roles are optional. They enable smart behaviour (e.g., the app knows SOC drives a battery icon) but the app renders any entity with or without a role.

---

### 6. `computedEntities[]` — Derived Values

Computed entities derive their value from other entities at runtime.

```json
{
  "computedEntities": [
    {
      "id": "delta_cell_voltage",
      "type": "sensor",
      "name": "Cell Delta",
      "category": "Cells",
      "expression": "max(cell_voltages) - min(cell_voltages)",
      "unit": "V",
      "display": { "precision": 3 },
      "role": "delta-voltage"
    },
    {
      "id": "avg_cell_voltage",
      "type": "sensor",
      "name": "Avg Cell Voltage",
      "category": "Cells",
      "expression": "avg(cell_voltages)",
      "unit": "V",
      "display": { "precision": 3 }
    },
    {
      "id": "min_cell_voltage",
      "type": "sensor",
      "name": "Min Cell Voltage",
      "category": "Cells",
      "expression": "min(cell_voltages)",
      "unit": "V",
      "display": { "precision": 3 }
    },
    {
      "id": "max_cell_voltage",
      "type": "sensor",
      "name": "Max Cell Voltage",
      "category": "Cells",
      "expression": "max(cell_voltages)",
      "unit": "V",
      "display": { "precision": 3 }
    },
    {
      "id": "computed_power",
      "type": "sensor",
      "name": "Power",
      "category": "Pack Status",
      "expression": "total_voltage * current",
      "unit": "W",
      "display": { "precision": 0 },
      "fallbackFor": "power"
    }
  ]
}
```

#### Expression Language

A minimal expression language for computed values:

| Function | Description |
|----------|-------------|
| `min(array_entity)` | Minimum value in a cell_array entity |
| `max(array_entity)` | Maximum value in a cell_array entity |
| `avg(array_entity)` | Average value in a cell_array entity |
| `count(array_entity)` | Number of elements in a cell_array entity |
| `entity_id` | Current value of any entity |
| `+`, `-`, `*`, `/` | Arithmetic operators |
| `abs(expr)` | Absolute value |

`fallbackFor` means: use this computed value only when the referenced entity returns null (e.g., compute power from V×I when the device doesn't report power directly).

---

### 7. `alarms` — Warning & Alarm Decoding

```json
{
  "alarms": {
    "source": "alarm_flags",
    "type": "bitmask",
    "bits": [
      { "bit": 0,  "name": "Wire resistance too high",     "severity": "warning" },
      { "bit": 1,  "name": "MOS overtemperature",          "severity": "critical" },
      { "bit": 2,  "name": "Cell count mismatch",          "severity": "warning" },
      { "bit": 3,  "name": "Current sensor error",         "severity": "critical" },
      { "bit": 4,  "name": "Cell overvoltage",             "severity": "critical" },
      { "bit": 5,  "name": "Battery overvoltage",          "severity": "critical" },
      { "bit": 6,  "name": "Charge overcurrent",           "severity": "critical" },
      { "bit": 7,  "name": "Charge short circuit",         "severity": "critical" },
      { "bit": 8,  "name": "Charge overtemperature",       "severity": "warning" },
      { "bit": 9,  "name": "Charge undertemperature",      "severity": "warning" },
      { "bit": 10, "name": "CPU-AUX communication error",  "severity": "critical" },
      { "bit": 11, "name": "Cell undervoltage",            "severity": "critical" },
      { "bit": 12, "name": "Battery undervoltage",         "severity": "critical" },
      { "bit": 13, "name": "Discharge overcurrent",        "severity": "critical" },
      { "bit": 14, "name": "Discharge short circuit",      "severity": "critical" },
      { "bit": 15, "name": "Discharge overtemperature",    "severity": "warning" },
      { "bit": 16, "name": "Charge MOS error",             "severity": "critical" },
      { "bit": 17, "name": "Discharge MOS error",          "severity": "critical" },
      { "bit": 18, "name": "GPS disconnected",             "severity": "info" },
      { "bit": 19, "name": "Modify password reminder",     "severity": "info" },
      { "bit": 20, "name": "Discharge on failed",          "severity": "critical" },
      { "bit": 21, "name": "Battery over temp alarm",      "severity": "critical" },
      { "bit": 22, "name": "Temperature sensor anomaly",   "severity": "warning" },
      { "bit": 23, "name": "PLC module anomaly",           "severity": "warning" }
    ]
  }
}
```

**Alarm types:**
- `bitmask` — Each bit in an integer entity maps to an alarm condition
- `threshold` — Entity value compared to a threshold (future)
- `state` — Entity value matches a specific state (future)

**Severity levels:** `info`, `warning`, `critical`

---

### 8. `storage` — Telemetry Persistence

Defines which entities to include in time-series storage and at what aggregation levels.

```json
{
  "storage": {
    "timeSeries": [
      { "entity": "total_voltage",      "aggregate": "avg", "column": "total_voltage_v" },
      { "entity": "current",            "aggregate": "avg", "column": "current_a" },
      { "entity": "power",              "aggregate": "avg", "column": "power_w" },
      { "entity": "state_of_charge",    "aggregate": "last", "column": "soc_pct" },
      { "entity": "min_cell_voltage",   "aggregate": "min", "column": "min_cell_v" },
      { "entity": "max_cell_voltage",   "aggregate": "max", "column": "max_cell_v" },
      { "entity": "delta_cell_voltage", "aggregate": "avg", "column": "delta_cell_v" },
      { "entity": "mos_temperature",    "aggregate": "avg", "column": "mos_temp_c" },
      { "entity": "battery_temp_1",     "aggregate": "avg", "column": "battery_temp_c" }
    ],
    "cellVoltages": {
      "entity": "cell_voltages",
      "aggregate": "avg"
    },
    "retention": {
      "raw": { "window": "24h" },
      "1m":  { "window": "1y" },
      "5m":  { "window": "1y" },
      "1h":  { "window": "10y" }
    }
  }
}
```

The `column` field maps entity values to storage columns. The storage engine creates tables dynamically based on the entities declared here.

---

### 9. `ui` — Layout Definition

The UI section describes **what** to render, not **how**. The app's rendering engine maps these declarations to actual framework components.

```json
{
  "ui": {
    "pages": {
      "monitor": {
        "sections": [
          {
            "type": "hero-metrics",
            "metrics": [
              { "entity": "total_voltage", "icon": "zap",      "color": "emerald" },
              { "entity": "current",       "icon": "activity",  "color": "blue" },
              { "entity": "power",         "icon": "gauge",     "color": "amber" },
              { "entity": "state_of_charge", "icon": "battery", "color": "green" }
            ]
          },
          {
            "type": "status-indicators",
            "entities": ["charging_enabled", "discharging_enabled", "balancing_enabled"]
          },
          {
            "type": "cell-chart",
            "entity": "cell_voltages",
            "showStats": true,
            "showDelta": true
          },
          {
            "type": "parameter-table",
            "title": "Configuration",
            "filter": { "writable": true },
            "groupBy": "category"
          },
          {
            "type": "parameter-table",
            "title": "Device Info",
            "filter": { "categories": ["Device Info"] }
          }
        ]
      },
      "history": {
        "charts": [
          {
            "title": "Pack Voltage",
            "type": "line-chart",
            "traces": [{ "entity": "total_voltage", "color": "emerald" }],
            "yAxis": { "unit": "V", "label": "Voltage" }
          },
          {
            "title": "Current",
            "type": "line-chart",
            "traces": [{ "entity": "current", "color": "blue" }],
            "yAxis": { "unit": "A", "label": "Current" }
          },
          {
            "title": "Energy",
            "type": "area-chart",
            "traces": [
              { "entity": "power", "color": "amber", "positiveLabel": "Charging", "negativeLabel": "Discharging" }
            ],
            "yAxis": { "unit": "W", "label": "Power" },
            "showEnergyTotals": true
          },
          {
            "title": "State of Charge",
            "type": "line-chart",
            "traces": [{ "entity": "state_of_charge", "color": "green" }],
            "yAxis": { "unit": "%", "label": "SOC", "domain": [0, 100] }
          },
          {
            "title": "Temperatures",
            "type": "line-chart",
            "traces": [
              { "entity": "mos_temperature",  "label": "MOS",     "color": "red" },
              { "entity": "battery_temp_1",   "label": "Battery", "color": "orange" }
            ],
            "yAxis": { "unit": "°C", "label": "Temperature" }
          },
          {
            "title": "Cell Voltage Spread",
            "type": "line-chart",
            "traces": [
              { "entity": "min_cell_voltage",   "label": "Min",   "color": "red" },
              { "entity": "max_cell_voltage",   "label": "Max",   "color": "emerald" },
              { "entity": "avg_cell_voltage",   "label": "Avg",   "color": "blue", "dashed": true },
              { "entity": "delta_cell_voltage", "label": "Delta", "color": "amber", "secondaryAxis": true }
            ],
            "yAxis": { "unit": "V", "label": "Cell Voltage" }
          },
          {
            "title": "Cell Voltages",
            "type": "multi-cell-chart",
            "entity": "cell_voltages",
            "selectable": true
          }
        ]
      },
      "dashboard": {
        "card": {
          "primaryMetric": "state_of_charge",
          "secondaryMetrics": ["total_voltage", "current", "power"],
          "statusEntities": ["charging_enabled", "discharging_enabled"]
        }
      }
    }
  }
}
```

#### UI Component Types

| Type | Description | Renders As |
|------|-------------|------------|
| `hero-metrics` | Large prominent value cards with icon and color | 3-5 big number cards at top of monitor page |
| `status-indicators` | Boolean state indicators | Colored badges / pill indicators |
| `cell-chart` | Cell voltage visualization | Bar chart with cell indices, min/max/avg stats |
| `parameter-table` | Categorized key-value table | Grouped parameter list with edit capability for writable params |
| `line-chart` | Time-series line chart | Standard line chart with zoom, multiple traces |
| `area-chart` | Time-series area chart | Filled area chart (charge/discharge energy) |
| `multi-cell-chart` | Per-cell time-series overlay | Line chart with selectable cell traces |
| `info-panel` | Static text information | Card with key-value pairs |
| `gauge` | Circular gauge | Circular gauge with min/max/current (future) |

---

### 10. `notifications` — Alert Rules

```json
{
  "notifications": {
    "rules": [
      {
        "id": "low-soc",
        "name": "Low Battery",
        "condition": { "entity": "state_of_charge", "operator": "<", "value": 10 },
        "severity": "critical",
        "message": "Battery critically low: {state_of_charge}%",
        "cooldownMinutes": 15
      },
      {
        "id": "high-temp",
        "name": "High Temperature",
        "condition": { "entity": "mos_temperature", "operator": ">", "value": 60 },
        "severity": "warning",
        "message": "MOS temperature high: {mos_temperature}°C",
        "cooldownMinutes": 30
      },
      {
        "id": "alarm-active",
        "name": "Device Alarm",
        "condition": { "entity": "alarm_flags", "operator": "!=", "value": 0 },
        "severity": "critical",
        "message": "Active alarm: {active_warnings}",
        "cooldownMinutes": 5
      }
    ]
  }
}
```

| Operator | Description |
|----------|-------------|
| `<`, `>`, `<=`, `>=` | Numeric comparison |
| `==`, `!=` | Equality check |
| `has_bit` | Bitmask contains bit (for alarm flags) |
| `changed_to` | Value transition (future) |

The `message` field supports `{entity_id}` placeholders that resolve to current values at notification time.

---

## Application Configuration (appsettings.json)

The app config references device definitions by their `device.id`:

```json
{
  "Monitor": {
    "DeviceDefinitionsPath": "devices/",
    "Devices": [
      {
        "DeviceId": "battery-01",
        "DisplayName": "Main Battery Rack",
        "DefinitionId": "jk-inverter-bms",
        "Address": 1,
        "IsMaster": true,
        "PollIntervalMilliseconds": 1000,
        "Enabled": true,
        "TransportOverrides": {
          "PortName": "/dev/ttyUSB0"
        }
      }
    ]
  }
}
```

Key changes from current config:
- `ProfileId` → `DefinitionId` (references `device.id` in a JSON definition file)
- `DeviceProfiles` section removed (replaced by device definition files)
- `TransportOverrides` allows per-device connection overrides
- No register definitions in appsettings (they live in the device definition)

---

## Implementation Architecture

```
Device Definition JSON ──▶ DeviceDefinitionLoader ──▶ DeviceDefinitionRegistry
                                                            │
                                                            ├──▶ GenericModbusPollingClient
                                                            │         (reads registerBanks, parses entities)
                                                            │
                                                            ├──▶ EntityResolver
                                                            │         (evaluates computedEntities)
                                                            │
                                                            ├──▶ AlarmDecoder
                                                            │         (decodes alarm bitmasks/thresholds)
                                                            │
                                                            ├──▶ StorageMapper
                                                            │         (maps entities → telemetry columns)
                                                            │
                                                            ├──▶ UiLayoutProvider
                                                            │         (serves layout JSON to frontend)
                                                            │
                                                            └──▶ NotificationEvaluator
                                                                      (evaluates rules, sends alerts)
```

### Backend Components

| Component | Purpose |
|-----------|---------|
| `DeviceDefinitionLoader` | Reads and validates JSON files from `devices/` directory |
| `DeviceDefinitionRegistry` | In-memory registry of all loaded definitions |
| `GenericModbusPollingClient` | Replaces `JkRs485PollingClient` — reads register banks and parses entity values from raw bytes using the definition |
| `EntityResolver` | Evaluates computed entities using the expression language |
| `AlarmDecoder` | Decodes alarm flags into active warnings using the definition's alarm mapping |
| `StorageMapper` | Maps entity values to time-series storage columns |
| `UiLayoutProvider` | Serves device UI layout to the frontend via API |
| `NotificationEvaluator` | Evaluates notification rules against current entity values |

### Frontend Components

| Component | Purpose |
|-----------|---------|
| `useDeviceLayout()` | Fetches UI layout for a device definition from the API |
| `DynamicSection` | Routes a section definition to the correct renderer component |
| `HeroMetrics` | Renders `hero-metrics` sections |
| `CellChart` | Renders `cell-chart` sections |
| `ParameterTable` | Renders `parameter-table` sections |
| `DynamicLineChart` | Renders `line-chart`, `area-chart`, `multi-cell-chart` |
| `StatusIndicators` | Renders `status-indicators` sections |

### API Endpoints (new/changed)

```
GET  /api/definitions                              → List loaded device definitions
GET  /api/definitions/{definitionId}               → Full definition JSON
GET  /api/definitions/{definitionId}/ui/{page}     → UI layout for a page
GET  /api/devices/current                          → Device states (unchanged)
GET  /api/devices/{deviceId}/history               → History (unchanged)
POST /api/devices/{deviceId}/write-entity           → Write entity value
```

---

## Migration Path

### Phase 1: Device Definition & Loader
1. Create `devices/` directory and the JK BMS definition JSON
2. Implement `DeviceDefinitionLoader` and `DeviceDefinitionRegistry`
3. Add `/api/definitions` endpoints

### Phase 2: Generic Polling Client
4. Implement `GenericModbusPollingClient` driven by register bank + entity definitions
5. Implement `EntityResolver` for computed entities
6. Implement `AlarmDecoder`
7. Wire up in `ConfiguredPollingClient` as the default handler

### Phase 3: Storage & API
8. Update `StorageMapper` to use definition-driven column mapping
9. Update write-parameter endpoint to use entity definitions
10. Add entity-based API responses alongside snapshot-based ones

### Phase 4: Frontend
11. Add `useDeviceLayout()` hook and layout API integration
12. Implement dynamic section renderers
13. Refactor MonitorPage to use dynamic layout
14. Refactor HistoryCharts to use chart definitions

### Phase 5: Cleanup
15. Remove `JkModbusProtocol.cs`, `JkRs485Protocol.cs`, `JkRs485PollingClient.cs`
16. Remove JK-specific references from configuration models
17. Update appsettings to use new `DefinitionId` field
18. Rename project/service if desired (JkMonitor → DeviceMonitor)
