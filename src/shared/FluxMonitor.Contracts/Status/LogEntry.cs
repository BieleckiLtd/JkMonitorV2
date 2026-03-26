namespace FluxMonitor.Contracts.Status;

public sealed record class LogEntry
{
    public required long Id { get; init; }

    public required DateTimeOffset Timestamp { get; init; }

    public required string Level { get; init; }

    public required string Category { get; init; }

    public required string Message { get; init; }

    public string? Exception { get; init; }
}

public sealed record class LogQueryResponse
{
    public required IReadOnlyList<LogEntry> Entries { get; init; }

    public required int TotalCount { get; init; }
}
