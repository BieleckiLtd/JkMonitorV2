namespace JkMonitor.Backend.Services;

public sealed class RetentionBackgroundService(
    ITelemetryRepository repository,
    ILogger<RetentionBackgroundService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Retention cleanup service started (interval: {Interval}).", Interval);

        using var timer = new PeriodicTimer(Interval);

        while (!stoppingToken.IsCancellationRequested)
        {
            if (!await timer.WaitForNextTickAsync(stoppingToken)) break;

            try
            {
                if (repository is SqliteTelemetryRepository sqlite)
                {
                    await sqlite.ApplyRetentionAsync(stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Retention sweep failed.");
            }
        }
    }
}
