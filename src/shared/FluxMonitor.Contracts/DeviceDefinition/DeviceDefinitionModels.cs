using System.Text.Json.Serialization;

namespace FluxMonitor.Contracts.DeviceDefinition;

public sealed class DeviceDefinition
{
    [JsonPropertyName("$schema")]
    public string? Schema { get; init; }

    public required string Version { get; init; }

    public required DeviceMetadata Device { get; init; }

    public required ConnectionDefinition Connection { get; init; }

    public required IReadOnlyList<DataSourceDefinition> DataSources { get; init; }

    public required IReadOnlyDictionary<string, PollGroupDefinition> PollGroups { get; init; }

    public required IReadOnlyList<EntityDefinition> Entities { get; init; }

    public IReadOnlyList<ComputedEntityDefinition> ComputedEntities { get; init; } = [];

    public AlarmDefinition? Alarms { get; init; }

    public StorageDefinition? Storage { get; init; }

    public UiDefinition? Ui { get; init; }

    public NotificationDefinition? Notifications { get; init; }
}

public sealed class DeviceMetadata
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public string? Manufacturer { get; init; }

    public string? Model { get; init; }

    public string? Category { get; init; }

    public string? Description { get; init; }

    public string? Icon { get; init; }

    public string? DocumentationUrl { get; init; }
}

public sealed class ConnectionDefinition
{
    public required TransportDefinition Transport { get; init; }

    public required ProtocolDefinition Protocol { get; init; }
}

public sealed class TransportDefinition
{
    public required string Type { get; init; }

    public TransportDefaults? Defaults { get; init; }
}

public sealed class TransportDefaults
{
    // Serial transport
    public int BaudRate { get; init; } = 115200;

    public int DataBits { get; init; } = 8;

    public string Parity { get; init; } = "none";

    public int StopBits { get; init; } = 1;

    public int ReadTimeoutMs { get; init; } = 1000;

    public int WriteTimeoutMs { get; init; } = 1000;

    // BLE transport
    public string? ServiceUuid { get; init; }

    public string? NotifyCharacteristicUuid { get; init; }

    public string? WriteCharacteristicUuid { get; init; }

    public int ConnectionTimeoutMs { get; init; } = 20000;

    public int ReconnectDelayMs { get; init; } = 5000;
}

public sealed class ProtocolDefinition
{
    public required string Type { get; init; }

    public ProtocolSettings? Settings { get; init; }
}

public sealed class ProtocolSettings
{
    // Modbus
    public byte DefaultSlaveAddress { get; init; } = 1;

    public int InterFrameDelayMs { get; init; } = 100;

    public int Retries { get; init; } = 1;

    /// <summary>Byte order for multi-byte values: "big-endian" (Modbus default) or "little-endian" (BLE).</summary>
    public string ByteOrder { get; init; } = "big-endian";

    /// <summary>Expected response frame size in bytes (BLE frame protocols).</summary>
    public int ResponseFrameSize { get; init; }

    /// <summary>Checksum algorithm: "crc16" (Modbus), "sum8" (JK BMS BLE), or "none".</summary>
    public string ChecksumType { get; init; } = "crc16";

    /// <summary>Request frame size in bytes for command-driven BLE frame protocols.</summary>
    public int RequestFrameSize { get; init; } = 20;

    /// <summary>Leading bytes that identify outbound BLE command frames.</summary>
    public IReadOnlyList<byte> RequestPreamble { get; init; } = [];

    /// <summary>Leading bytes that identify inbound BLE notification frames.</summary>
    public IReadOnlyList<byte> ResponsePreamble { get; init; } = [];

    /// <summary>Zero-based offset of the bank command byte inside outbound request frames.</summary>
    public int CommandOffset { get; init; } = 4;

    /// <summary>Zero-based offset of the frame discriminator byte inside inbound notification frames.</summary>
    public int ResponseFrameTypeOffset { get; init; } = 4;

    /// <summary>Number of trailing bytes to exclude from the payload (e.g. checksum bytes).</summary>
    public int ResponseFooterSize { get; init; } = 1;

    /// <summary>Zero-based offset of the target register/address byte inside generic frame-register write commands.</summary>
    public int WriteRegisterOffset { get; init; } = 4;

