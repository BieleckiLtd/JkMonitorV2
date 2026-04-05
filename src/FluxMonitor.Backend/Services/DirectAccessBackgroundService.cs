using Microsoft.Extensions.Hosting;

namespace FluxMonitor.Backend.Services;

public sealed class DirectAccessBackgroundService(
    DirectAccessService directAccessService,
    ILogger<DirectAccessBackgroundService> logger) : BackgroundService
{
    private static readonly TimeSpan ReconciliationInterval = TimeSpan.FromSeconds(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(ReconciliationInterval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await directAccessService.ReconcileDesiredStateAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                logger.LogDebug(exception, "Local access reconciliation loop failed.");
            }

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
        }
    }
}
