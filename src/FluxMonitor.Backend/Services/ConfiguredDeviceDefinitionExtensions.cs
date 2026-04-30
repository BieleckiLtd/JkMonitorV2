using System.Text.Json;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

public static class ConfiguredDeviceDefinitionExtensions
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    public static bool TryResolveDefinition(
        this DeviceConfiguration device,
        DeviceDefinitionLoader definitionLoader,
        out DeviceDefinition? definition)
    {
        ArgumentNullException.ThrowIfNull(device);
        ArgumentNullException.ThrowIfNull(definitionLoader);

        // Use the latest catalog definition immediately unless this device has an
        // explicit per-device override snapshot. That keeps shipped definition
        // fixes active without waiting for snapshot reconciliation.
        if (!device.HasDefinitionOverride &&
            !string.IsNullOrWhiteSpace(device.DefinitionId) &&
            definitionLoader.TryGet(device.DefinitionId, out definition) &&
            definition is not null)
        {
            return true;
        }

        if (!string.IsNullOrWhiteSpace(device.DefinitionJson))
        {
            try
            {
                definition = JsonSerializer.Deserialize<DeviceDefinition>(device.DefinitionJson, JsonOptions);
                if (definition is not null)
                {
                    return true;
                }
            }
            catch (JsonException)
            {
                // Fall back to the shared definition catalog if the stored snapshot is invalid.
            }
        }

        if (!string.IsNullOrWhiteSpace(device.DefinitionId) &&
            definitionLoader.TryGet(device.DefinitionId, out definition) &&
            definition is not null)
        {
            return true;
        }

        definition = null;
        return false;
    }

    public static DeviceDefinition ResolveDefinition(
        this DeviceConfiguration device,
        DeviceDefinitionLoader definitionLoader)
    {
        if (device.TryResolveDefinition(definitionLoader, out var definition) && definition is not null)
        {
            return definition;
        }

        throw new InvalidOperationException(
            $"Device '{device.DeviceId}' has no usable definition snapshot for '{device.DefinitionId}'.");
    }
}
