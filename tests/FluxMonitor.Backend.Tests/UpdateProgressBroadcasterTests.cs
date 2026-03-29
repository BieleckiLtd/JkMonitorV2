using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public class UpdateProgressBroadcasterTests
{
    [Fact]
    public async Task Subscribe_ImmediatelyReceivesCurrentSnapshot()
    {
        var broadcaster = new UpdateProgressBroadcaster();
        var currentProgress = new UpdateProgress
        {
            SessionId = "abcd1234",
            Status = "running",
            IsRunning = true,
            Stage = "Preparing update…",
            Detail = "Preparing the installer.",
            CanCancel = true,
            StartedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
            UpdatedAt = DateTimeOffset.UtcNow
        };

        await using var subscription = broadcaster.Subscribe(currentProgress);

        var received = await subscription.Reader.ReadAsync(CancellationToken.None);

        Assert.NotNull(received);
        Assert.Equal("abcd1234", received!.SessionId);
        Assert.Equal("Preparing update…", received.Stage);
        Assert.NotSame(currentProgress, received);
    }

    [Fact]
    public async Task Publish_PushesUpdatesToExistingSubscribers()
    {
        var broadcaster = new UpdateProgressBroadcaster();
        await using var subscription = broadcaster.Subscribe(null);

        var initial = await subscription.Reader.ReadAsync(CancellationToken.None);
        Assert.Null(initial);

        var progress = new UpdateProgress
        {
            SessionId = "efgh5678",
            Status = "running",
            IsRunning = true,
            Stage = "Downloading update…",
            Detail = "Downloading the published release package from GitHub.",
            CanCancel = true,
            PercentComplete = 18,
            StartedAt = DateTimeOffset.UtcNow.AddSeconds(-10),
            UpdatedAt = DateTimeOffset.UtcNow
        };

        broadcaster.Publish(progress);

        var received = await subscription.Reader.ReadAsync(CancellationToken.None);

        Assert.NotNull(received);
        Assert.Equal("efgh5678", received!.SessionId);
        Assert.Equal(18, received.PercentComplete);
        Assert.NotSame(progress, received);
    }
}
