using System.Text.Json;
using System.Text.Json.Serialization;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

internal static class DeviceConfigurationApiMapper
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    public static DeviceConfigurationApiModel ToApiModel(
        DeviceConfiguration device,
        int? persistedId,
        DeviceDefinition? definition)
    {
        return new DeviceConfigurationApiModel
        {
            PersistedId = persistedId,
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            SortOrder = device.SortOrder,
            DefinitionId = device.DefinitionId,
            DefinitionVersion = device.DefinitionVersion,
            TransportPortName = device.TransportPortName,
            BleSettingsPin = device.BleSettingsPin,
            ProtocolUserId = device.ProtocolUserId,
            HttpUsername = device.HttpUsername,
            HttpPassword = device.HttpPassword,
            Address = device.Address,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            Enabled = device.Enabled,
            CellVoltageSmoothingFactor = device.CellVoltageSmoothingFactor,
            CellVoltageSmoothingBreakoutMillivolts = device.CellVoltageSmoothingBreakoutMillivolts,
            DisplayPrecision = device.DisplayPrecision,
            TemperatureUnit = device.TemperatureUnit,
            HasDefinitionOverride = device.HasDefinitionOverride,
            Definition = definition
        };
    }

    public static DeviceConfiguration ToConfiguration(DeviceConfigurationApiModel device)
    {
        return new DeviceConfiguration
        {
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            SortOrder = device.SortOrder,
            DefinitionId = device.DefinitionId,
            DefinitionVersion = device.DefinitionVersion,
            TransportPortName = device.TransportPortName,
            BleSettingsPin = device.BleSettingsPin,
            ProtocolUserId = device.ProtocolUserId,
            HttpUsername = device.HttpUsername,
            HttpPassword = device.HttpPassword,
            Address = device.Address,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            Enabled = device.Enabled,
            CellVoltageSmoothingFactor = device.CellVoltageSmoothingFactor,
            CellVoltageSmoothingBreakoutMillivolts = device.CellVoltageSmoothingBreakoutMillivolts,
            DisplayPrecision = device.DisplayPrecision,
            TemperatureUnit = device.TemperatureUnit,
            DefinitionJson = SerializeDefinition(device.Definition)
        };
    }

    private static string SerializeDefinition(DeviceDefinition? definition)
        => definition is null ? string.Empty : JsonSerializer.Serialize(definition, JsonOptions);
}
