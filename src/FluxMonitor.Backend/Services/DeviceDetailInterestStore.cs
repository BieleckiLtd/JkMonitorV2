using System.Collections.Concurrent;

namespace FluxMonitor.Backend.Services;

public sealed class DeviceDetailInterestStore
{
    private readonly ConcurrentDictionary<Guid, HashSet<string>> _leases = new();

    public IDisposable Acquire(IEnumerable<string> deviceIds)
    {
        var normalizedIds = deviceIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (normalizedIds.Count == 0)
        {
            return EmptyDisposable.Instance;
        }

        var leaseId = Guid.NewGuid();
        _leases[leaseId] = normalizedIds;
        return new Lease(() => _leases.TryRemove(leaseId, out _));
    }

    public bool HasDetailInterest(string deviceId)
    {
        if (string.IsNullOrWhiteSpace(deviceId))
        {
            return false;
        }

        return _leases.Values.Any(ids => ids.Contains(deviceId));
    }

    private sealed class Lease(Action dispose) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                dispose();
            }
        }
    }

    private sealed class EmptyDisposable : IDisposable
    {
        public static EmptyDisposable Instance { get; } = new();

        public void Dispose()
        {
        }
    }
}
