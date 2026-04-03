using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class TimescaleRetentionRollupTests
{
    // ── Retention configuration defaults ───────────────────────────────────

    [Fact]
    public void RetentionConfiguration_DefaultRawSeconds_Is10Minutes()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(10, retention.RawSecondsWindowMinutes);
    }

    [Fact]
    public void RetentionConfiguration_DefaultFiveMinuteWindow_Is365Days()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(365, retention.FiveMinuteWindowDays);
    }

    [Fact]
    public void RetentionConfiguration_DefaultPersistedBucketMinutes_Is5()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(5, retention.PersistedBucketMinutes);
    }

    // ── Rollup window alignment ────────────────────────────────────────────

    [Fact]
    public void AlignToBucketBoundaryFloor_1m_TruncatesToMinute()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 34, 56, TimeSpan.Zero);
        var aligned = TimescaleTelemetryRepository.AlignToBucketBoundaryFloor(input, "1m");
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 34, 0, TimeSpan.Zero), aligned);
    }

    [Fact]
    public void AlignToBucketBoundaryFloor_5m_TruncatesTo5Minutes()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 37, 12, TimeSpan.Zero);
        var aligned = TimescaleTelemetryRepository.AlignToBucketBoundaryFloor(input, "5m");
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 35, 0, TimeSpan.Zero), aligned);
    }

    [Fact]
    public void AlignToBucketBoundaryFloor_1h_TruncatesToHour()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 59, 59, TimeSpan.Zero);
        var aligned = TimescaleTelemetryRepository.AlignToBucketBoundaryFloor(input, "1h");
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 0, 0, TimeSpan.Zero), aligned);
    }

    [Fact]
    public void AlignToBucketBoundaryFloor_AlreadyAligned_ReturnsUnchanged()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 35, 0, TimeSpan.Zero);
        var aligned = TimescaleTelemetryRepository.AlignToBucketBoundaryFloor(input, "5m");
        Assert.Equal(input, aligned);
    }

    [Fact]
    public void AlignToBucketBoundaryFloor_15m_TruncatesToQuarterHour()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 37, 12, TimeSpan.Zero);
        var aligned = TimescaleTelemetryRepository.AlignToBucketBoundaryFloor(input, "15m");
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 30, 0, TimeSpan.Zero), aligned);
    }

    [Fact]
    public void AlignToBucketBoundaryCeiling_AlreadyAligned_ReturnsUnchanged()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 35, 0, TimeSpan.Zero);
        var ceiling = TimescaleTelemetryRepository.AlignToBucketBoundaryCeiling(input, "5m");
        Assert.Equal(input, ceiling);
    }

    [Fact]
    public void AlignToBucketBoundaryCeiling_Unaligned_RoundsUp()
    {
        var input = new DateTimeOffset(2025, 6, 15, 12, 36, 0, TimeSpan.Zero);
        var ceiling = TimescaleTelemetryRepository.AlignToBucketBoundaryCeiling(input, "5m");
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 40, 0, TimeSpan.Zero), ceiling);
    }

    // ── Rollup window computation ──────────────────────────────────────────

    [Fact]
    public void TryGetAlignedRollupWindow_ValidRange_ReturnsAlignedWindow()
    {
        var from = new DateTimeOffset(2025, 6, 15, 11, 0, 0, TimeSpan.Zero);
        var to = new DateTimeOffset(2025, 6, 15, 12, 0, 0, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "1m");

        Assert.NotNull(window);
        Assert.Equal(from, window.Value.FromInclusive);
        Assert.Equal(to, window.Value.ToExclusive);
    }

    [Fact]
    public void TryGetAlignedRollupWindow_FromAfterTo_ReturnsNull()
    {
        var from = new DateTimeOffset(2025, 6, 15, 12, 30, 0, TimeSpan.Zero);
        var to = new DateTimeOffset(2025, 6, 15, 12, 0, 0, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "1m");

        Assert.Null(window);
    }

    [Fact]
    public void TryGetAlignedRollupWindow_SameAligned_ReturnsNull()
    {
        var ts = new DateTimeOffset(2025, 6, 15, 12, 0, 0, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(ts, ts, "5m");

        Assert.Null(window);
    }

    [Fact]
    public void TryGetAlignedRollupWindow_UnalignedRange_AlignsEnds()
    {
        var from = new DateTimeOffset(2025, 6, 15, 12, 3, 0, TimeSpan.Zero);
        var to = new DateTimeOffset(2025, 6, 15, 12, 37, 0, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "5m");

        Assert.NotNull(window);
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 0, 0, TimeSpan.Zero), window.Value.FromInclusive);
        Assert.Equal(new DateTimeOffset(2025, 6, 15, 12, 35, 0, TimeSpan.Zero), window.Value.ToExclusive);
    }

    [Fact]
    public void TryGetAlignedRollupWindow_NarrowGap_Within5mBucket_ReturnsNull()
    {
        var from = new DateTimeOffset(2025, 6, 15, 12, 36, 0, TimeSpan.Zero);
        var to = new DateTimeOffset(2025, 6, 15, 12, 38, 0, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "5m");

        Assert.Null(window);
    }

    [Fact]
    public void ShouldFlushActiveBucket_ReturnsFalse_BelowThreshold()
    {
        var now = new DateTimeOffset(2025, 6, 15, 12, 37, 14, TimeSpan.Zero);

        var shouldFlush = TimescaleTelemetryRepository.ShouldFlushActiveBucket(now, "5m", 0.45);

        Assert.False(shouldFlush);
    }

    [Fact]
    public void ShouldFlushActiveBucket_ReturnsTrue_AtThreshold()
    {
        var now = new DateTimeOffset(2025, 6, 15, 12, 37, 15, TimeSpan.Zero);

        var shouldFlush = TimescaleTelemetryRepository.ShouldFlushActiveBucket(now, "5m", 0.45);

        Assert.True(shouldFlush);
    }

    // ── ConvertDatabaseScalarToInt64 ───────────────────────────────────────

    [Theory]
    [InlineData(null, 0L)]
    public void ConvertDatabaseScalarToInt64_Null_ReturnsZero(object? input, long expected)
    {
        Assert.Equal(expected, TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(input));
    }

    [Fact]
    public void ConvertDatabaseScalarToInt64_DBNull_ReturnsZero()
    {
        Assert.Equal(0L, TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(DBNull.Value));
    }

    [Fact]
    public void ConvertDatabaseScalarToInt64_Long_ReturnsValue()
    {
        Assert.Equal(42L, TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(42L));
    }

    [Fact]
    public void ConvertDatabaseScalarToInt64_Int_ReturnsValue()
    {
        Assert.Equal(42L, TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(42));
    }

    [Fact]
    public void ConvertDatabaseScalarToInt64_Decimal_ReturnsValue()
    {
        Assert.Equal(42L, TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(42m));
    }

    [Fact]
    public void ConvertDatabaseScalarToInt64_Double_ReturnsValue()
    {
        Assert.Equal(42L, TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(42.0));
    }

    // ── NoOp repository ────────────────────────────────────────────────────

    [Fact]
    public async Task NoOpTelemetryRepository_ApplyRetention_Completes()
    {
        var repo = new NoOpTelemetryRepository();
        await repo.ApplyRetentionAsync(CancellationToken.None);
    }

    [Fact]
    public async Task NoOpTelemetryRepository_GetDatabaseSize_ReturnsZero()
    {
        var repo = new NoOpTelemetryRepository();
        var result = await repo.GetDatabaseSizeAsync(CancellationToken.None);
        Assert.Equal(0, result.TotalSizeBytes);
    }

    [Fact]
    public async Task NoOpTelemetryRepository_GetCompressionStats_ReturnsNull()
    {
        var repo = new NoOpTelemetryRepository();
        var result = await repo.GetCompressionStatsAsync(CancellationToken.None);
        Assert.Null(result);
    }

    // ── CompressionConfiguration defaults ──────────────────────────────────

    [Fact]
    public void CompressionConfiguration_DefaultCompressAfterMinutes_Is60()
    {
        var config = new CompressionConfiguration();
        Assert.Equal(60, config.CompressAfterMinutes);
    }

    [Fact]
    public void StorageConfiguration_DefaultCompressionIsNotNull()
    {
        var storage = new StorageConfiguration
        {
            Provider = "TimescaleDb",
            ConnectionString = "Host=localhost;",
            Retention = new RetentionConfiguration()
        };

        Assert.NotNull(storage.Compression);
        Assert.Equal(60, storage.Compression.CompressAfterMinutes);
    }

    [Fact]
    public void CompressionConfiguration_CanBeSetToZero()
    {
        var config = new CompressionConfiguration { CompressAfterMinutes = 0 };
        Assert.Equal(0, config.CompressAfterMinutes);
    }

    [Fact]
    public void CompressionConfiguration_CanBeSetToCustomValue()
    {
        var config = new CompressionConfiguration { CompressAfterMinutes = 120 };
        Assert.Equal(120, config.CompressAfterMinutes);
    }

    // ── SQL generation ─────────────────────────────────────────────────────

    [Fact]
    public void BuildEnableCompressionSql_ContainsTimescaleCompress()
    {
        var sql = TimescaleTelemetryRepository.BuildEnableCompressionSql();
        Assert.Contains("timescaledb.compress", sql);
    }

    [Fact]
    public void BuildEnableCompressionSql_SegmentsByDeviceIdAndSensorName()
    {
        var sql = TimescaleTelemetryRepository.BuildEnableCompressionSql();
        Assert.Contains(@"""DeviceId""", sql);
        Assert.Contains(@"""SensorName""", sql);
        Assert.Contains("compress_segmentby", sql);
    }

    [Fact]
    public void BuildEnableCompressionSql_OrdersByTimeDesc()
    {
        var sql = TimescaleTelemetryRepository.BuildEnableCompressionSql();
        Assert.Contains(@"""Time"" DESC", sql);
        Assert.Contains("compress_orderby", sql);
    }

    [Fact]
    public void BuildEnableCompressionSql_TargetsMeasurementsTable()
    {
        var sql = TimescaleTelemetryRepository.BuildEnableCompressionSql();
        Assert.Contains(@"""Measurements""", sql);
    }

    [Fact]
    public void BuildCompressionPolicySql_ContainsConfiguredInterval()
    {
        var sql = TimescaleTelemetryRepository.BuildCompressionPolicySql(60);
        Assert.Contains("INTERVAL '60 minutes'", sql);
    }

    [Fact]
    public void BuildCompressionPolicySql_CustomInterval()
    {
        var sql = TimescaleTelemetryRepository.BuildCompressionPolicySql(120);
        Assert.Contains("INTERVAL '120 minutes'", sql);
    }

    [Fact]
    public void BuildCompressionPolicySql_RemovesExistingPolicyFirst()
    {
        var sql = TimescaleTelemetryRepository.BuildCompressionPolicySql(60);

        var removeIndex = sql.IndexOf("remove_compression_policy", StringComparison.Ordinal);
        var addIndex = sql.IndexOf("add_compression_policy", StringComparison.Ordinal);

        Assert.True(removeIndex >= 0, "SQL should contain remove_compression_policy");
        Assert.True(addIndex >= 0, "SQL should contain add_compression_policy");
        Assert.True(removeIndex < addIndex, "remove_compression_policy must run before add_compression_policy");
    }

    [Fact]
    public void BuildCompressionPolicySql_RemovesWithIfExists()
    {
        var sql = TimescaleTelemetryRepository.BuildCompressionPolicySql(60);
        Assert.Contains("if_exists => true", sql);
    }

    [Fact]
    public void BuildCompressionPolicySql_TargetsMeasurementsTable()
    {
        var sql = TimescaleTelemetryRepository.BuildCompressionPolicySql(60);
        Assert.Contains(@"""Measurements""", sql);
    }

    // ── CompressionStats record ────────────────────────────────────────────

    [Fact]
    public void CompressionStats_CalculatesRatio()
    {
        var stats = new CompressionStats(
            TotalChunks: 10,
            CompressedChunks: 8,
            UncompressedChunks: 2,
            UncompressedSizeBytes: 2_000_000_000,
            UncompressedSizeFormatted: "1.9 GB",
            CompressedSizeBytes: 200_000_000,
            CompressedSizeFormatted: "190.7 MB",
            CompressionRatio: 10.0);

        Assert.Equal(10, stats.TotalChunks);
        Assert.Equal(8, stats.CompressedChunks);
        Assert.Equal(2, stats.UncompressedChunks);
        Assert.Equal(10.0, stats.CompressionRatio);
    }

    [Fact]
    public void CompressionStats_ZeroCompressedBytes_HasZeroRatio()
    {
        var stats = new CompressionStats(
            TotalChunks: 5,
            CompressedChunks: 0,
            UncompressedChunks: 5,
            UncompressedSizeBytes: 0,
            UncompressedSizeFormatted: "0 B",
            CompressedSizeBytes: 0,
            CompressedSizeFormatted: "0 B",
            CompressionRatio: 0);

        Assert.Equal(0, stats.CompressedChunks);
        Assert.Equal(0, stats.CompressionRatio);
    }

    // ── Full configuration binding ─────────────────────────────────────────

    [Fact]
    public void StorageConfiguration_CompressionOverride_IsRespected()
    {
        var storage = new StorageConfiguration
        {
            Provider = "TimescaleDb",
            ConnectionString = "Host=localhost;",
            Retention = new RetentionConfiguration(),
            Compression = new CompressionConfiguration { CompressAfterMinutes = 30 }
        };

        Assert.Equal(30, storage.Compression.CompressAfterMinutes);
    }

    [Fact]
    public void StorageConfiguration_DisabledCompression()
    {
        var storage = new StorageConfiguration
        {
            Provider = "TimescaleDb",
            ConnectionString = "Host=localhost;",
            Retention = new RetentionConfiguration(),
            Compression = new CompressionConfiguration { CompressAfterMinutes = 0 }
        };

        Assert.Equal(0, storage.Compression.CompressAfterMinutes);
    }
}
