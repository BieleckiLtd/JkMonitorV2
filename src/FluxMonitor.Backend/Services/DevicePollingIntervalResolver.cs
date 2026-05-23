using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

public static class DevicePollingIntervalResolver
{
    public const int DefaultPollIntervalMilliseconds = 1000;

    public static int Resolve(DeviceDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);

        return definition.PollGroups.Values
            .Select(group => group.IntervalMs)
            .Where(intervalMs => intervalMs > 0)
            .DefaultIfEmpty(DefaultPollIntervalMilliseconds)
            .Min();
    }

    public static int Resolve(DeviceConfiguration device, DeviceDefinitionLoader definitionLoader, int fallback)
    {
        ArgumentNullException.ThrowIfNull(device);
        ArgumentNullException.ThrowIfNull(definitionLoader);

        if (device.TryResolveDefinition(definitionLoader, out var definition) &&
            definition is not null)
        {
            return Resolve(definition);
        }

        return fallback > 0 ? fallback : DefaultPollIntervalMilliseconds;
    }

    public static DeviceConfiguration Normalize(DeviceConfiguration device, DeviceDefinitionLoader definitionLoader)
    {
        ArgumentNullException.ThrowIfNull(device);
        ArgumentNullException.ThrowIfNull(definitionLoader);

        var resolvedInterval = Resolve(device, definitionLoader, device.PollIntervalMilliseconds);
        if (resolvedInterval == device.PollIntervalMilliseconds)
        {
            return device;
        }

        return new DeviceConfiguration
        {
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            SortOrder = device.SortOrder,
            DefinitionId = device.DefinitionId,
            TransportPortName = device.TransportPortName,
            BleSettingsPin = device.BleSettingsPin,
            HttpUsername = device.HttpUsername,
            HttpPassword = device.HttpPassword,
            Address = device.Address,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = resolvedInterval,
            Enabled = device.Enabled,
            CellVoltageSmoothingFactor = device.CellVoltageSmoothingFactor,
            CellVoltageSmoothingBreakoutMillivolts = device.CellVoltageSmoothingBreakoutMillivolts,
            DisplayPrecision = device.DisplayPrecision,
            TemperatureUnit = device.TemperatureUnit,
            HasDefinitionOverride = device.HasDefinitionOverride,
            DefinitionVersion = device.DefinitionVersion,
            DefinitionJson = device.DefinitionJson,
            DefinitionHash = device.DefinitionHash
        };
    }
}
