using System.Diagnostics;

namespace FluxMonitor.Backend.Services;

public sealed class RetentionBackgroundService(
    ITelemetryRepository repository,
    ILogger<RetentionBackgroundService> logger) : BackgroundService
{
    private static readonly TimeSpan RetentionInterval = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan SchedulerInterval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation(
            "Retention cleanup service started. RetentionInterval={RetentionInterval}, NightlyCompression=00:00 local time.",
            RetentionInterval);

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

        async Task RunNightlyCompressionAsync()
        {
            try
            {
                var stopwatch = Stopwatch.StartNew();
                await repository.CompressHistoricalDataAsync(stoppingToken);
                logger.LogInformation("Nightly compression sweep succeeded in {ElapsedMilliseconds} ms.", stopwatch.ElapsedMilliseconds);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Nightly compression sweep failed.");
            }
        }

        await SweepAsync();

        DateOnly? lastCompressionDate = null;
        var nextRetentionRunAt = DateTimeOffset.UtcNow.Add(RetentionInterval);
        using var timer = new PeriodicTimer(SchedulerInterval);

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

            var nowUtc = DateTimeOffset.UtcNow;
            if (nowUtc >= nextRetentionRunAt)
            {
                await SweepAsync();
                nextRetentionRunAt = nowUtc.Add(RetentionInterval);
            }

            var localNow = DateTimeOffset.Now;
            var localDate = DateOnly.FromDateTime(localNow.DateTime);
            if (localNow.Hour == 0 && localNow.Minute == 0 && lastCompressionDate != localDate)
            {
                await RunNightlyCompressionAsync();
                lastCompressionDate = localDate;
            }
        }
    }
}
