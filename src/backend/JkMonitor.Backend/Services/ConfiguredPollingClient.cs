using JkMonitor.Contracts.Configuration;
using JkMonitor.Backend.Protocol;

namespace JkMonitor.Backend.Services;

public sealed class ConfiguredPollingClient(
    JkRs485PollingClient rs485PollingClient,
    SimulatedJkPollingClient simulatedPollingClient) : IJkPollingClient
{
    public Task<JkParsedSample> PollAsync(BmsDeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (string.Equals(device.Protocol, "jk-rs485-simulated", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(device.Protocol, "simulated", StringComparison.OrdinalIgnoreCase))
        {
            return simulatedPollingClient.PollAsync(device, cancellationToken);
        }

        return rs485PollingClient.PollAsync(device, cancellationToken);
    }
}