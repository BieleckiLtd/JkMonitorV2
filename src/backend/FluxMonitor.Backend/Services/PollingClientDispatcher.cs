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
    DeviceDefinitionLoader definitionLoader) : IDevicePollingClient
{
    private static readonly HashSet<string> SupportedTransports =
        new(StringComparer.OrdinalIgnoreCase) { "serial" };

    /// <summary>
    /// Returns true when the device's definition transport is handled by a registered client.
    /// </summary>
    public bool IsTransportSupported(DeviceConfiguration device)
    {
        if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
            return false;
        return SupportedTransports.Contains(definition.Connection.Transport.Type);
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
            _ => throw new NotSupportedException(
                $"Transport type '{transport}' is not supported. " +
                $"Device '{device.DeviceId}' cannot be polled until a '{transport}' polling client is implemented.")
        };
    }
}
