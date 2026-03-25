using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public sealed class PollingBackgroundService(
    IOptions<MonitorConfiguration> configuration,
    DeviceOrchestrator orchestrator,
    ILogger<PollingBackgroundService> logger) : BackgroundService
{
    private readonly MonitorConfiguration _configuration = configuration.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Polling background service started with {DeviceCount} configured devices.", _configuration.Devices.Count);

        await orchestrator.ApplyConfigurationAsync(_configuration.Devices, stoppingToken);

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
