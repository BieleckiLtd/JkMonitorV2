using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class RetentionBackgroundServiceTests
{
    [Fact]
    public async Task ExecuteAsync_LogsSuccessfulSweepAtInformation()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var logger = new TestLogger<RetentionBackgroundService>();
        var service = new RetentionBackgroundService(new NoOpTelemetryRepository(), logger);

        await service.StartAsync(cancellationToken);

        var completed = await Task.WhenAny(
            logger.SuccessfulSweepTask,
            Task.Delay(TimeSpan.FromSeconds(2), cancellationToken));

        await service.StopAsync(cancellationToken);

        Assert.Same(logger.SuccessfulSweepTask, completed);
        Assert.Equal(LogLevel.Information, await logger.SuccessfulSweepTask);
    }

    private sealed class TestLogger<T> : ILogger<T>
    {
        private readonly TaskCompletionSource<LogLevel> _successfulSweep =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<LogLevel> SuccessfulSweepTask => _successfulSweep.Task;

        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            var message = formatter(state, exception);
            if (message.Contains("Retention sweep succeeded", StringComparison.Ordinal))
            {
                _successfulSweep.TrySetResult(logLevel);
            }
        }

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }
}
