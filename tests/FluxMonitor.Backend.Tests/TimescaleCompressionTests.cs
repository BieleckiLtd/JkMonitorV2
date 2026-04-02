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
    public void RetentionConfiguration_DefaultOneMinuteWindow_Is1Hour()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(1, retention.OneMinuteWindowHours);
    }

    [Fact]
    public void RetentionConfiguration_DefaultFiveMinuteWindow_Is365Days()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(365, retention.FiveMinuteWindowDays);
    }

    [Fact]
    public void RetentionConfiguration_DefaultOneHourWindowDays_IsZero_MeansKeepForever()
    {
        var retention = new RetentionConfiguration();
        Assert.Equal(0, retention.OneHourWindowDays);
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
}
