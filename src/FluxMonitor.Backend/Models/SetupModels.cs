using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Models;

public sealed record class SetupStateResponse
{
    public required string CurrentStartupMode { get; init; }

    public required string EnvironmentName { get; init; }

    public required bool UseDatabase { get; init; }

    public string? ConnectionString { get; init; }

    public string? SerialPort { get; init; }

    public required IReadOnlyList<string> SerialPorts { get; init; }

    public required bool CanAutoRestart { get; init; }

    public required string ApplyMessage { get; init; }
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