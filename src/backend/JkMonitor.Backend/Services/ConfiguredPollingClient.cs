using JkMonitor.Backend.Models;
using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public sealed class ConfiguredPollingClient(
    GenericModbusPollingClient genericPollingClient,
    DeviceDefinitionLoader definitionLoader,
    JkRs485PollingClient rs485PollingClient,
    IOptions<MonitorConfiguration> configuration) : IDevicePollingClient
{
    private readonly IReadOnlyDictionary<string, DeviceProfileConfiguration> _profiles =
        configuration.Value.DeviceProfiles.ToDictionary(p => p.ProfileId, StringComparer.OrdinalIgnoreCase);

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        // Prefer definition-driven polling when DefinitionId is configured
        if (!string.IsNullOrEmpty(device.DefinitionId) && definitionLoader.TryGet(device.DefinitionId, out var definition) && definition is not null)
        {
            return genericPollingClient.PollAsync(device, definition, cancellationToken);
        }

        // Fallback to legacy profile-based polling
        if (!_profiles.TryGetValue(device.ProfileId, out var profile))
        {
            throw new InvalidOperationException($"Device profile '{device.ProfileId}' is not defined in configuration.");
        }

        return profile.ProtocolHandler.ToLowerInvariant() switch
        {
            "jk-rs485" => rs485PollingClient.PollAsync(device, profile, cancellationToken),
            _ => throw new InvalidOperationException($"Unknown protocol handler '{profile.ProtocolHandler}' in profile '{profile.ProfileId}'.")
        };
    }
}