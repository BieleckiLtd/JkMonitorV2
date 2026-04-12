using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class TelemetryShutdownFlushServiceTests
{
    [Fact]
    public async Task StopAsync_FlushesBufferedTelemetryIncludingActiveBucket()
    {
        var repository = new TestTelemetryRepository();
        var service = new TelemetryShutdownFlushService(
            repository,
            NullLogger<TelemetryShutdownFlushService>.Instance);

        await service.StopAsync(TestContext.Current.CancellationToken);

        Assert.True(repository.FlushCalled);
        Assert.True(repository.IncludeActiveBucket);
    }

    private sealed class TestTelemetryRepository : ITelemetryRepository
    {
        public bool FlushCalled { get; private set; }

        public bool IncludeActiveBucket { get; private set; }

        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task ApplyDatabaseSettingsAsync(
            int rawSecondsWindowMinutes,
            int persistedBucketMinutes,
            CancellationToken cancellationToken)
            => Task.CompletedTask;

        public Task CompressHistoricalDataAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, BucketValueKind bucketValueKind, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<HistoryDataPoint>>([]);

        public Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, BucketValueKind bucketValueKind, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<CellHistoryDataPoint>>([]);

        public Task<IReadOnlyList<SeriesHistoryDataPoint>> QuerySeriesHistoryAsync(
            string deviceId,
            IReadOnlyList<string> sensorNames,
            string resolution,
            BucketValueKind bucketValueKind,
            DateTimeOffset from,
            DateTimeOffset to,
            CancellationToken cancellationToken)
            => Task.FromResult<IReadOnlyList<SeriesHistoryDataPoint>>([]);

        public Task ApplyRetentionAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task FlushBufferedAsync(bool includeActiveBucket, CancellationToken cancellationToken)
        {
            FlushCalled = true;
            IncludeActiveBucket = includeActiveBucket;
            return Task.CompletedTask;
        }

        public Task<CompressionStats?> GetCompressionStatsAsync(CancellationToken cancellationToken)
            => Task.FromResult<CompressionStats?>(null);

        public Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken)
            => Task.FromResult(new DatabaseSizeInfo(0, "0 B", []));

        public Task ExportAsync(Stream destination, CancellationToken cancellationToken) => Task.CompletedTask;

        public Task ImportAsync(Stream source, CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
