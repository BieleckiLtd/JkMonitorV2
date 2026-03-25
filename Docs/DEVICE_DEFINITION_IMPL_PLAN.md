# Device Definition Implementation Plan

This document outlines the concrete steps to transform the application from a JK-BMS-specific monitor into a generic device monitoring platform driven by JSON device definitions.

## Current State → Target State

| Aspect | Current | Target |
|--------|---------|--------|
| Device knowledge | Hardcoded in `JkModbusProtocol.cs` | JSON files in `devices/` |
| Protocol handler | `JkRs485PollingClient` | `GenericModbusPollingClient` |
| Register parsing | C# code in `ParseLiveDataResponse` | Data-driven from `entities[]` definitions |
| Alarm decoding | `DecodeAlarmFlags()` with hardcoded names | `AlarmDecoder` reading `alarms.bits[]` |
| UI layout | Hardcoded React components | Dynamic rendering from `ui.pages` definitions |
| Config profiles | `DeviceProfiles[]` in appsettings.json | Self-contained device definition files |

---

## Phase 1: Foundation (Backend)

### 1.1 Device Definition Models

Create `src/shared/JkMonitor.Contracts/DeviceDefinition/` with strongly-typed models matching the JSON schema:

```
DeviceDefinition.cs          → Root model
DeviceMetadata.cs            → device section
ConnectionDefinition.cs      → connection section
RegisterBankDefinition.cs    → registerBanks
PollGroupDefinition.cs       → pollGroups
EntityDefinition.cs          → entities (all types)
EntitySource.cs              → source sub-object
ComputedEntityDefinition.cs  → computedEntities
AlarmDefinition.cs           → alarms
StorageDefinition.cs         → storage
UiDefinition.cs              → ui (pages, sections, charts)
NotificationDefinition.cs    → notifications
```

### 1.2 Device Definition Loader

New service: `Services/DeviceDefinitionLoader.cs`

```csharp
public class DeviceDefinitionLoader
{
    // Loads all *.json from configured directory (default: "devices/")
    // Validates against required fields
    // Returns Dictionary<string, DeviceDefinition> keyed by device.id
    public IReadOnlyDictionary<string, DeviceDefinition> LoadAll(string directoryPath);
}
```

Register as singleton at startup. The registry is the single source of truth for device capabilities.

### 1.3 Device Definition API

New controller: `Controllers/DefinitionsController.cs`

```
GET  /api/definitions                         → List loaded definitions (id, name, category, icon)
GET  /api/definitions/{id}                    → Full definition JSON
GET  /api/definitions/{id}/ui/{page}          → UI layout for a specific page
```

This lets the frontend discover device capabilities dynamically.

---

## Phase 2: Generic Polling Client

### 2.1 Generic Modbus Register Parser

New service: `Services/GenericModbusParser.cs`

Reads raw register bank bytes and extracts entity values using the entity definitions:

```csharp
public class GenericModbusParser
{
    // For each entity in the definition that references the given bank,
    // extract the value from the raw bytes using the entity's source spec.
    public Dictionary<string, object?> ParseBank(
        ReadOnlySpan<byte> bankData,
        string bankId,
        DeviceDefinition definition);
}
```

**Data type handlers:** `uint8`, `uint16`, `uint32`, `int8`, `int16`, `int32`, `float32`, `ascii`
**Cell array handler:** Iterates elements, applies skip-zero, returns `decimal[]`

### 2.2 Expression Evaluator

New service: `Services/ExpressionEvaluator.cs`

Evaluates computed entity expressions against resolved entity values:

```csharp
public class ExpressionEvaluator
{
    // Supports: min(), max(), avg(), count(), abs()
    // Supports: +, -, *, / operators
    // Supports: entity_id references and numeric literals
    public object? Evaluate(string expression, IReadOnlyDictionary<string, object?> entityValues);
}
```

### 2.3 GenericModbusPollingClient

New service replacing `JkRs485PollingClient`:

```csharp
public class GenericModbusPollingClient : IDevicePollingClient
{
    // For each register bank in the device definition:
    //   1. Build Modbus read request (function code + address + count)
    //   2. Send/receive via serial port
    //   3. Parse entities from response bytes
    // Then:
    //   4. Evaluate computed entities
    //   5. Decode alarms
    //   6. Build DevicePollResult
    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken ct);
}
```

The Modbus framing (CRC, request building, response validation) stays unchanged — it's generic already. Only the register addresses and parsing move to the definition.

### 2.4 Alarm Decoder

New service: `Services/AlarmDecoder.cs`

```csharp
public class AlarmDecoder
{
    // Reads alarm_flags entity value
    // Decodes using definition.alarms.bits[]
    // Returns active alarm names with severity
    public IReadOnlyList<ActiveAlarm> Decode(
        IReadOnlyDictionary<string, object?> entityValues,
        AlarmDefinition alarmDef);
}
```

### 2.5 Wire Up

Update `ConfiguredPollingClient.cs`:
- Remove `"jk-rs485"` switch case
- Instead, look up `DeviceDefinition` by `DefinitionId`
- Route to `GenericModbusPollingClient` for any `modbus-rtu` protocol type

---

## Phase 3: Adapt Telemetry & Storage

### 3.1 Entity-Based Telemetry Snapshot

The current `DeviceTelemetrySnapshot` has named properties like `TotalVoltageVolts`, `CurrentAmps`, etc. Two options:

**Option A (recommended): Keep snapshot model, map via roles**

The `DeviceTelemetrySnapshot` is a generic model. The generic polling client maps entities to snapshot fields by `role`:

