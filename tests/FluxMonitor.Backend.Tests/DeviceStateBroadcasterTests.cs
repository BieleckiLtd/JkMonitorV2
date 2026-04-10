using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DeviceStateBroadcasterTests
{
    [Fact]
    public async Task Subscribe_ImmediatelyReceivesCurrentSnapshot()
    {
        var broadcaster = new DeviceStateBroadcaster();

        await using var subscription = broadcaster.Subscribe([
            new DeviceRuntimeState
            {
                DeviceId = "device-1",
                DisplayName = "Battery 1",
                DefinitionId = "jk-inverter-bms",
                Enabled = true,
                IsMaster = true,
                PollIntervalMilliseconds = 1000
            }
        ]);

        var received = await subscription.Reader.ReadAsync(CancellationToken.None);

        Assert.Single(received);
        Assert.Equal("device-1", received[0].DeviceId);
        Assert.NotSame(received, DeviceStateBroadcaster.Clone(received));
    }

    [Fact]
    public async Task Publish_PushesUpdatesToExistingSubscribers()
    {
        var broadcaster = new DeviceStateBroadcaster();
        await using var subscription = broadcaster.Subscribe([]);

        var initial = await subscription.Reader.ReadAsync(CancellationToken.None);
        Assert.Empty(initial);

        broadcaster.Publish([
            new DeviceRuntimeState
            {
                DeviceId = "device-2",
                DisplayName = "Battery 2",
                DefinitionId = "jk-inverter-bms",
                Enabled = true,
                IsMaster = false,
                PollIntervalMilliseconds = 500
            }
        ]);

        var received = await subscription.Reader.ReadAsync(CancellationToken.None);

        Assert.Single(received);
        Assert.Equal("device-2", received[0].DeviceId);
        Assert.Equal(500, received[0].PollIntervalMilliseconds);
    }
}
