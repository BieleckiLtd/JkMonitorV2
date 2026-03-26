namespace JkMonitor.Backend.Services;

public sealed class PollingBackgroundService(
    DeviceConfigStore deviceConfigStore,
    DeviceOrchestrator orchestrator,
    ILogger<PollingBackgroundService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var devices = deviceConfigStore.GetDevices();
        logger.LogInformation("Polling background service started with {DeviceCount} configured devices.", devices.Count);

        await orchestrator.ApplyConfigurationAsync(devices, stoppingToken);

        // Keep running until the application shuts down
        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Expected on shutdown
        }

        await orchestrator.StopAllAsync();
        logger.LogInformation("Polling background service stopped.");
    }
}
