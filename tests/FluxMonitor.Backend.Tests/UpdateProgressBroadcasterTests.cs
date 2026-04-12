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

    [Fact]
    public async Task Publish_SlowSubscribersKeepOnlyTheLatestSnapshot()
    {
        var broadcaster = new UpdateProgressBroadcaster();
        await using var subscription = broadcaster.Subscribe(new UpdateProgress
        {
            SessionId = "initial",
            Status = "running",
            IsRunning = true,
            Stage = "Initial",
            CanCancel = true,
            StartedAt = DateTimeOffset.UtcNow.AddSeconds(-10),
            UpdatedAt = DateTimeOffset.UtcNow.AddSeconds(-10)
        });

        broadcaster.Publish(new UpdateProgress
        {
            SessionId = "session-1",
            Status = "running",
            IsRunning = true,
            Stage = "Stale",
            CanCancel = true,
            PercentComplete = 10,
            StartedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
            UpdatedAt = DateTimeOffset.UtcNow.AddSeconds(-5)
        });

        broadcaster.Publish(new UpdateProgress
        {
            SessionId = "session-1",
            Status = "running",
            IsRunning = true,
            Stage = "Latest",
            CanCancel = true,
            PercentComplete = 75,
            StartedAt = DateTimeOffset.UtcNow.AddSeconds(-5),
            UpdatedAt = DateTimeOffset.UtcNow
        });

        Assert.True(subscription.Reader.TryRead(out var received));
        Assert.NotNull(received);
        Assert.Equal("Latest", received!.Stage);
        Assert.Equal(75, received.PercentComplete);
        Assert.False(subscription.Reader.TryRead(out _));
    }
}
