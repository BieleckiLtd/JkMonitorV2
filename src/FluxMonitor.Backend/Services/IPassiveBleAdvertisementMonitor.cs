using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Runs a passive BLE advertisement listener for a configured device until the
/// caller cancels the operation.
/// </summary>
public interface IPassiveBleAdvertisementMonitor
{
    Task RunAsync(DeviceConfiguration device, CancellationToken cancellationToken);
}
