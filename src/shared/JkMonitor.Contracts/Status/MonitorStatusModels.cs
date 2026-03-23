namespace JkMonitor.Contracts.Status;

using JkMonitor.Contracts.Configuration;

public sealed record class DeviceRuntimeState
{
    public required string DeviceId { get; init; }

    public required string DisplayName { get; init; }

    public required string ProfileId { get; init; }

    public string? ProtocolHandler { get; init; }

    public bool Enabled { get; init; }

    public bool IsMaster { get; init; }

    public int PollIntervalMilliseconds { get; init; }

    public DateTimeOffset? LastPollStartedAt { get; init; }

    public DateTimeOffset? LastPollCompletedAt { get; init; }

    public string LastOutcome { get; init; } = "NotStarted";

    public string? LastError { get; init; }

    public DateTimeOffset? LastPersistedAt { get; init; }

    public DisplayPrecisionConfiguration DisplayPrecision { get; init; } = new();

    public DeviceTelemetrySnapshot? LatestTelemetry { get; init; }
}

public sealed record class MonitorRuntimeStatus
{
    public required string ServiceName { get; init; }

    public required string EnvironmentName { get; init; }

    public required string StartupMode { get; init; }

    public required DateTimeOffset StartedAt { get; init; }

    public required DateTimeOffset ReportedAt { get; init; }

    public int ConfiguredDeviceCount { get; init; }

    public int EnabledDeviceCount { get; init; }

    public BuildRuntimeInfo? Build { get; init; }

    public SystemRuntimeMetrics? SystemMetrics { get; init; }

    public required IReadOnlyList<DeviceRuntimeState> Devices { get; init; }
}

public sealed record class BuildRuntimeInfo
{
    public string? ReleaseTag { get; init; }

    public string? SourceRevisionId { get; init; }

    public string? InformationalVersion { get; init; }

    public string? WorkflowRunNumber { get; init; }

    public string? WorkflowRunAttempt { get; init; }

    public string? BuiltAt { get; init; }
}

public sealed record class SystemRuntimeMetrics
{
    public double? CpuUtilizationPercent { get; init; }

    public int? CpuCoreCount { get; init; }

    public int? CpuMaxClockSpeedMegahertz { get; init; }

    public int? CpuCurrentClockSpeedMegahertz { get; init; }

    public int? ProcessCount { get; init; }

    public long? SystemUptimeSeconds { get; init; }

    public long? MemoryAvailableBytes { get; init; }

    public long? MemoryUsedBytes { get; init; }

    public long? MemoryTotalBytes { get; init; }

    public long? StorageUsedBytes { get; init; }

    public long? StorageTotalBytes { get; init; }

    public int? MainFanSpeedRpm { get; init; }

    public double? SystemTemperatureCelsius { get; init; }
}
