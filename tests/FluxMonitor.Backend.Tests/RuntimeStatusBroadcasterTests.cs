using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class RuntimeStatusBroadcasterTests
{
    [Fact]
    public async Task Subscribe_ImmediatelyReceivesCurrentSnapshot()
    {
        var broadcaster = new RuntimeStatusBroadcaster();

        await using var subscription = broadcaster.Subscribe(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Test",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            Devices = []
        });

        var received = await subscription.Reader.ReadAsync(CancellationToken.None);

        Assert.Equal("FluxMonitor.Backend", received.ServiceName);
        Assert.Equal("Test", received.EnvironmentName);
        Assert.Empty(received.Devices);
    }

    [Fact]
    public async Task Publish_PushesUpdatesToExistingSubscribers()
    {
        var broadcaster = new RuntimeStatusBroadcaster();
        await using var subscription = broadcaster.Subscribe(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Test",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            Devices = []
        });

        _ = await subscription.Reader.ReadAsync(CancellationToken.None);

        broadcaster.Publish(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Production",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:00.500Z"),
            SystemMetrics = new SystemRuntimeMetrics
            {
                CpuUtilizationPercent = 42
            },
            Devices = []
        });

        var received = await subscription.Reader.ReadAsync(CancellationToken.None);

        Assert.Equal("Production", received.EnvironmentName);
        Assert.Equal(42, received.SystemMetrics?.CpuUtilizationPercent);
    }

    [Fact]
    public async Task Publish_SlowSubscribersKeepOnlyTheLatestSnapshot()
    {
        var broadcaster = new RuntimeStatusBroadcaster();
        await using var subscription = broadcaster.Subscribe(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Initial",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            Devices = []
        });

        broadcaster.Publish(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Stale",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:00.500Z"),
            Devices = []
        });

        broadcaster.Publish(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Latest",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:01.000Z"),
            Devices = []
        });

        Assert.True(subscription.Reader.TryRead(out var received));
        Assert.Equal("Latest", received!.EnvironmentName);
        Assert.False(subscription.Reader.TryRead(out _));
    }
}
