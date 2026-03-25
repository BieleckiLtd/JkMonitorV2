using JkMonitor.Contracts.Configuration;

namespace JkMonitor.Backend.Services;

public interface IDevicePollingClient
{
    Task<Models.DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken);
}
