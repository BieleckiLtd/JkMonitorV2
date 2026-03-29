using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Services;

public interface IDevicePollingClient
{
    Task<Models.DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken);
}
