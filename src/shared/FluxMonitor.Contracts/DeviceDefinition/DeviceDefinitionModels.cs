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

    /// <summary>
    /// Optional settings for serial protocols that exchange ASCII-hex framed
    /// request/response messages with configurable length and checksum rules.
    /// </summary>
    public AsciiHexFrameSettings? AsciiHexFrame { get; init; }

    /// <summary>
    /// Optional settings for passive BLE advertisement-based protocols.
    /// </summary>
    public BleAdvertisementSettings? Advertisement { get; init; }
}

public sealed class BleAdvertisementSettings
{
    /// <summary>
    /// Advertisement payload source: "manufacturer-data" or "service-data".
    /// </summary>
    public string PayloadSource { get; init; } = "manufacturer-data";

    /// <summary>
    /// Manufacturer/company ID used when <see cref="PayloadSource"/> is "manufacturer-data".
    /// </summary>
    public int? ManufacturerId { get; init; }

    /// <summary>
    /// Service-data UUID used when <see cref="PayloadSource"/> is "service-data".
    /// </summary>
    public string? ServiceDataUuid { get; init; }

    /// <summary>
    /// Optional device-name prefix used to identify likely candidates during discovery.
    /// </summary>
    public string? LocalNamePrefix { get; init; }

    /// <summary>
    /// Number of bytes to skip at the start of the selected advertisement payload.
    /// </summary>
    public int PayloadOffset { get; init; }

    /// <summary>
    /// Number of payload bytes to keep after <see cref="PayloadOffset"/>.
    /// A value of 0 keeps the remaining bytes.
    /// </summary>
    public int PayloadLength { get; init; }

    /// <summary>
    /// How long to wait for a fresh advertisement when polling, in milliseconds.
    /// </summary>
    public int ScanWindowMs { get; init; } = 3000;

    /// <summary>
    /// How long a captured advertisement remains fresh enough to reuse, in milliseconds.
    /// </summary>
    public int FreshnessMs { get; init; } = 10000;
}

public sealed class AsciiHexFrameSettings
{
    /// <summary>Single-byte start-of-frame marker.</summary>
    public byte StartByte { get; init; } = (byte)'~';

    /// <summary>Single-byte end-of-frame marker.</summary>
    public byte EndByte { get; init; } = (byte)'\r';

    /// <summary>Protocol version byte written as two ASCII-hex characters.</summary>
    public byte Version { get; init; }

    /// <summary>ASCII-char offset of the version byte within the frame body.</summary>
    public int VersionOffsetChars { get; init; } = 0;

    /// <summary>ASCII-char offset of the address byte within the frame body.</summary>
    public int AddressOffsetChars { get; init; } = 2;

    /// <summary>Fixed request command-set/group byte written before the command byte.</summary>
    public byte RequestCommandSet { get; init; }

    /// <summary>ASCII-char offset of the request command-set/group byte within the frame body.</summary>
    public int RequestCommandSetOffsetChars { get; init; } = 4;

    /// <summary>ASCII-char offset of the command byte within the frame body.</summary>
    public int CommandOffsetChars { get; init; } = 6;

    /// <summary>ASCII-char offset of the encoded payload length within the frame body.</summary>
    public int LengthOffsetChars { get; init; } = 8;

    /// <summary>ASCII-char offset where the payload begins within the frame body.</summary>
    public int PayloadOffsetChars { get; init; } = 12;

    /// <summary>Number of ASCII hex chars used for the encoded length field.</summary>
    public int LengthCharCount { get; init; } = 4;

    /// <summary>Number of ASCII hex chars used for the trailing frame checksum.</summary>
    public int ChecksumCharCount { get; init; } = 4;

    /// <summary>Length encoding algorithm, e.g. "plain-12bit" or "nibble-checksum-12bit".</summary>
    public string LengthEncoding { get; init; } = "plain-12bit";

    /// <summary>Frame checksum algorithm, e.g. "none" or "ones-complement-sum16".</summary>
    public string FrameChecksumType { get; init; } = "none";

    /// <summary>Successful response command/status byte.</summary>
    public byte ResponseSuccessCode { get; init; }
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

