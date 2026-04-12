using System.Text.Json.Serialization;

namespace FluxMonitor.Contracts.Configuration;

public sealed class MonitorConfiguration
{
    public required StorageConfiguration Storage { get; init; }

    public required ApiSecurityConfiguration ApiSecurity { get; init; }

    public string DeviceDefinitionsPath { get; init; } = "devices";
}

public sealed class StorageConfiguration
{
    public required string Provider { get; init; }

    public required string ConnectionString { get; init; }

    public required RetentionConfiguration Retention { get; init; }

    public CompressionConfiguration Compression { get; init; } = new();
}

public sealed class CompressionConfiguration
{
    /// <summary>
    /// Deprecated age-based compression policy setting.
    /// Compression now runs as a nightly midnight sweep, so the default stays at 0.
    /// </summary>
    public int CompressAfterMinutes { get; init; } = 0;
}

public sealed class RetentionConfiguration
{
    public int RawSecondsWindowMinutes { get; init; } = 10;

    public int PersistedBucketMinutes { get; init; } = 5;

    public int FiveMinuteWindowDays { get; init; } = 0;
}

public sealed class ApiSecurityConfiguration
{
    public bool RequireAuthentication { get; init; } = true;

    public required string TunnelProvider { get; init; }

    public CloudflareTunnelConfiguration CloudflareTunnel { get; init; } = new();
}

public sealed class CloudflareTunnelConfiguration
{
    public string PublicUrl { get; init; } = string.Empty;
}

public sealed class DeviceConfiguration
{
    public required string DeviceId { get; init; }

    public required string DisplayName { get; init; }

    /// <summary>
    /// ID of the device definition JSON (maps to device.id in the JSON file).
    /// Drives polling, rendering, and storage via the definition-driven pipeline.
    /// </summary>
    public required string DefinitionId { get; init; }

    /// <summary>
    /// Serial port for this device (e.g. "/dev/ttyUSB0").
    /// Required for serial transport devices.
    /// </summary>
    public string? TransportPortName { get; init; }

    /// <summary>
    /// Optional settings PIN for BLE devices that gate configuration writes.
    /// </summary>
    public string? BleSettingsPin { get; init; }

    public byte Address { get; init; }

    public bool IsMaster { get; init; }

    public int PollIntervalMilliseconds { get; init; } = 1000;

    public bool Enabled { get; init; } = true;

    /// <summary>
    /// EMA weight for new cell-voltage readings (0–1). 0 disables smoothing.
    /// Lower values smooth more aggressively; 0.3 is a good starting point
    /// for ±2 mV measurement noise at 1 Hz polling.
    /// </summary>
    public decimal CellVoltageSmoothingFactor { get; init; }

    /// <summary>
    /// When the raw reading differs from the smoothed value by more than this
    /// many millivolts, the smoothed value snaps to the raw reading immediately.
    /// 0 disables breakout detection (pure EMA).
    /// </summary>
    public int CellVoltageSmoothingBreakoutMillivolts { get; init; }

    public DisplayPrecisionConfiguration DisplayPrecision { get; init; } = new();

    /// <summary>
    /// Preferred temperature display unit for this device: "c" (Celsius, default) or "f" (Fahrenheit).
    /// </summary>
    public string TemperatureUnit { get; init; } = "c";

    public string? DefinitionVersion { get; init; }

    [JsonIgnore]
    public bool HasDefinitionOverride { get; init; }

    [JsonIgnore]
    public string DefinitionJson { get; init; } = string.Empty;

    [JsonIgnore]
    public string DefinitionHash { get; init; } = string.Empty;
}

public sealed class DisplayPrecisionConfiguration
{
    public int Voltage { get; init; } = 2;

    public int CellVoltage { get; init; } = 3;

    public int Current { get; init; } = 1;

    public int Power { get; init; } = 0;

    public int Temperature { get; init; } = 1;

    public int Soc { get; init; } = 0;

    public int DeltaVoltage { get; init; } = 3;
}
