using Npgsql;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Base class for Postgres-backed stores. Provides a connection factory
/// so subclasses can use Dapper without manually constructing NpgsqlConnection each time.
/// </summary>
public abstract class PostgresStore(string? connectionString)
{
    protected string? ConnectionString { get; } = connectionString;

    protected bool HasDatabase => !string.IsNullOrWhiteSpace(ConnectionString);

    protected async Task<NpgsqlConnection> OpenConnectionAsync(CancellationToken cancellationToken)
    {
        if (!HasDatabase)
            throw new InvalidOperationException("No database connection string configured.");

        var connection = new NpgsqlConnection(ConnectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }

    protected async Task<NpgsqlConnection> OpenConnectionAsync(string connectionString, CancellationToken cancellationToken)
    {
        var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        return connection;
    }
}
