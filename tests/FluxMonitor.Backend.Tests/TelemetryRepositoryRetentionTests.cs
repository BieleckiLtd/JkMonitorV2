using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class TelemetryRepositoryRetentionTests
{
    [Fact]
    public void TryGetAlignedRollupWindow_MinuteResolution_UsesWholeMinuteBuckets()
    {
        var from = new DateTimeOffset(2026, 4, 1, 12, 43, 27, TimeSpan.Zero);
        var to = new DateTimeOffset(2026, 4, 1, 13, 33, 27, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "1m");

        Assert.NotNull(window);
        Assert.Equal(new DateTimeOffset(2026, 4, 1, 12, 43, 0, TimeSpan.Zero), window!.Value.FromInclusive);
        Assert.Equal(new DateTimeOffset(2026, 4, 1, 13, 33, 0, TimeSpan.Zero), window.Value.ToExclusive);
    }

    [Fact]
    public void TryGetAlignedRollupWindow_FiveMinuteResolution_UsesWholeFiveMinuteBuckets()
    {
        var from = new DateTimeOffset(2026, 4, 1, 12, 43, 27, TimeSpan.Zero);
        var to = new DateTimeOffset(2026, 4, 1, 13, 33, 27, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "5m");

        Assert.NotNull(window);
        Assert.Equal(new DateTimeOffset(2026, 4, 1, 12, 40, 0, TimeSpan.Zero), window!.Value.FromInclusive);
        Assert.Equal(new DateTimeOffset(2026, 4, 1, 13, 30, 0, TimeSpan.Zero), window.Value.ToExclusive);
    }

    [Fact]
    public void TryGetAlignedRollupWindow_ReturnsNull_WhenNoWholeBucketFits()
    {
        var from = new DateTimeOffset(2026, 4, 1, 12, 43, 27, TimeSpan.Zero);
        var to = new DateTimeOffset(2026, 4, 1, 12, 43, 50, TimeSpan.Zero);

        var window = TimescaleTelemetryRepository.TryGetAlignedRollupWindow(from, to, "1m");

        Assert.Null(window);
    }

    [Fact]
    public void ConvertDatabaseScalarToInt64_HandlesDecimalResults()
    {
        var value = TimescaleTelemetryRepository.ConvertDatabaseScalarToInt64(2048m);

        Assert.Equal(2048L, value);
    }

    [Fact]
    public void BuildDeleteOlderThanSql_ForMeasurements_UsesPrimaryKeyBatchDelete()
    {
        var sql = TimescaleTelemetryRepository.BuildDeleteOlderThanSql("Measurements", "Time");

        Assert.Contains(@"""Time""", sql);
        Assert.Contains(@"""SensorId""", sql);
        Assert.DoesNotContain("ctid", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildDeleteOlderThanSql_ForOtherTables_UsesCtidBatchDelete()
    {
        var sql = TimescaleTelemetryRepository.BuildDeleteOlderThanSql("Devices", "UpdatedAt");

        Assert.Contains("ctid", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildTableSizeSql_WithoutTimescaleMetadata_DoesNotReferenceTimescaleCatalog()
    {
        var sql = TimescaleTelemetryRepository.BuildTableSizeSql(includeTimescaleChunks: false);

        Assert.DoesNotContain("timescaledb_information", sql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("pg_total_relation_size", sql, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildTableSizeSql_WithTimescaleMetadata_ReferencesChunkCatalog()
    {
        var sql = TimescaleTelemetryRepository.BuildTableSizeSql(includeTimescaleChunks: true);

        Assert.Contains("timescaledb_information.chunks", sql, StringComparison.OrdinalIgnoreCase);
    }
}
