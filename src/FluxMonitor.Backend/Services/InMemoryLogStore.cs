using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

public interface ILogMutationService
{
    Task<int> DeleteAllAsync(CancellationToken cancellationToken);

    Task<int> DeleteAsync(IReadOnlyList<long> entryIds, CancellationToken cancellationToken);
}

public sealed class InMemoryLogStore : ILogQueryService, ILogMutationService
{
    private const int MaxEntries = 50_000;

    private readonly object _sync = new();
    private readonly List<LogEntry> _entries = [];
    private long _nextId;

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

        lock (_sync)
        {
            _entries.Add(entry);

            if (_entries.Count > MaxEntries)
            {
                _entries.RemoveAt(0);
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
        LogEntry[] snapshot;
        lock (_sync)
        {
            snapshot = _entries.ToArray();
        }

        IEnumerable<LogEntry> query = snapshot;

        if (levels is { Count: > 0 })
        {
            var levelSet = new HashSet<string>(levels, StringComparer.OrdinalIgnoreCase);
            query = query.Where(entry => levelSet.Contains(entry.Level));
        }

        if (from.HasValue)
        {
            query = query.Where(entry => entry.Timestamp >= from.Value);
        }

        if (to.HasValue)
        {
            query = query.Where(entry => entry.Timestamp <= to.Value);
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            query = query.Where(entry =>
                entry.Message.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                entry.Category.Contains(search, StringComparison.OrdinalIgnoreCase) ||
                (entry.Exception?.Contains(search, StringComparison.OrdinalIgnoreCase) ?? false));
        }

        var filtered = query.Reverse().ToList();

        return new LogQueryResponse
        {
            TotalCount = filtered.Count,
            Entries = filtered.Skip(skip).Take(take).ToList()
        };
    }

    public Task<LogQueryResponse> QueryAsync(
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search,
        int skip,
        int take,
        CancellationToken cancellationToken)
        => Task.FromResult(Query(levels, from, to, search, skip, take));

    public Task<int> DeleteAllAsync(CancellationToken cancellationToken)
    {
        lock (_sync)
        {
            var deletedCount = _entries.Count;
            _entries.Clear();
            return Task.FromResult(deletedCount);
        }
    }

    public Task<int> DeleteAsync(IReadOnlyList<long> entryIds, CancellationToken cancellationToken)
    {
        if (entryIds.Count == 0)
        {
            return Task.FromResult(0);
        }

        lock (_sync)
        {
            var ids = entryIds.ToHashSet();
            var deletedCount = _entries.RemoveAll(entry => ids.Contains(entry.Id));
            return Task.FromResult(deletedCount);
        }
    }
}