| Role | Snapshot Field |
|------|---------------|
| `total-voltage` | `TotalVoltageVolts` |
| `current` | `CurrentAmps` |
| `power` | `PowerWatts` |
| `state-of-charge` | `StateOfChargePercent` |
| `cell-voltages` | `Cells[]` |
| `temperature` (first) | `MosTemperatureCelsius` |
| `alarm-flags` | `WarningFlags` |
| etc. | etc. |

Un-mapped entities go into `Parameters[]` as `DeviceParameter` entries.

**Why:** Preserves backward compatibility with existing storage tables, API responses, and frontend code during migration. The current telemetry model is actually fairly generic already.

**Option B (future): Replace with entity bag**
```csharp
public record EntityBag(
    DateTimeOffset CollectedAt,
    IReadOnlyDictionary<string, object?> Values);
```

This is cleaner but requires rewriting storage, API, and frontend simultaneously.

### 3.2 Storage Mapper

Update `SqliteTelemetryRepository` and `TimescaleTelemetryRepository`:
- Use `storage.timeSeries[]` from the definition to know which entities map to which columns
- The current column names match the `column` field in the definition
- No schema changes needed if column names match

---

## Phase 4: Frontend

### 4.1 Layout API Hook

```typescript
// hooks/useDeviceLayout.ts
function useDeviceLayout(definitionId: string, page: string) {
  // Fetches /api/definitions/{definitionId}/ui/{page}
  // Returns the page layout definition
  // Caches in Zustand store
}
```

### 4.2 Dynamic Section Renderer

```typescript
// components/DynamicSection.tsx
function DynamicSection({ section, deviceState }) {
  switch (section.type) {
    case 'hero-metrics':    return <HeroMetrics metrics={section.metrics} data={deviceState} />;
    case 'cell-chart':      return <CellChart entity={section.entity} data={deviceState} />;
    case 'parameter-table': return <ParameterTable filter={section.filter} data={deviceState} />;
    case 'status-indicators': return <StatusIndicators entities={section.entities} data={deviceState} />;
    default:                return null;
  }
}
```

### 4.3 Dynamic History Charts

```typescript
// components/DynamicHistoryCharts.tsx
function DynamicHistoryCharts({ charts, deviceId }) {
  // Reads chart definitions from the layout
  // For each chart definition, renders the appropriate chart type
  // Maps entity IDs to API parameters
}
```

### 4.4 Refactor MonitorPage

```typescript
function MonitorPage() {
  const layout = useDeviceLayout(device.definitionId, 'monitor');
  return layout.sections.map(section =>
    <DynamicSection key={section.type} section={section} deviceState={state} />
  );
}
```

### 4.5 Refactor HistoryCharts

```typescript
function HistoryPage() {
  const layout = useDeviceLayout(device.definitionId, 'history');
  return <DynamicHistoryCharts charts={layout.charts} deviceId={device.deviceId} />;
}
```

---

## Phase 5: Cleanup

### Remove Device-Specific Code

| File | Action |
|------|--------|
| `Protocol/JkModbusProtocol.cs` | Delete (register maps moved to JSON) |
| `Protocol/JkRs485Protocol.cs` | Delete (legacy, already superseded) |
| `Services/JkRs485PollingClient.cs` | Delete (replaced by `GenericModbusPollingClient`) |

### Keep (Generic)

| File | Reason |
|------|--------|
| `Services/PollingBackgroundService.cs` | Already generic (loops over devices) |
| `Services/DeviceStateStore.cs` | Already generic (keyed by device ID) |
| `Services/CellVoltageDeadbandFilter.cs` | Generic smoothing for any cell_array entity |
| `Services/SqliteTelemetryRepository.cs` | Generic storage |
| `Controllers/DevicesController.cs` | Generic REST API |

### Update Configuration

**Before (appsettings.json):**
```json
"DeviceProfiles": [{
  "ProfileId": "jk-inverter-bms",
  "ProtocolHandler": "jk-rs485",
  "Transport": { ... },
  "Registers": [ ... ]
}],
"Devices": [{
  "ProfileId": "jk-inverter-bms",
  ...
}]
```

**After (appsettings.json):**
```json
"DeviceDefinitionsPath": "devices/",
"Devices": [{
  "DefinitionId": "jk-inverter-bms",
  "TransportOverrides": { "PortName": "/dev/ttyUSB0" },
  ...
}]
```

---

## Execution Order

The phases are designed to be incremental and testable:

1. **Phase 1** can be done without changing any existing functionality — it's purely additive.
2. **Phase 2** creates the new generic client alongside the existing JK client. Both can coexist during testing.
3. **Phase 3** maps the new generic client output to the existing telemetry model, so storage and API work unchanged.
4. **Phase 4** adds dynamic rendering alongside existing hardcoded pages.
5. **Phase 5** removes the old code once everything is verified.

At no point is there a "big bang" where everything changes at once. Each phase can be tested and deployed independently.

---

## Adding a New Device

Once implemented, adding a new device (e.g., Growatt solar inverter) requires:

1. Create `devices/growatt-mic-2000.json` with the device definition
2. Add a device entry in `appsettings.json`:
   ```json
   {
     "DeviceId": "inverter-01",
     "DisplayName": "Roof Inverter",
     "DefinitionId": "growatt-mic-2000",
     "Address": 1,
     "PollIntervalMilliseconds": 5000
   }
   ```
3. Restart the service

No code changes. No rebuild. No redeployment of the application binary.
