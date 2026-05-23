using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Models;

public sealed record class DeviceConfigurationApiModel
{
    public int? PersistedId { get; init; }

    public required string DeviceId { get; init; }

    public required string DisplayName { get; init; }

    public int SortOrder { get; init; }

    public required string DefinitionId { get; init; }

    public string? DefinitionVersion { get; init; }

    public string? TransportPortName { get; init; }

    public string? BleSettingsPin { get; init; }

    public string? HttpUsername { get; init; }

    public string? HttpPassword { get; init; }

    public byte Address { get; init; }

    public bool IsMaster { get; init; }

    public int PollIntervalMilliseconds { get; init; } = 1000;

    public bool Enabled { get; init; } = true;

    public decimal CellVoltageSmoothingFactor { get; init; }

    public int CellVoltageSmoothingBreakoutMillivolts { get; init; }

    public DisplayPrecisionConfiguration DisplayPrecision { get; init; } = new();

    public string TemperatureUnit { get; init; } = "c";

    public bool HasDefinitionOverride { get; init; }

    public DeviceDefinition? Definition { get; init; }
}

public sealed record class SaveDeviceConfigurationsRequest
{
    public IReadOnlyList<DeviceConfigurationApiModel> Devices { get; init; } = [];
}

public sealed record class DeviceConfigurationsResponse
{
    public required IReadOnlyList<DeviceConfigurationApiModel> Devices { get; init; }

    public IReadOnlyList<string> RememberedDeviceIds { get; init; } = [];
}

public sealed record class DeviceSummaryApiModel
{
    public required string DeviceId { get; init; }

    public required string DisplayName { get; init; }

    public int SortOrder { get; init; }

    public required string DefinitionId { get; init; }

    public bool Enabled { get; init; }
}

public sealed record class DeviceSummariesResponse
{
    public required IReadOnlyList<DeviceSummaryApiModel> Devices { get; init; }
}
