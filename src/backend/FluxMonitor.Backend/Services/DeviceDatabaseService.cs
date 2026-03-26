using System.Text.RegularExpressions;
using Dapper;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class DeviceDatabaseService(
    IOptions<MonitorConfiguration> configuration,
    ILogger<DeviceDatabaseService> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private readonly StorageConfiguration _storage = configuration.Value.Storage;

    private static readonly Regex ValidDbName = new("^[a-z][a-z0-9_]{0,62}$", RegexOptions.Compiled);

    public string SuggestDatabaseName(string deviceId, string? defaultNamePattern)
    {
        var pattern = defaultNamePattern ?? "FluxMonitor_{deviceId}";
        var name = pattern.Replace("{deviceId}", deviceId);
        // Sanitize: lowercase, replace non-alphanumeric with underscore, limit length
        name = Regex.Replace(name.ToLowerInvariant(), "[^a-z0-9_]", "_");
        if (name.Length > 63) name = name[..63];
        if (!char.IsLetter(name[0])) name = "db_" + name;
        return name;
    }

    public async Task<IReadOnlyList<string>> ListDatabasesAsync(CancellationToken cancellationToken)
    {
        await using var connection = await OpenConnectionAsync(BuildMaintenanceConnectionString(), cancellationToken);

        var databases = await connection.QueryAsync<string>(@"
SELECT datname FROM pg_database
WHERE datistemplate = false AND datname NOT IN ('postgres', 'template0', 'template1')
ORDER BY datname;");

        return databases.ToList();
    }

    public async Task<CreateDatabaseResult> CreateDatabaseAsync(string databaseName, string provider, CancellationToken cancellationToken)
    {
        if (!ValidDbName.IsMatch(databaseName))
        {
            return new CreateDatabaseResult(false, $"Invalid database name '{databaseName}'. Use lowercase letters, digits, and underscores (max 63 chars, must start with a letter).");
        }

        await using var connection = await OpenConnectionAsync(BuildMaintenanceConnectionString(), cancellationToken);

        // Check if database already exists
        var exists = await connection.ExecuteScalarAsync<int?>(
            "SELECT 1 FROM pg_database WHERE datname = @Name;", new { Name = databaseName });
        if (exists is not null)
        {
            return new CreateDatabaseResult(false, $"Database '{databaseName}' already exists.");
        }

        // CREATE DATABASE cannot run inside a transaction or use parameters
        // Database name is validated by regex above, safe to interpolate
        await connection.ExecuteAsync($"CREATE DATABASE \"{databaseName}\";");

        logger.LogInformation("Created database '{DatabaseName}'.", databaseName);

        // If TimescaleDB is required, enable the extension in the new database
        if (string.Equals(provider, "timescaledb", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(provider, "both", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var deviceConnStr = BuildConnectionStringForDatabase(databaseName);
                await using var deviceConn = await OpenConnectionAsync(deviceConnStr, cancellationToken);

                await deviceConn.ExecuteAsync("CREATE EXTENSION IF NOT EXISTS timescaledb;");

                logger.LogInformation("Enabled TimescaleDB extension in '{DatabaseName}'.", databaseName);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to enable TimescaleDB extension in '{DatabaseName}'. The database was created but may need manual setup.", databaseName);
                return new CreateDatabaseResult(true, $"Database '{databaseName}' created, but TimescaleDB extension failed: {ex.Message}");
            }
        }

        return new CreateDatabaseResult(true, $"Database '{databaseName}' created successfully.");
    }

    public async Task<SchemaValidationResult> ValidateSchemaAsync(string databaseName, CancellationToken cancellationToken)
    {
        var issues = new List<string>();
        var connectionString = BuildConnectionStringForDatabase(databaseName);

        try
        {
            await using var connection = await OpenConnectionAsync(connectionString, cancellationToken);

            // Check for TimescaleDB extension
            var hasTimescale = await connection.ExecuteScalarAsync<int?>(
                "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb';") is not null;

            // Check for expected tables
            var expectedTables = new[] { "jk_raw_samples", "jk_rollup_1m", "jk_rollup_5m", "jk_rollup_1h" };

            var tableNames = await connection.QueryAsync<string>(@"
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';");

            var existingTables = new HashSet<string>(tableNames, StringComparer.OrdinalIgnoreCase);

            foreach (var table in expectedTables)
            {
                if (!existingTables.Contains(table))
                    issues.Add($"Missing table: {table}");
            }

            // Check for unexpected tables (not part of the schema)
            var knownTables = new HashSet<string>(expectedTables, StringComparer.OrdinalIgnoreCase);
            foreach (var table in existingTables)
            {
                if (!knownTables.Contains(table))
                    issues.Add($"Unknown table: {table}");
            }

            return new SchemaValidationResult(
                Compatible: issues.Count == 0,
                HasTimescaleDb: hasTimescale,
                ExistingTables: existingTables.Order().ToList(),
                Issues: issues,
                IsEmpty: existingTables.Count == 0);
        }
        catch (Exception ex)
        {
            return new SchemaValidationResult(
                Compatible: false,
                HasTimescaleDb: false,
                ExistingTables: [],
                Issues: [$"Cannot connect to database '{databaseName}': {ex.Message}"],
                IsEmpty: false);
        }
    }

    public string BuildConnectionStringForDatabase(string databaseName)
    {
        var builder = new NpgsqlConnectionStringBuilder(_storage.ConnectionString)
        {
            Database = databaseName
        };
        return builder.ToString();
    }

    private string BuildMaintenanceConnectionString()
    {
        var builder = new NpgsqlConnectionStringBuilder(_storage.ConnectionString)
        {
            Database = "postgres"
        };
        return builder.ToString();
    }
}

public sealed record CreateDatabaseResult(bool Success, string Message);

public sealed record SchemaValidationResult(
    bool Compatible,
    bool HasTimescaleDb,
    IReadOnlyList<string> ExistingTables,
    IReadOnlyList<string> Issues,
    bool IsEmpty);
