namespace FluxMonitor.Backend.Services;

public sealed class RuntimeStatusStreamingService(
    IHostEnvironment environment,
    DeviceStateStore stateStore,
    RuntimeStatusBroadcaster runtimeStatusBroadcaster,
    ILogger<RuntimeStatusStreamingService> logger) : BackgroundService
{
    private static readonly TimeSpan PublishInterval = TimeSpan.FromMilliseconds(500);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(PublishInterval);

        logger.LogInformation("Runtime status streaming service started. PublishIntervalMs={PublishIntervalMs}.", PublishInterval.TotalMilliseconds);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                runtimeStatusBroadcaster.Publish(stateStore.GetStatus(environment.EnvironmentName));
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Failed to publish runtime status snapshot.");
            }

            try
            {
                var hasNextTick = await timer.WaitForNextTickAsync(stoppingToken);
                if (!hasNextTick)
                {
                    break;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }

        logger.LogInformation("Runtime status streaming service stopped.");
    }
}
