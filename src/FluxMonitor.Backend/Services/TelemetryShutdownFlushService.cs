namespace FluxMonitor.Backend.Services;

public sealed class TelemetryShutdownFlushService(
    ITelemetryRepository repository,
    ILogger<TelemetryShutdownFlushService> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            await repository.FlushBufferedAsync(includeActiveBucket: true, cancellationToken);
            logger.LogInformation("Buffered telemetry flush completed during shutdown.");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning("Buffered telemetry flush was canceled during shutdown.");
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Buffered telemetry flush failed during shutdown.");
        }
    }
}
