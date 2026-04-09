using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Models;

public sealed record class SetupStateResponse
{
    public required string CurrentStartupMode { get; init; }

    public required string EnvironmentName { get; init; }

    public required bool SetupRequired { get; init; }

    public required bool UseDatabase { get; init; }

    public string? ConnectionString { get; init; }

    public string? SerialPort { get; init; }

    public required IReadOnlyList<string> SerialPorts { get; init; }

    public required bool CanAutoRestart { get; init; }

    public required string ApplyMessage { get; init; }
}

public sealed record class LocalDependenciesStateResponse
{
    public required bool Supported { get; init; }

    public required bool IsRunning { get; init; }

    public required bool HasCompleted { get; init; }

    public bool? Succeeded { get; init; }

    public required bool RequiresRestart { get; init; }

    public required bool CanAutoRestart { get; init; }

    public required string Message { get; init; }

    public required IReadOnlyList<string> LogLines { get; init; }

    public required DateTimeOffset UpdatedAt { get; init; }
}

public sealed record class InstallLocalDependenciesResponse
{
    public required bool Started { get; init; }

    public required string Message { get; init; }

    public required LocalDependenciesStateResponse Status { get; init; }
}

public sealed record class RestartApplicationResponse
{
    public required bool RestartScheduled { get; init; }

    public required string Message { get; init; }
}

public sealed record class ApplySetupRequest
{
    public required string StartupMode { get; init; }

    public bool UseDatabase { get; init; }

    public string? ConnectionString { get; init; }

    public string? SerialPort { get; init; }

    public bool RestartApplication { get; init; } = true;
}

public sealed record class ApplySetupResponse
{
    public required string StartupMode { get; init; }

    public required bool RestartScheduled { get; init; }

    public required string Message { get; init; }
}

public sealed record class SaveDeviceConfigurationRequest
{
    public IReadOnlyList<DeviceConfiguration> Devices { get; init; } = [];
}

public sealed record class DatabaseSettingsStateResponse
{
    public required int RawSecondsWindowMinutes { get; init; }

    public required int PersistedBucketMinutes { get; init; }
}

public sealed record class SaveDatabaseSettingsRequest
{
    public required int RawSecondsWindowMinutes { get; init; }

    public required int PersistedBucketMinutes { get; init; }

    public bool RestartApplication { get; init; } = true;
}

public sealed record class SaveDatabaseSettingsResponse
{
    public required bool RestartScheduled { get; init; }

    public required string Message { get; init; }

    public required DatabaseSettingsStateResponse Settings { get; init; }
}
