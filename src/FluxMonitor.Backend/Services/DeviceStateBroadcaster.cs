using System.Collections.Concurrent;
using System.Threading.Channels;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

public sealed class DeviceStateBroadcaster
{
    private readonly ConcurrentDictionary<Guid, Channel<IReadOnlyList<DeviceRuntimeState>>> _subscriptions = new();

    public DeviceStateSubscription Subscribe(IReadOnlyList<DeviceRuntimeState> currentDevices)
    {
        var subscriptionId = Guid.NewGuid();
        var channel = Channel.CreateUnbounded<IReadOnlyList<DeviceRuntimeState>>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false
        });

        _subscriptions[subscriptionId] = channel;
        channel.Writer.TryWrite(Clone(currentDevices));

        return new DeviceStateSubscription(channel.Reader, () => Remove(subscriptionId));
    }

    public void Publish(IReadOnlyList<DeviceRuntimeState> devices)
    {
        var snapshot = Clone(devices);

        foreach (var subscription in _subscriptions)
        {
            if (!subscription.Value.Writer.TryWrite(snapshot))
            {
                Remove(subscription.Key);
            }
        }
    }

    internal static IReadOnlyList<DeviceRuntimeState> Clone(IReadOnlyList<DeviceRuntimeState> devices)
    {
        ArgumentNullException.ThrowIfNull(devices);
        return devices.ToArray();
    }

    private void Remove(Guid subscriptionId)
    {
        if (_subscriptions.TryRemove(subscriptionId, out var channel))
        {
            channel.Writer.TryComplete();
        }
    }
}

public sealed class DeviceStateSubscription(ChannelReader<IReadOnlyList<DeviceRuntimeState>> reader, Action dispose) : IAsyncDisposable
{
    private int _disposed;

    public ChannelReader<IReadOnlyList<DeviceRuntimeState>> Reader { get; } = reader;

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            dispose();
        }

        return ValueTask.CompletedTask;
    }
}
