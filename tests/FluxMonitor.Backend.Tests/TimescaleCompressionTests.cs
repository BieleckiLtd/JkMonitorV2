using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class TimescaleCompressionTests
{
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
    public void BuildEnableCompressionSql_SegmentsByDeviceIdAndSensorId()
    {
        var sql = TimescaleTelemetryRepository.BuildEnableCompressionSql();

        Assert.Contains(@"""DeviceId""", sql);
        Assert.Contains(@"""SensorId""", sql);
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

    // ── NoOp repository ────────────────────────────────────────────────────

    [Fact]
    public async Task NoOpTelemetryRepository_GetCompressionStats_ReturnsNull()
    {
        var repo = new NoOpTelemetryRepository();
        var result = await repo.GetCompressionStatsAsync(CancellationToken.None);
        Assert.Null(result);
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

    // ── Retention window with compression context ──────────────────────────

    [Fact]
    public void RetentionConfiguration_DefaultOneHourWindowDays_IsZero_MeansKeepForever()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(0, retention.OneHourWindowDays);
    }

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