    /// <summary>Zero-based offset of the value-length byte inside generic frame-register write commands.</summary>
    public int WriteValueLengthOffset { get; init; } = 5;

    /// <summary>Zero-based offset of the first raw-value byte inside generic frame-register write commands.</summary>
    public int WriteValueOffset { get; init; } = 6;

    /// <summary>Byte order used when encoding raw values into generic frame-register write commands.</summary>
    public string WriteValueByteOrder { get; init; } = "little-endian";

    /// <summary>Minimum delay in milliseconds between sequential bank reads (e.g. BMS requiring wakeup settling time).</summary>
    public int InterBankDelayMs { get; init; }
}

public sealed class DataSourceDefinition
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required string PollGroup { get; init; }

    /// <summary>
    /// Read strategy for the data source.
    /// "request-response" actively writes a request frame and waits for the matching response.
    /// "notify-stream" consumes matching unsolicited notify frames from the active BLE subscription.
    /// </summary>
    public string ReadMode { get; init; } = "request-response";

    /// <summary>When true, read failures for this bank do not fail the overall poll.</summary>
    public bool Optional { get; init; }

    // Modbus: register address and count
    public ushort Address { get; init; }

    public ushort Count { get; init; }

    public byte FunctionCode { get; init; } = 3;

    public DataSourceWriteDefinition? Write { get; init; }

    // BLE frame protocol: command byte and expected response frame type
    public byte Command { get; init; }

    public byte ResponseFrameType { get; init; }

    /// <summary>Number of header bytes to skip before entity payload (e.g. 6 for JK BMS BLE preamble+type+counter).</summary>
    public int HeaderSize { get; init; }
}

public sealed class DataSourceWriteDefinition
{
    public string Type { get; init; } = "modbus-registers";

    public byte FunctionCode { get; init; } = 16;

    public int RegistersPerWrite { get; init; } = 2;

    public int AddressBase { get; init; }

    public int AddressStepBytes { get; init; } = 1;

    public int? ValueLength { get; init; }
}

public sealed class PollGroupDefinition
{
    public int IntervalMs { get; init; } = 1000;

    public string? Description { get; init; }
}

public sealed class EntityDefinition
{
    [JsonPropertyName("_comment")]
    public string? Comment { get; init; }

    public required string Id { get; init; }

    public required string Type { get; init; }

    public required string Name { get; init; }

    public required string Category { get; init; }

    public string? Icon { get; init; }

    public required EntitySourceDefinition Source { get; init; }

    public EntityWriteDefinition? Write { get; init; }

    public EntityDisplayDefinition? Display { get; init; }

    public string? Role { get; init; }

    public bool Hidden { get; init; }

    public bool Writable { get; init; }
}

public sealed class EntityWriteDefinition
{
    public int? Address { get; init; }

    public int? ValueLength { get; init; }
}

public sealed class EntitySourceDefinition
{
    public required string Bank { get; init; }

    public required int ByteOffset { get; init; }

    public string DataType { get; init; } = "uint16";

    public double Scale { get; init; } = 1.0;

    public string? Unit { get; init; }

    // cell_array specific
    public string? ElementDataType { get; init; }

    public int ElementByteSize { get; init; } = 2;

    public int MaxElements { get; init; }

    public bool SkipZero { get; init; }

    // ascii specific
    public int Length { get; init; }

    // binary_sensor specific
    public int TrueValue { get; init; } = 1;
}

public sealed class EntityDisplayDefinition
{
    public int Precision { get; init; }

    public string? Format { get; init; }
}

public sealed class ComputedEntityDefinition
{
    public required string Id { get; init; }

    public required string Type { get; init; }

    public required string Name { get; init; }

    public required string Category { get; init; }

    public required string Expression { get; init; }

    public string? Unit { get; init; }

    public EntityDisplayDefinition? Display { get; init; }

    public string? Role { get; init; }

    public string? FallbackFor { get; init; }
}

public sealed class AlarmDefinition
{
    public required string Source { get; init; }

    public required string Type { get; init; }

    public required IReadOnlyList<AlarmBitDefinition> Bits { get; init; }
}

public sealed class AlarmBitDefinition
{
    public required int Bit { get; init; }

    public required string Name { get; init; }

    public string Severity { get; init; } = "warning";
}

