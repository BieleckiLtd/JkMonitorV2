using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Routes poll requests to the correct client based on the device definition's transport type.
/// Currently supported: "serial" → GenericModbusPollingClient.
/// Other transports (e.g. "ble") will throw <see cref="NotSupportedException"/> until a
/// dedicated client is registered.
/// </summary>
public sealed class PollingClientDispatcher(
    GenericModbusPollingClient modbusClient,
    GenericBlePollingClient bleClient,
    DeviceDefinitionLoader definitionLoader) : IDevicePollingClient
{
    private static readonly HashSet<string> SupportedTransports =
        new(StringComparer.OrdinalIgnoreCase) { "serial", "ble" };

    private static readonly HashSet<string> SupportedBleProtocols =
        new(StringComparer.OrdinalIgnoreCase) { "jk-bms-ble" };

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

        return !string.Equals(transportType, "ble", StringComparison.OrdinalIgnoreCase) ||
               SupportedBleProtocols.Contains(definition.Connection.Protocol.Type);
    }

    public string? GetUnsupportedDefinitionMessage(FluxMonitor.Contracts.DeviceDefinition.DeviceDefinition definition)
    {
        var transportType = definition.Connection.Transport.Type;
        if (!IsTransportSupported(transportType))
            return GetUnsupportedTransportMessage(transportType);

        if (string.Equals(transportType, "ble", StringComparison.OrdinalIgnoreCase) &&
            !SupportedBleProtocols.Contains(definition.Connection.Protocol.Type))
        {
            return $"BLE protocol '{definition.Connection.Protocol.Type}' is not supported yet. " +
                   $"This build currently supports BLE protocols: {string.Join(", ", SupportedBleProtocols)}.";
        }

        return null;
    }

    /// <summary>
    /// Returns true when the device's definition transport is handled by a registered client.
    /// </summary>
    public bool IsTransportSupported(DeviceConfiguration device)
    {
        if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
            return false;
        return IsDefinitionSupported(definition);
    }

    public string? GetUnsupportedTransportMessage(DeviceConfiguration device)
    {
        if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
            return $"Device definition '{device.DefinitionId}' was not found.";

        return GetUnsupportedDefinitionMessage(definition);
    }

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
            throw new InvalidOperationException(
                $"Device '{device.DeviceId}' has no valid DefinitionId ('{device.DefinitionId}').");

        var transport = definition.Connection.Transport.Type;

        return transport switch
        {
            "serial" => modbusClient.PollAsync(device, definition, cancellationToken),
            "ble" when SupportedBleProtocols.Contains(definition.Connection.Protocol.Type)
                => bleClient.PollAsync(device, definition, cancellationToken),
            _ => throw new NotSupportedException(
                $"Device '{device.DeviceId}' cannot be polled: " +
                $"{GetUnsupportedDefinitionMessage(definition) ?? $"transport '{transport}' is not supported."}")
        };
    }
}
