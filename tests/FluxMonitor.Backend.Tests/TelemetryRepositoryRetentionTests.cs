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
    public void ConvertDatabaseScalarToDateTimeOffset_HandlesUtcDateTimeResults()
    {
        var value = TimescaleTelemetryRepository.ConvertDatabaseScalarToDateTimeOffset(
            new DateTime(2026, 4, 3, 17, 30, 0, DateTimeKind.Utc));

        Assert.Equal(new DateTimeOffset(2026, 4, 3, 17, 30, 0, TimeSpan.Zero), value);
    }

    [Fact]
    public void ConvertDatabaseScalarToDateTimeOffset_HandlesDateTimeOffsetResults()
    {
        var value = TimescaleTelemetryRepository.ConvertDatabaseScalarToDateTimeOffset(
            new DateTimeOffset(2026, 4, 3, 18, 30, 0, TimeSpan.FromHours(1)));

        Assert.Equal(new DateTimeOffset(2026, 4, 3, 17, 30, 0, TimeSpan.Zero), value);
    }

    [Fact]
    public void BuildDeleteOlderThanSql_ForMeasurements_UsesPrimaryKeyBatchDelete()
    {
        var sql = TimescaleTelemetryRepository.BuildDeleteOlderThanSql("Measurements", "Time");

        Assert.Contains(@"""BucketMinutes""", sql);
        Assert.Contains(@"""Time""", sql);
        Assert.Contains(@"""DeviceId""", sql);
        Assert.Contains(@"""SensorName""", sql);
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

    [Fact]
    public void SupportsImportTable_ReturnsFalse_ForUnsupportedLegacySection()
    {
        Assert.False(TimescaleTelemetryRepository.SupportsImportTable("DeviceSensors"));
    }

    [Fact]
    public void SupportsImportTable_ReturnsTrue_ForSupportedSection()
    {
        Assert.True(TimescaleTelemetryRepository.SupportsImportTable("Measurements"));
    }

    [Fact]
    public void NormalizePersistedBucketMinutes_FallsBackTo5_ForUnsupportedValues()
    {
        Assert.Equal(5, TimescaleTelemetryRepository.NormalizePersistedBucketMinutes(7));
        Assert.Equal(5, TimescaleTelemetryRepository.NormalizePersistedBucketMinutes(0));
    }

    [Fact]
    public void GetPersistedResolution_FormatsConfiguredBucketSize()
    {
        Assert.Equal("15m", TimescaleTelemetryRepository.GetPersistedResolution(15));
    }

    [Theory]
    [InlineData(null, BucketValueKind.Average)]
    [InlineData("", BucketValueKind.Average)]
    [InlineData("avg", BucketValueKind.Average)]
    [InlineData("average", BucketValueKind.Average)]
    [InlineData("min", BucketValueKind.Min)]
    [InlineData("max", BucketValueKind.Max)]
    [InlineData("last", BucketValueKind.Last)]
    public void TryParseBucketValueKind_RecognizesSupportedViews(string? input, BucketValueKind expected)
    {
        var parsed = TimescaleTelemetryRepository.TryParseBucketValueKind(input, out var actual);

        Assert.True(parsed);
        Assert.Equal(expected, actual);
    }

    [Fact]
    public void TryParseBucketValueKind_ReturnsFalse_ForUnsupportedView()
    {
        var parsed = TimescaleTelemetryRepository.TryParseBucketValueKind("median", out var actual);

        Assert.False(parsed);
        Assert.Equal(BucketValueKind.Average, actual);
    }
}
