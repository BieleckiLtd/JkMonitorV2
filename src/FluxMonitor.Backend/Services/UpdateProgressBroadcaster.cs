using System.Collections.Concurrent;
using System.Threading.Channels;

namespace FluxMonitor.Backend.Services;

public sealed class UpdateProgressBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<UpdateProgress?>> _subscriptions = new();

    public UpdateProgressSubscription Subscribe(UpdateProgress? currentProgress)
    {
        var subscriptionId = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<UpdateProgress?>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        _subscriptions[subscriptionId] = channel;
        channel.Writer.TryWrite(Clone(currentProgress));

        return new UpdateProgressSubscription(channel.Reader, () => Remove(subscriptionId));
    }

    public void Publish(UpdateProgress? progress)
    {
        var snapshot = Clone(progress);

        foreach (var subscription in _subscriptions)
        {
            if (!subscription.Value.Writer.TryWrite(snapshot))
            {
                Remove(subscription.Key);
            }
        }
    }

    internal static UpdateProgress? Clone(UpdateProgress? progress)
    {
        if (progress is null)
        {
            return null;
        }

        return new UpdateProgress
        {
            SessionId = progress.SessionId,
            Status = progress.Status,
            IsRunning = progress.IsRunning,
            Stage = progress.Stage,
            Detail = progress.Detail,
            Success = progress.Success,
            CanCancel = progress.CanCancel,
            CancelUnavailableReason = progress.CancelUnavailableReason,
            StepIndex = progress.StepIndex,
            StepCount = progress.StepCount,
            PercentComplete = progress.PercentComplete,
            StartedAt = progress.StartedAt,
            UpdatedAt = progress.UpdatedAt
        };
    }

    private void Remove(Guid subscriptionId)
    {
        if (_subscriptions.TryRemove(subscriptionId, out var channel))
        {
            channel.Writer.TryComplete();
        }
    }
}

public sealed class UpdateProgressSubscription(ChannelReader<UpdateProgress?> reader, Action dispose) : IAsyncDisposable
{
    private int _disposed;

    public ChannelReader<UpdateProgress?> Reader { get; } = reader;

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            dispose();
        }

        return ValueTask.CompletedTask;
    }
}
