using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Routes poll requests to the correct client based on the device definition's transport type.
/// </summary>
public sealed class PollingClientDispatcher(
    GenericSerialPollingClient serialClient,
    GenericBlePollingClient bleClient,
    GenericBleAdvertisementPollingClient bleAdvertisementClient,
    DeviceDefinitionLoader definitionLoader) : IDevicePollingClient
{
    private static readonly HashSet<string> SupportedTransports =
        new(StringComparer.OrdinalIgnoreCase) { "serial", "ble" };

    public static bool IsTransportSupported(string? transportType)
        => !string.IsNullOrWhiteSpace(transportType) && SupportedTransports.Contains(transportType);

    public static string GetUnsupportedTransportMessage(string? transportType)
    {
        if (string.IsNullOrWhiteSpace(transportType))
            return "Transport type is not defined.";

        return $"Transport type '{transportType}' is not supported yet. " +
               $"This build currently supports: {string.Join(", ", SupportedTransports)}.";
    }

    public bool IsDefinitionSupported(FluxMonitor.Contracts.DeviceDefinition.DeviceDefinition definition)
    {
        var transportType = definition.Connection.Transport.Type;
        if (!IsTransportSupported(transportType))
            return false;

        if (!string.Equals(transportType, "ble", StringComparison.OrdinalIgnoreCase))
            return true;

        return string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase)
            ? GenericBleAdvertisementPollingClient.IsDefinitionSupported(definition)
            : GenericBlePollingClient.IsDefinitionSupported(definition);
    }

    public string? GetUnsupportedDefinitionMessage(FluxMonitor.Contracts.DeviceDefinition.DeviceDefinition definition)
    {
        var transportType = definition.Connection.Transport.Type;
        if (!IsTransportSupported(transportType))
            return GetUnsupportedTransportMessage(transportType);

        if (string.Equals(transportType, "ble", StringComparison.OrdinalIgnoreCase))
        {
            return string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase)
                ? GenericBleAdvertisementPollingClient.GetUnsupportedDefinitionMessage(definition)
                : GenericBlePollingClient.GetUnsupportedDefinitionMessage(definition);
        }

        return null;
    }

    /// <summary>
    /// Returns true when the device's definition transport is handled by a registered client.
    /// </summary>
    public bool IsTransportSupported(DeviceConfiguration device)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
            return false;
        return IsDefinitionSupported(definition);
    }

    public string? GetUnsupportedTransportMessage(DeviceConfiguration device)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
            return $"Device definition '{device.DefinitionId}' was not found.";

        return GetUnsupportedDefinitionMessage(definition);
    }

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
            throw new InvalidOperationException(
                $"Device '{device.DeviceId}' has no valid DefinitionId ('{device.DefinitionId}').");

        var transport = definition.Connection.Transport.Type;

        return transport switch
        {
            "serial" => serialClient.PollAsync(device, definition, cancellationToken),
            "ble" when string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase) &&
                       GenericBleAdvertisementPollingClient.IsDefinitionSupported(definition)
                => bleAdvertisementClient.PollAsync(device, definition, cancellationToken),
            "ble" when GenericBlePollingClient.IsDefinitionSupported(definition)
                => bleClient.PollAsync(device, definition, cancellationToken),
            _ => throw new NotSupportedException(
                $"Device '{device.DeviceId}' cannot be polled: " +
                $"{GetUnsupportedDefinitionMessage(definition) ?? $"transport '{transport}' is not supported."}")
        };
    }
}
