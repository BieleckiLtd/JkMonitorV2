using System.Collections.Concurrent;
using System.Threading.Channels;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

public sealed class RuntimeStatusBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<MonitorRuntimeStatus>> _subscriptions = new();

    public RuntimeStatusSubscription Subscribe(MonitorRuntimeStatus currentStatus)
    {
        var subscriptionId = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<MonitorRuntimeStatus>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        _subscriptions[subscriptionId] = channel;
        channel.Writer.TryWrite(Clone(currentStatus));

        return new RuntimeStatusSubscription(channel.Reader, () => Remove(subscriptionId));
    }

    public void Publish(MonitorRuntimeStatus status)
    {
        var snapshot = Clone(status);

        foreach (var subscription in _subscriptions)
        {
            if (!subscription.Value.Writer.TryWrite(snapshot))
            {
                Remove(subscription.Key);
            }
        }
    }

    internal static MonitorRuntimeStatus Clone(MonitorRuntimeStatus status)
    {
        ArgumentNullException.ThrowIfNull(status);

        return status with
        {
            Devices = status.Devices.ToArray()
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

public sealed class RuntimeStatusSubscription(ChannelReader<MonitorRuntimeStatus> reader, Action dispose) : IAsyncDisposable
{
    private int _disposed;

    public ChannelReader<MonitorRuntimeStatus> Reader { get; } = reader;

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            dispose();
        }

        return ValueTask.CompletedTask;
    }
}
