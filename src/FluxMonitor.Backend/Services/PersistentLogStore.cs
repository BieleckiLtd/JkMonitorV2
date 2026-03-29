using System.Collections.Concurrent;
using System.Globalization;
using FluxMonitor.Backend.Configuration;
using FluxMonitor.Contracts.Status;
using Npgsql;
using NpgsqlTypes;
using Serilog.Core;
using Serilog.Events;

namespace FluxMonitor.Backend.Services;

public interface ILogQueryService
{
    Task<LogQueryResponse> QueryAsync(
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search,
        int skip,
        int take,
        CancellationToken cancellationToken);
}

public sealed class PersistentLogSink(PostgresLogStore store) : ILogEventSink
{
    public void Emit(LogEvent logEvent)
    {
        store.Persist(logEvent);
    }
}

public sealed class PostgresLogStore : ILogQueryService, IDisposable, IAsyncDisposable
{
    private readonly LogStorageOptions _options;
    private readonly InMemoryLogStore _fallbackStore = new();
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly NpgsqlDataSource? _dataSource;
    private readonly string _qualifiedTableName;
    private readonly ConcurrentQueue<PendingLogEntry> _pendingEntries = new();
    private readonly Timer? _flushTimer;
    private int _pendingCount;
    private int _flushing;
    private volatile bool _initialized;
    private volatile bool _postgresAvailable;

    private const int MaxPendingEntries = 100_000;
    private static readonly TimeSpan FlushInterval = TimeSpan.FromSeconds(2);

    private sealed record PendingLogEntry(
        DateTime TimestampUtc,
        string Level,
        string Category,
        string Message,
        string? Exception);

    public PostgresLogStore(LogStorageOptions options)
    {
        _options = options;
        _qualifiedTableName = $"{QuoteIdentifier(options.SchemaName)}.{QuoteIdentifier(options.TableName)}";

        if (_options.Enabled && !string.IsNullOrWhiteSpace(_options.ConnectionString))
        {
            _dataSource = NpgsqlDataSource.Create(_options.ConnectionString);
            _flushTimer = new Timer(FlushCallback, null, FlushInterval, FlushInterval);
        }
    }

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized || _dataSource is null)
        {
            return;
        }

        await _initializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_initialized || _dataSource is null)
            {
                return;
            }

            if (_options.AutoCreateDatabase)
            {
                await EnsureDatabaseExistsAsync(cancellationToken);
            }

            await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = $@"
CREATE SCHEMA IF NOT EXISTS {QuoteIdentifier(_options.SchemaName)};

CREATE TABLE IF NOT EXISTS {_qualifiedTableName} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    timestamp_utc timestamptz NOT NULL,
    level text NOT NULL,
    category text NOT NULL,
    message text NOT NULL,
    exception text NULL
);

CREATE INDEX IF NOT EXISTS {QuoteIdentifier($"ix_{_options.TableName}_timestamp")}
    ON {_qualifiedTableName} (timestamp_utc DESC, id DESC);

CREATE INDEX IF NOT EXISTS {QuoteIdentifier($"ix_{_options.TableName}_level_timestamp")}
    ON {_qualifiedTableName} (level, timestamp_utc DESC, id DESC);
