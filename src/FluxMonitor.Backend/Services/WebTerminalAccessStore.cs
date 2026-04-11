using Dapper;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public interface IWebTerminalAccessStore
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task<WebTerminalAccessStore.WebTerminalAccessSettings> GetSettingsAsync(CancellationToken cancellationToken);

    Task SaveSettingsAsync(bool enabled, CancellationToken cancellationToken);
}

public sealed class WebTerminalAccessStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<WebTerminalAccessStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString), IWebTerminalAccessStore
{
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _cacheLock = new();
    private WebTerminalAccessSettings _settings = BuildDefaultSettings(storageAvailable: true);
    private volatile bool _initialized;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized)
        {
            return;
        }

        await _initializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_initialized)
            {
                return;
            }

            if (!HasDatabase)
            {
                lock (_cacheLock)
                {
                    _settings = BuildDefaultSettings(storageAvailable: false);
                }

                _initialized = true;
                return;
            }

            await using var connection = await OpenConnectionAsync(cancellationToken);
            await EnsureSchemaAsync(connection, cancellationToken);

            var loadedSettings = await LoadSettingsAsync(connection, cancellationToken);
            lock (_cacheLock)
            {
                _settings = loadedSettings;
            }

            _initialized = true;
            logger.LogInformation(
                "Web terminal settings loaded from PostgreSQL. Enabled={Enabled}.",
                loadedSettings.Enabled);
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<WebTerminalAccessSettings> GetSettingsAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        lock (_cacheLock)
        {
            return new WebTerminalAccessSettings(_settings.StorageAvailable, _settings.Enabled);
        }
    }

    public async Task SaveSettingsAsync(bool enabled, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var normalizedSettings = new WebTerminalAccessSettings(HasDatabase, enabled);

        if (HasDatabase)
        {
            await using var connection = await OpenConnectionAsync(cancellationToken);
            const string sql = """
                INSERT INTO web_terminal_settings (id, enabled, updated_at)
                VALUES (TRUE, @Enabled, NOW())
                ON CONFLICT (id) DO UPDATE
                SET
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW();
                """;

            await connection.ExecuteAsync(new CommandDefinition(
                sql,
                new
                {
                    normalizedSettings.Enabled
                },
                cancellationToken: cancellationToken));
        }

        lock (_cacheLock)
        {
            _settings = normalizedSettings;
        }
    }

    internal static WebTerminalAccessSettings BuildDefaultSettings(bool storageAvailable)
    {
        return new WebTerminalAccessSettings(storageAvailable, Enabled: true);
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string createSql = """
            CREATE TABLE IF NOT EXISTS web_terminal_settings (
                id boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
                enabled boolean NOT NULL DEFAULT TRUE,
                updated_at timestamptz NOT NULL DEFAULT NOW()
            );
            """;

        await connection.ExecuteAsync(new CommandDefinition(createSql, cancellationToken: cancellationToken));
    }

    private static async Task<WebTerminalAccessSettings> LoadSettingsAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT enabled AS "Enabled"
            FROM web_terminal_settings
            WHERE id = TRUE;
            """;

        var row = await connection.QuerySingleOrDefaultAsync<WebTerminalAccessSettingsRow>(
            new CommandDefinition(sql, cancellationToken: cancellationToken));

        return row is null
            ? BuildDefaultSettings(storageAvailable: true)
            : new WebTerminalAccessSettings(StorageAvailable: true, Enabled: row.Enabled);
    }

    public sealed record WebTerminalAccessSettings(bool StorageAvailable, bool Enabled);

    private sealed class WebTerminalAccessSettingsRow
    {
        public bool Enabled { get; init; }
    }
}

