using System.Collections.Concurrent;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

public sealed class InMemoryLogStore
{
    private const int MaxEntries = 50_000;

    private readonly ConcurrentQueue<LogEntry> _entries = new();
    private long _nextId;
    private int _count;

    public void Add(DateTimeOffset timestamp, LogLevel level, string category, string message, string? exception)
    {
        var entry = new LogEntry
        {
            Id = Interlocked.Increment(ref _nextId),
            Timestamp = timestamp,
            Level = level.ToString(),
            Category = category,
            Message = message,
            Exception = exception
        };

        _entries.Enqueue(entry);

        if (Interlocked.Increment(ref _count) > MaxEntries)
        {
            if (_entries.TryDequeue(out _))
            {
                Interlocked.Decrement(ref _count);
            }
        }
    }

    public LogQueryResponse Query(
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search,
        int skip,
        int take)
    {
        IEnumerable<LogEntry> query = _entries;

        if (levels is { Count: > 0 })
        {
            var levelSet = new HashSet<string>(levels, StringComparer.OrdinalIgnoreCase);
            query = query.Where(e => levelSet.Contains(e.Level));
        }

        if (from.HasValue)
        {
            query = query.Where(e => e.Timestamp >= from.Value);
        }

        if (to.HasValue)
        {
            query = query.Where(e => e.Timestamp <= to.Value);
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            query = query.Where(e =>
                e.Message.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                e.Category.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                (e.Exception?.Contains(search, StringComparison.OrdinalIgnoreCase) ?? false));
        }

        var filtered = query.Reverse().ToList();

        return new LogQueryResponse
        {
            TotalCount = filtered.Count,
            Entries = filtered.Skip(skip).Take(take).ToList()
        };
    }
}