    /// <summary>
    /// Optional layout definition for normalizing variable-length protocol responses
    /// into a fixed-size byte buffer that entities can reference via byte offsets.
    /// When set, the raw response payload is transformed according to these steps
    /// before entity parsing.
    /// </summary>
    public ResponseLayoutDefinition? ResponseLayout { get; init; }

    /// <summary>
    /// Optional hex-encoded INFO payload to include in the request frame (for ASCII-hex protocols).
    /// E.g. "FF" for "get all modules".
    /// </summary>
    public string? RequestInfo { get; init; }
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

    /// <summary>
    /// For <c>select</c>-type entities: the list of allowable raw-value/label pairs.
    /// </summary>
    public IReadOnlyList<SelectOptionDefinition>? Options { get; init; }
}

/// <summary>One allowable choice for a <c>select</c>-type entity.</summary>
public sealed class SelectOptionDefinition
{
    public int Value { get; init; }

    public required string Label { get; init; }
}

public sealed class EntityWriteDefinition
{
    public int? Address { get; init; }

    public int? ValueLength { get; init; }

    public int? GroupStartAddress { get; init; }

    public int? GroupRegisterCount { get; init; }
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

    /// <summary>
    /// Optional bitmask applied to the raw value before comparing with <see cref="TrueValue"/>.
    /// When non-zero, the comparison becomes <c>(rawValue &amp; BitMask) == TrueValue</c>.
    /// </summary>
    public uint BitMask { get; init; }
}

public sealed class EntityDisplayDefinition
{
    public int Precision { get; init; }

    public string? Format { get; init; }

    public string? Formatter { get; init; }
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

    public bool Hidden { get; init; }
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

    public IReadOnlyList<UiStatusGlyphDefinition>? StatusGlyphs { get; init; }
}

public sealed class UiStatusGlyphDefinition
{
    public required string Type { get; init; }

    public string? Entity { get; init; }

    public string? Icon { get; init; }

    public IReadOnlyList<UiStatusGlyphLevelDefinition>? Levels { get; init; }

    public IReadOnlyList<UiStatusGlyphStateDefinition>? States { get; init; }

    public string? DefaultIcon { get; init; }

    public string? DefaultColor { get; init; }

    public string? DefaultTitle { get; init; }
}

public sealed class UiStatusGlyphLevelDefinition
{
    public double? MinValue { get; init; }

    public double? MaxValue { get; init; }

    public int? MaxAgeSeconds { get; init; }

    public string? Color { get; init; }

    public string? Label { get; init; }
}

public sealed class UiStatusGlyphStateDefinition
{
    public required string Entity { get; init; }

    [JsonPropertyName("equals")]
    public bool? EqualsValue { get; init; }

    public string? Icon { get; init; }

    public string? Color { get; init; }

    public string? Title { get; init; }
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

/// <summary>
/// Defines how to normalize a variable-length protocol response into a fixed-size
/// byte buffer so that entity definitions can use stable byte offsets.
/// </summary>
public sealed class ResponseLayoutDefinition
{
    /// <summary>Size in bytes of the normalized output buffer.</summary>
    public required int BufferSize { get; init; }

