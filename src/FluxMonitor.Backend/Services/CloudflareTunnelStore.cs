using System.Text.Json.Nodes;
using Dapper;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class CloudflareTunnelStore(
    IOptions<MonitorConfiguration> configuration,
    IHostEnvironment environment,
    IConfiguration appConfiguration,
    ILogger<CloudflareTunnelStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _cacheLock = new();
    private readonly string _contentRoot = environment.ContentRootPath;
    private readonly string _environmentName = environment.EnvironmentName;
    private CloudflareTunnelSettings _settings = new(false, null);
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
            await ImportLegacySettingsIfNeededAsync(connection, cancellationToken);

            var loadedSettings = await LoadSettingsAsync(connection, cancellationToken);
            lock (_cacheLock)
            {
                _settings = loadedSettings;
            }

            _initialized = true;
            logger.LogInformation(
                "Cloudflare Tunnel settings loaded from PostgreSQL. Enabled={Enabled}, HasToken={HasToken}.",
                loadedSettings.Enabled,
                !string.IsNullOrWhiteSpace(loadedSettings.TunnelToken));
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<CloudflareTunnelSettings> GetSettingsAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        lock (_cacheLock)
        {
            return Clone(_settings);
        }
    }

    public async Task SaveSettingsAsync(bool enabled, string? tunnelToken, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Tunnel settings cannot be saved until PostgreSQL storage is configured.");
        }

        var normalizedToken = string.IsNullOrWhiteSpace(tunnelToken) ? null : tunnelToken.Trim();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            INSERT INTO cloudflare_tunnel_settings (id, enabled, tunnel_token, updated_at)
            VALUES (TRUE, @Enabled, @TunnelToken, NOW())
            ON CONFLICT (id) DO UPDATE
            SET
                enabled = EXCLUDED.enabled,
                tunnel_token = EXCLUDED.tunnel_token,
                updated_at = NOW();
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new
            {
                Enabled = enabled,
                TunnelToken = normalizedToken
            },
            cancellationToken: cancellationToken));

        lock (_cacheLock)
        {
            _settings = new CloudflareTunnelSettings(enabled, normalizedToken);
        }
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS cloudflare_tunnel_settings (
                id boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
                enabled boolean NOT NULL DEFAULT false,
                tunnel_token text NULL,
                updated_at timestamptz NOT NULL DEFAULT NOW()
            );
            """;

        await connection.ExecuteAsync(new CommandDefinition(sql, cancellationToken: cancellationToken));
    }

    private async Task ImportLegacySettingsIfNeededAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string existingSql = """
            SELECT EXISTS (
                SELECT 1
                FROM cloudflare_tunnel_settings
                WHERE id = TRUE
            );
            """;

        var hasStoredRow = await connection.ExecuteScalarAsync<bool>(
            new CommandDefinition(existingSql, cancellationToken: cancellationToken));
        if (hasStoredRow)
        {
            return;
        }

        var legacySettings = LoadLegacySettings();
        if (!legacySettings.Enabled && string.IsNullOrWhiteSpace(legacySettings.TunnelToken))
        {
            return;
        }

        await SaveLegacyImportAsync(connection, legacySettings, cancellationToken);
        logger.LogInformation(
            "Imported legacy Cloudflare Tunnel settings into PostgreSQL. Enabled={Enabled}, HasToken={HasToken}.",
            legacySettings.Enabled,
            !string.IsNullOrWhiteSpace(legacySettings.TunnelToken));
    }

    private async Task SaveLegacyImportAsync(
        NpgsqlConnection connection,
        CloudflareTunnelSettings settings,
        CancellationToken cancellationToken)
    {
        const string sql = """
            INSERT INTO cloudflare_tunnel_settings (id, enabled, tunnel_token, updated_at)
            VALUES (TRUE, @Enabled, @TunnelToken, NOW())
            ON CONFLICT (id) DO UPDATE
            SET
                enabled = EXCLUDED.enabled,
                tunnel_token = EXCLUDED.tunnel_token,
                updated_at = NOW();
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new
            {
                settings.Enabled,
                TunnelToken = settings.TunnelToken
            },
            cancellationToken: cancellationToken));
    }

    private CloudflareTunnelSettings LoadLegacySettings()
    {
        var configuredProvider = ReadLegacyProviderFromLocalSettings()
            ?? appConfiguration["Monitor:ApiSecurity:TunnelProvider"];
        var enabled = string.Equals(configuredProvider, "cloudflared", StringComparison.OrdinalIgnoreCase);
        var tunnelToken = TryReadLegacyTunnelToken();

        return new CloudflareTunnelSettings(enabled, tunnelToken);
    }

    private async Task<CloudflareTunnelSettings> LoadSettingsAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                enabled AS "Enabled",
                tunnel_token AS "TunnelToken"
            FROM cloudflare_tunnel_settings
            WHERE id = TRUE;
            """;

        var row = await connection.QuerySingleOrDefaultAsync<CloudflareTunnelSettingsRow>(
            new CommandDefinition(sql, cancellationToken: cancellationToken));

        return row is null
            ? new CloudflareTunnelSettings(false, null)
            : new CloudflareTunnelSettings(row.Enabled, string.IsNullOrWhiteSpace(row.TunnelToken) ? null : row.TunnelToken.Trim());
    }

    private string? ReadLegacyProviderFromLocalSettings()
    {
        var path = Path.Combine(_contentRoot, $"appsettings.{_environmentName}.Local.json");
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            var json = File.ReadAllText(path);
            if (string.IsNullOrWhiteSpace(json))
            {
                return null;
            }

            var root = JsonNode.Parse(json) as JsonObject;
            return root?["Monitor"]?["ApiSecurity"]?["TunnelProvider"]?.GetValue<string>();
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to read legacy tunnel provider from {Path}.", path);
            return null;
        }
    }

    private string? TryReadLegacyTunnelToken()
    {
        var installRoot = Directory.GetParent(_contentRoot)?.FullName ?? _contentRoot;
        var path = Path.Combine(installRoot, "cloudflared.env");
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            foreach (var line in File.ReadLines(path))
            {
                const string prefix = "CLOUDFLARED_TUNNEL_TOKEN=";
                if (!line.StartsWith(prefix, StringComparison.Ordinal))
                {
                    continue;
                }

                var value = line[prefix.Length..].Trim().Trim('"', '\'');
                return string.IsNullOrWhiteSpace(value) ? null : value;
            }
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to read legacy Cloudflare Tunnel token from {Path}.", path);
        }

        return null;
    }

    private static CloudflareTunnelSettings Clone(CloudflareTunnelSettings settings)
    {
        return new CloudflareTunnelSettings(settings.Enabled, settings.TunnelToken);
    }

    private sealed class CloudflareTunnelSettingsRow
    {
        public bool Enabled { get; init; }

        public string? TunnelToken { get; init; }
    }
}

public sealed record CloudflareTunnelSettings(bool Enabled, string? TunnelToken);
