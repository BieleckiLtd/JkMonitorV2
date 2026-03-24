namespace JkMonitor.Contracts.Configuration;

public sealed class MonitorConfiguration
{
    public required SerialBusConfiguration SerialBus { get; init; }

    public required StorageConfiguration Storage { get; init; }

    public required AlertingConfiguration Alerting { get; init; }

    public required ApiSecurityConfiguration ApiSecurity { get; init; }

    public required IReadOnlyList<DeviceConfiguration> Devices { get; init; }

    public IReadOnlyList<DeviceProfileConfiguration> DeviceProfiles { get; init; } = [];
}

public sealed class SerialBusConfiguration
{
    public required string PortName { get; init; }

    public int BaudRate { get; init; } = 115200;

    public int DataBits { get; init; } = 8;

    public string Parity { get; init; } = "None";

    public string StopBits { get; init; } = "One";

    public int ReadTimeoutMilliseconds { get; init; } = 1000;

    public int WriteTimeoutMilliseconds { get; init; } = 1000;
}

public sealed class StorageConfiguration
{
    public required string Provider { get; init; }

    public required string ConnectionString { get; init; }

    public required RetentionConfiguration Retention { get; init; }
}

public sealed class RetentionConfiguration
{
    public int RawSecondsWindowMinutes { get; init; } = 1440;

    public int OneMinuteWindowHours { get; init; } = 8760;

    public int FiveMinuteWindowDays { get; init; } = 365;

    public int OneHourWindowDays { get; init; } = 3650;
}

public sealed class AlertingConfiguration
{
    public bool UiEnabled { get; init; } = true;

    public NtfyConfiguration? Ntfy { get; init; }
}

public sealed class NtfyConfiguration
{
    public required string BaseUrl { get; init; }

    public required string Topic { get; init; }

    public string? AccessToken { get; init; }
}

public sealed class ApiSecurityConfiguration
{
    public bool RequireAuthentication { get; init; } = true;

    public required string TunnelProvider { get; init; }
}

public sealed class DeviceConfiguration
{
    public required string DeviceId { get; init; }

    public required string DisplayName { get; init; }

    public required string ProfileId { get; init; }

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
