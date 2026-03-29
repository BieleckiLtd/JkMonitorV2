using Dapper;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class WifiCredentialStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<WifiCredentialStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private volatile bool _initialized;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized)
        {
            return;
        }

        if (!HasDatabase)
        {
            _initialized = true;
            return;
        }

        await _initializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_initialized)
            {
                return;
            }

            await using var connection = await OpenConnectionAsync(cancellationToken);
            await EnsureSchemaAsync(connection, cancellationToken);
            _initialized = true;
            logger.LogInformation("Wi-Fi credential storage is ready.");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<WifiStoredCredentialResult> GetCredentialAsync(string? ssid, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var trimmedSsid = ssid?.Trim() ?? string.Empty;
        if (!HasDatabase || string.IsNullOrWhiteSpace(trimmedSsid))
        {
            return new WifiStoredCredentialResult
            {
                StorageAvailable = HasDatabase,
                Ssid = trimmedSsid,
                HasStoredPassword = false
            };
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            SELECT
                ssid AS "Ssid",
                password AS "Password",
                last_bssid AS "LastBssid"
            FROM wifi_known_networks
            WHERE ssid = @Ssid;
            """;

        var row = await connection.QuerySingleOrDefaultAsync<StoredWifiCredentialRow>(
            new CommandDefinition(
                sql,
                new { Ssid = trimmedSsid },
                cancellationToken: cancellationToken));

        return row is null
            ? new WifiStoredCredentialResult
            {
                StorageAvailable = true,
                Ssid = trimmedSsid,
                HasStoredPassword = false
            }
            : new WifiStoredCredentialResult
            {
                StorageAvailable = true,
                Ssid = row.Ssid,
                HasStoredPassword = !string.IsNullOrWhiteSpace(row.Password),
                Password = row.Password,
                LastBssid = row.LastBssid
            };
    }

    public async Task SaveCredentialAsync(string ssid, string password, string? bssid, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var trimmedSsid = ssid.Trim();
        var trimmedPassword = password.Trim();
        var trimmedBssid = string.IsNullOrWhiteSpace(bssid) ? null : bssid.Trim().ToUpperInvariant();

        if (!HasDatabase || string.IsNullOrWhiteSpace(trimmedSsid) || string.IsNullOrWhiteSpace(trimmedPassword))
        {
            return;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            INSERT INTO wifi_known_networks (ssid, password, last_bssid, updated_at)
            VALUES (@Ssid, @Password, @LastBssid, NOW())
            ON CONFLICT (ssid) DO UPDATE
            SET
                password = EXCLUDED.password,
                last_bssid = EXCLUDED.last_bssid,
                updated_at = NOW();
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new
            {
                Ssid = trimmedSsid,
                Password = trimmedPassword,
                LastBssid = trimmedBssid
            },
            cancellationToken: cancellationToken));
    }

    public async Task DeleteCredentialAsync(string? ssid, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var trimmedSsid = ssid?.Trim();
        if (!HasDatabase || string.IsNullOrWhiteSpace(trimmedSsid))
        {
            return;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            DELETE FROM wifi_known_networks
            WHERE ssid = @Ssid;
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new { Ssid = trimmedSsid },
            cancellationToken: cancellationToken));
    }

    private void EnsureInitialized()
    {
        if (_initialized)
        {
            return;
        }

        InitializeAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS wifi_known_networks (
                ssid text PRIMARY KEY,
                password text NOT NULL,
                last_bssid text NULL,
                updated_at timestamptz NOT NULL DEFAULT NOW()
            );
            """;

        await connection.ExecuteAsync(new CommandDefinition(sql, cancellationToken: cancellationToken));
    }

    private sealed class StoredWifiCredentialRow
    {
        public required string Ssid { get; init; }

        public required string Password { get; init; }

        public string? LastBssid { get; init; }
    }
}