";

            await command.ExecuteNonQueryAsync(cancellationToken);
            _postgresAvailable = true;
            _initialized = true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _postgresAvailable = false;
            WriteDiagnostic("Persistent log initialization failed", ex);
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public void Persist(LogEvent logEvent)
    {
        var timestamp = logEvent.Timestamp;
        var level = logEvent.Level.ToString();
        var category = GetCategory(logEvent);
        var message = logEvent.RenderMessage(CultureInfo.InvariantCulture);
        var exception = logEvent.Exception?.ToString();

        _fallbackStore.Add(timestamp, ParseLevel(level), category, message, exception);

        if (_dataSource is null)
        {
            return;
        }

        if (Interlocked.Increment(ref _pendingCount) > MaxPendingEntries)
        {
            if (_pendingEntries.TryDequeue(out _))
            {
                Interlocked.Decrement(ref _pendingCount);
            }
        }

        _pendingEntries.Enqueue(new PendingLogEntry(
            timestamp.UtcDateTime, level, category, message, exception));
    }

    public async Task<bool> PersistRecordAsync(
        DateTimeOffset timestamp,
        string level,
        string category,
        string message,
        string? exception,
        CancellationToken cancellationToken)
    {
        _fallbackStore.Add(timestamp, ParseLevel(level), category, message, exception);

        if (_dataSource is null)
        {
            return false;
        }

        await InitializeAsync(cancellationToken);
        if (!_postgresAvailable)
        {
            return false;
        }

        try
        {
            await WriteEntriesToPostgresAsync(
                [new PendingLogEntry(timestamp.UtcDateTime, level, category, message, exception)],
                cancellationToken);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _postgresAvailable = false;
            WriteDiagnostic("Failed to persist direct log record to PostgreSQL", ex);
            return false;
        }
    }

    private async void FlushCallback(object? state)
    {
        if (Interlocked.CompareExchange(ref _flushing, 1, 0) != 0)
        {
            return;
        }

        try
        {
            if (!_postgresAvailable)
            {
                if (!_initialized)
                {
                    await InitializeAsync(CancellationToken.None);
                }
                else
                {
                    await TryRecoverConnectionAsync();
                }
            }

            if (_postgresAvailable && !_pendingEntries.IsEmpty)
            {
                await FlushPendingEntriesAsync();
            }
        }
        catch (Exception ex)
        {
            WriteDiagnostic("Background log flush failed", ex);
        }
        finally
        {
            Interlocked.Exchange(ref _flushing, 0);
        }
    }

    private async Task FlushPendingEntriesAsync()
    {
        if (_dataSource is null || _pendingEntries.IsEmpty)
        {
            return;
        }

        const int batchSize = 500;
        var entries = new List<PendingLogEntry>(batchSize);

        while (entries.Count < batchSize && _pendingEntries.TryDequeue(out var entry))
        {
            entries.Add(entry);
            Interlocked.Decrement(ref _pendingCount);
        }

        if (entries.Count == 0)
        {
            return;
        }

        try
        {
            await WriteEntriesToPostgresAsync(entries, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _postgresAvailable = false;
            WriteDiagnostic("Failed to flush log entries to PostgreSQL", ex);

            foreach (var entry in entries)
            {
                _pendingEntries.Enqueue(entry);
                Interlocked.Increment(ref _pendingCount);
            }
        }
    }

    private async Task WriteEntriesToPostgresAsync(
        IReadOnlyList<PendingLogEntry> entries,
        CancellationToken cancellationToken)
    {
        if (_dataSource is null || entries.Count == 0)
        {
            return;
        }

        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        foreach (var entry in entries)
        {
            await using var command = new NpgsqlCommand(
                $"INSERT INTO {_qualifiedTableName} (timestamp_utc, level, category, message, exception) VALUES (@ts, @lv, @cat, @msg, @ex);",
                connection,
                transaction);

            command.Parameters.AddWithValue("ts", entry.TimestampUtc);
            command.Parameters.AddWithValue("lv", entry.Level);
            command.Parameters.AddWithValue("cat", entry.Category);
            command.Parameters.AddWithValue("msg", entry.Message);
            command.Parameters.AddWithValue("ex", (object?)entry.Exception ?? DBNull.Value);

            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    private async Task TryRecoverConnectionAsync()
    {
        if (_dataSource is null)
        {
            return;
        }

        try
        {
            await using var connection = await _dataSource.OpenConnectionAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT 1;";
            await command.ExecuteScalarAsync();
            _postgresAvailable = true;
        }
        catch
        {
            // Still unavailable
        }
    }

    public async Task<LogQueryResponse> QueryAsync(
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search,
        int skip,
        int take,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!_postgresAvailable || _dataSource is null)
        {
            return await _fallbackStore.QueryAsync(levels, from, to, search, skip, take, cancellationToken);
        }

        if (!_pendingEntries.IsEmpty)
        {
            await FlushPendingEntriesAsync();
        }

        await using var connection = await _dataSource.OpenConnectionAsync(cancellationToken);

        var whereClause = BuildWhereClause(levels, from, to, search);
        var totalCount = await QueryTotalCountAsync(connection, whereClause, levels, from, to, search, cancellationToken);
        var entries = await QueryEntriesAsync(connection, whereClause, levels, from, to, search, skip, take, cancellationToken);

        return new LogQueryResponse
        {
            TotalCount = totalCount,
            Entries = entries
        };
    }

    private async Task<int> QueryTotalCountAsync(
        NpgsqlConnection connection,
        string whereClause,
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $"SELECT COUNT(*) FROM {_qualifiedTableName}{whereClause};";
        AddFilterParameters(command, levels, from, to, search);

        var result = await command.ExecuteScalarAsync(cancellationToken);
        var totalCount = result is long count ? count : 0;
        return totalCount > int.MaxValue ? int.MaxValue : (int)totalCount;
    }

    private async Task<IReadOnlyList<LogEntry>> QueryEntriesAsync(
        NpgsqlConnection connection,
        string whereClause,
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search,
        int skip,
        int take,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = $@"
SELECT id, timestamp_utc, level, category, message, exception
FROM {_qualifiedTableName}
{whereClause}
ORDER BY timestamp_utc DESC, id DESC
OFFSET @skip
LIMIT @take;
";

        AddFilterParameters(command, levels, from, to, search);
        command.Parameters.AddWithValue("skip", skip);
        command.Parameters.AddWithValue("take", take);

        var entries = new List<LogEntry>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            var timestamp = reader.GetFieldValue<DateTime>(1);
            entries.Add(new LogEntry
            {
                Id = reader.GetInt64(0),
                Timestamp = new DateTimeOffset(DateTime.SpecifyKind(timestamp, DateTimeKind.Utc)),
                Level = reader.GetString(2),
                Category = reader.GetString(3),
                Message = reader.GetString(4),
                Exception = reader.IsDBNull(5) ? null : reader.GetString(5)
            });
        }

        return entries;
    }

    private static string BuildWhereClause(
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search)
    {
        var clauses = new List<string>();

        if (levels is { Count: > 0 })
        {
            clauses.Add("level = ANY (@levels)");
        }

        if (from.HasValue)
        {
            clauses.Add("timestamp_utc >= @from");
        }

        if (to.HasValue)
        {
            clauses.Add("timestamp_utc <= @to");
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            clauses.Add("(message ILIKE @search OR category ILIKE @search OR COALESCE(exception, '') ILIKE @search)");
        }

        return clauses.Count == 0 ? string.Empty : $" WHERE {string.Join(" AND ", clauses)}";
    }

    private static void AddFilterParameters(
        NpgsqlCommand command,
        IReadOnlyList<string>? levels,
        DateTimeOffset? from,
        DateTimeOffset? to,
        string? search)
    {
        if (levels is { Count: > 0 })
        {
            var levelsParameter = new NpgsqlParameter<string[]>("levels", levels.ToArray())
            {
                NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Text
            };
            command.Parameters.Add(levelsParameter);
        }

        if (from.HasValue)
        {
            command.Parameters.AddWithValue("from", from.Value.UtcDateTime);
        }

        if (to.HasValue)
        {
            command.Parameters.AddWithValue("to", to.Value.UtcDateTime);
        }

        if (!string.IsNullOrWhiteSpace(search))
        {
            command.Parameters.AddWithValue("search", $"%{search.Trim()}%");
        }
    }

    private async Task EnsureDatabaseExistsAsync(CancellationToken cancellationToken)
    {
        if (_dataSource is null)
        {
            return;
        }

        var target = new NpgsqlConnectionStringBuilder(_options.ConnectionString);

        if (string.IsNullOrWhiteSpace(target.Database))
        {
            return;
        }

        var adminConnectionString = !string.IsNullOrWhiteSpace(_options.AdminConnectionString)
            ? _options.AdminConnectionString
            : new NpgsqlConnectionStringBuilder(_options.ConnectionString)
            {
                Database = _options.AdminDatabase
            }.ToString();

        await using var adminDataSource = NpgsqlDataSource.Create(adminConnectionString);
        await using var connection = await adminDataSource.OpenConnectionAsync(cancellationToken);

        await using (var existsCommand = connection.CreateCommand())
        {
            existsCommand.CommandText = "SELECT 1 FROM pg_database WHERE datname = @database_name;";
            existsCommand.Parameters.AddWithValue("database_name", target.Database);
            var exists = await existsCommand.ExecuteScalarAsync(cancellationToken);

            if (exists is not null)
            {
                return;
            }
        }

        await using var createCommand = connection.CreateCommand();
        createCommand.CommandText = $"CREATE DATABASE {QuoteIdentifier(target.Database)};";
        await createCommand.ExecuteNonQueryAsync(cancellationToken);
    }

    private static string GetCategory(LogEvent logEvent)
    {
        if (logEvent.Properties.TryGetValue("SourceContext", out var sourceContext)
            && sourceContext is ScalarValue scalarValue
            && scalarValue.Value is string category
            && !string.IsNullOrWhiteSpace(category))
        {
            return category;
        }

        return "Application";
    }

    private static LogLevel ParseLevel(string level)
        => Enum.TryParse<LogLevel>(level, ignoreCase: true, out var parsed) ? parsed : LogLevel.Information;

    private static string QuoteIdentifier(string identifier)
        => $"\"{identifier.Replace("\"", "\"\"")}\"";

    private static void WriteDiagnostic(string message, Exception ex)
        => Console.Error.WriteLine($"{message}: {ex}");

    public void Dispose()
    {
        _flushTimer?.Dispose();
        try { FlushPendingEntriesAsync().GetAwaiter().GetResult(); }
        catch { /* Best-effort final flush */ }
        _initializationLock.Dispose();
        _dataSource?.Dispose();
    }

    public async ValueTask DisposeAsync()
    {
        if (_flushTimer is not null)
        {
            await _flushTimer.DisposeAsync();
        }

        try { await FlushPendingEntriesAsync(); }
        catch { /* Best-effort final flush */ }

        _initializationLock.Dispose();

        if (_dataSource is not null)
        {
            await _dataSource.DisposeAsync();
        }
    }
}