public sealed class StorageDefinition
{
    /// <summary>
    /// Database requirements for this device type.
    /// When present, the device needs its own dedicated database.
    /// </summary>
    public DatabaseRequirement? Database { get; init; }

    public IReadOnlyList<TimeSeriesMapping> TimeSeries { get; init; } = [];

    public CellVoltageStorageMapping? CellVoltages { get; init; }

    public IReadOnlyDictionary<string, RetentionWindow>? Retention { get; init; }
}

public sealed class DatabaseRequirement
{
    /// <summary>
    /// The storage provider required: "timescaledb", "postgres", or "both".
    /// </summary>
    public required string Provider { get; init; }

    /// <summary>
    /// A suggested default database name pattern.
    /// The placeholder {deviceId} is replaced with the actual device ID.
    /// </summary>
    public string DefaultNamePattern { get; init; } = "FluxMonitor_{deviceId}";
}

public sealed class TimeSeriesMapping
{
    public required string Entity { get; init; }

    public required string Aggregate { get; init; }

    public required string Column { get; init; }
}

public sealed class CellVoltageStorageMapping
{
    public required string Entity { get; init; }

    public required string Aggregate { get; init; }
}

public sealed class RetentionWindow
{
    public required string Window { get; init; }
}

public sealed class UiDefinition
{
    public IReadOnlyDictionary<string, UiPageDefinition>? Pages { get; init; }
}

public sealed class UiPageDefinition
{
    public IReadOnlyList<UiSectionDefinition>? Sections { get; init; }

    public IReadOnlyList<UiResolutionDefinition>? Resolutions { get; init; }

    public IReadOnlyList<UiChartDefinition>? Charts { get; init; }

    public UiDashboardCard? Card { get; init; }
}

public sealed class UiSectionDefinition
{
    public required string Type { get; init; }

    public IReadOnlyList<UiMetricDefinition>? Metrics { get; init; }

    public IReadOnlyList<string>? Entities { get; init; }

    public string? Entity { get; init; }

    public bool ShowStats { get; init; }

    public bool ShowDelta { get; init; }

    public IReadOnlyList<string>? Stats { get; init; }

    public string? Title { get; init; }

    public UiFilterDefinition? Filter { get; init; }

    public string? GroupBy { get; init; }
}

public sealed class UiMetricDefinition
{
    public required string Entity { get; init; }

    public string? Icon { get; init; }

    public string? Color { get; init; }
}

public sealed class UiFilterDefinition
{
    public bool? Writable { get; init; }

    public IReadOnlyList<string>? Categories { get; init; }
}

public sealed class UiResolutionDefinition
{
    public required string Id { get; init; }

    public required string Label { get; init; }

    public required string DefaultWindow { get; init; }
}

public sealed class UiChartDefinition
{
    public required string Title { get; init; }

    public required string Type { get; init; }

    public IReadOnlyList<UiChartTrace>? Traces { get; init; }

    public string? Entity { get; init; }

    public bool Selectable { get; init; }

    public UiAxisDefinition? YAxis { get; init; }

    public bool ShowEnergyTotals { get; init; }
}

public sealed class UiChartTrace
{
    public required string Entity { get; init; }

    public string? Label { get; init; }

    public string? Color { get; init; }

    public bool Dashed { get; init; }

    public bool SecondaryAxis { get; init; }

    public string? PositiveLabel { get; init; }

    public string? NegativeLabel { get; init; }
}

public sealed class UiAxisDefinition
{
    public string? Unit { get; init; }

    public string? Label { get; init; }

    public IReadOnlyList<double>? Domain { get; init; }
}

public sealed class UiDashboardCard
{
    public string? PrimaryMetric { get; init; }

    public IReadOnlyList<string>? SecondaryMetrics { get; init; }

    public IReadOnlyList<string>? StatusEntities { get; init; }
}

public sealed class NotificationDefinition
{
    public IReadOnlyList<NotificationRule> Rules { get; init; } = [];
}

public sealed class NotificationRule
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public required NotificationCondition Condition { get; init; }

    public required string Severity { get; init; }

    public required string Message { get; init; }

    public int CooldownMinutes { get; init; } = 15;
}

public sealed class NotificationCondition
{
    public required string Entity { get; init; }

    public required string Operator { get; init; }

    public required double Value { get; init; }
}
