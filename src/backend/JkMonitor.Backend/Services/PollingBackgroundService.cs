using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public sealed class PollingBackgroundService(
    IOptions<MonitorConfiguration> configuration,
    IDevicePollingClient pollingClient,
    ITelemetryRepository telemetryRepository,
    DeviceStateStore stateStore,
    PollTrigger pollTrigger,
    ILogger<PollingBackgroundService> logger) : BackgroundService
{
    private readonly MonitorConfiguration _configuration = configuration.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Polling background service started with {DeviceCount} configured devices.", _configuration.Devices.Count);

        var tasks = _configuration.Devices
            .Where(device => device.Enabled)
            .Select(device => RunDeviceLoopAsync(device, stoppingToken))
            .ToArray();

        await Task.WhenAll(tasks);
    }

    private async Task RunDeviceLoopAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(device.PollIntervalMilliseconds));

        while (!cancellationToken.IsCancellationRequested)
        {
            var startedAt = DateTimeOffset.UtcNow;
            stateStore.MarkPollStarted(device, startedAt);

            try
            {
                logger.LogDebug("Polling device {DeviceId} using profile {ProfileId}.", device.DeviceId, device.ProfileId);

                var sample = await pollingClient.PollAsync(device, cancellationToken);
                DateTimeOffset? persistedAt = null;
                var outcome = "Succeeded";
                string? persistenceError = null;

                try
                {
                    await telemetryRepository.PersistAsync(device, sample, cancellationToken);
                    persistedAt = DateTimeOffset.UtcNow;
                }
                catch (Exception exception)
                {
                    outcome = "PersistFailed";
                    persistenceError = exception.Message;
                    logger.LogError(exception, "Telemetry persistence failed for device {DeviceId}.", device.DeviceId);
                }

                stateStore.MarkPollCompleted(device, startedAt, DateTimeOffset.UtcNow, sample.Snapshot, persistedAt, outcome, persistenceError);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                stateStore.MarkPollFailed(device, startedAt, exception);
                logger.LogError(exception, "Polling failed for device {DeviceId}.", device.DeviceId);
            }

            try
            {
                await Task.WhenAny(
                    timer.WaitForNextTickAsync(cancellationToken).AsTask(),
                    Task.Delay(Timeout.Infinite, pollTrigger.GetToken()));
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // PollTrigger signalled – run next poll immediately.
            }
        }
    }
}