    /// <summary>Ordered list of steps that read from the input and write to the output buffer.</summary>
    public required IReadOnlyList<ResponseLayoutStep> Steps { get; init; }
}

/// <summary>
/// A single step in a response layout normalization pipeline.
/// Each step has an <see cref="Op"/> that determines which fields are used.
/// <list type="bullet">
///   <item><c>skip</c> — skip <see cref="Size"/> bytes in the input.</item>
///   <item><c>copy</c> — copy <see cref="Size"/> bytes from input to buffer at <see cref="WriteTo"/>.</item>
///   <item><c>copyRemaining</c> — copy all remaining input bytes (up to <see cref="Max"/>) to <see cref="WriteTo"/>.</item>
///   <item><c>readVar</c> — read a value of <see cref="Type"/> from input, store as <see cref="Var"/>.
///         Optionally write to buffer at <see cref="WriteTo"/> using <see cref="WriteAs"/> type.</item>
///   <item><c>writeVar</c> — write stored variable <see cref="Var"/> to buffer at <see cref="WriteTo"/> as <see cref="WriteAs"/>.</item>
///   <item><c>writeBit</c> — extract bit <see cref="Bit"/> from variable <see cref="Var"/>, write 0 or 1 to <see cref="WriteTo"/>.</item>
///   <item><c>copyArray</c> — copy a variable-length array: <see cref="Count"/> × <see cref="ElementSize"/> bytes
///         from input to <see cref="WriteTo"/>, padding up to <see cref="Max"/> slots.</item>
///   <item><c>skipArray</c> — skip <see cref="Count"/> × <see cref="ElementSize"/> bytes in input.</item>
///   <item><c>readAnyNonZero</c> — read <see cref="Count"/> bytes; write 1 to <see cref="WriteTo"/> if any non-zero, else 0.</item>
///   <item><c>readByte</c> — read 1 byte from input, write to <see cref="WriteTo"/>.</item>
///   <item><c>firstOf</c> — read count from <see cref="Var"/>, execute <see cref="Steps"/> for first item only.</item>
///   <item><c>branch</c> — if variable <see cref="Var"/> satisfies condition (<see cref="Gt"/>/<see cref="Lt"/>/<see cref="Eq"/>),
///         execute <see cref="Then"/>, otherwise <see cref="Else"/>.</item>
///   <item><c>mathAdd</c>/<c>mathSub</c>/<c>mathMul</c>/<c>mathDiv</c>/<c>mathMod</c>/<c>mathAnd</c>/<c>mathXor</c> —
///         apply arithmetic or bitwise math to <see cref="Var"/> using <see cref="Value"/> or <see cref="OtherVar"/>,
///         storing the result in <see cref="TargetVar"/> (or back into <see cref="Var"/> when omitted).</item>
/// </list>
/// </summary>
public sealed class ResponseLayoutStep
{
    /// <summary>Operation type — see class documentation for supported values.</summary>
    public required string Op { get; init; }

    /// <summary>Byte count for skip/copy operations.</summary>
    public int Size { get; init; }

    /// <summary>Destination byte offset in the output buffer. Null means no write.</summary>
    public int? WriteTo { get; init; }

    /// <summary>Named variable to read or write.</summary>
    public string? Var { get; init; }

    /// <summary>Input data type: "u8", "u16", "u24", "u32".</summary>
    public string? Type { get; init; }

    /// <summary>Output write type for readVar/writeVar: "u8", "u16", "u32". Defaults to match <see cref="Type"/>.</summary>
    public string? WriteAs { get; init; }

    /// <summary>Name of a stored variable holding the element count for array operations.</summary>
    public string? Count { get; init; }

    /// <summary>Optional second variable name used by math operations.</summary>
    public string? OtherVar { get; init; }

    /// <summary>Optional destination variable for math operations. Defaults to <see cref="Var"/>.</summary>
    public string? TargetVar { get; init; }

    /// <summary>Optional constant value used by math operations.</summary>
    public int? Value { get; init; }

    /// <summary>Byte size of each element in array operations.</summary>
    public int ElementSize { get; init; }

    /// <summary>Maximum number of elements/bytes for array/copyRemaining operations.</summary>
    public int Max { get; init; }

    /// <summary>Bit index (0-7) for writeBit operation.</summary>
    public int Bit { get; init; }

    /// <summary>Variable must be greater than this value (for branch).</summary>
    public int? Gt { get; init; }

    /// <summary>Variable must be less than this value (for branch).</summary>
    public int? Lt { get; init; }

    /// <summary>Variable must equal this value (for branch).</summary>
    public int? Eq { get; init; }

    /// <summary>Sub-steps for firstOf/branch-then operations.</summary>
    public IReadOnlyList<ResponseLayoutStep>? Steps { get; init; }

    /// <summary>Steps to execute when branch condition is true.</summary>
    public IReadOnlyList<ResponseLayoutStep>? Then { get; init; }

    /// <summary>Steps to execute when branch condition is false.</summary>
    [JsonPropertyName("else")]
    public IReadOnlyList<ResponseLayoutStep>? Else { get; init; }
}
