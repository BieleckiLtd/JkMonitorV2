using System.Diagnostics;

namespace FluxMonitor.Backend.Services;

public sealed class RetentionBackgroundService(
    ITelemetryRepository repository,
    ILogger<RetentionBackgroundService> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Retention cleanup service started (interval: {Interval}).", Interval);

        async Task SweepAsync()
        {
            try
            {
                var stopwatch = Stopwatch.StartNew();
                await repository.ApplyRetentionAsync(stoppingToken);
                logger.LogInformation("Retention sweep succeeded in {ElapsedMilliseconds} ms.", stopwatch.ElapsedMilliseconds);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Retention sweep failed.");
            }
        }

        await SweepAsync();

        using var timer = new PeriodicTimer(Interval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (!await timer.WaitForNextTickAsync(stoppingToken))
                {
                    break;
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }

            await SweepAsync();
        }
    }
}
