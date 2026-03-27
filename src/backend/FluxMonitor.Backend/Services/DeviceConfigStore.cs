using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Postgres-backed store for device configurations. Falls back to in-memory
/// when no database connection string is configured.
/// On first initialisation the store imports devices from appsettings (legacy)
/// and removes them from the file-based config.
/// </summary>
public sealed class DeviceConfigStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<DeviceConfigStore> logger,
    DeviceDefinitionLoader definitionLoader)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IReadOnlyList<DeviceConfiguration> _seedDevices = configuration.Value.Devices;
    private readonly DeviceDefinitionLoader _definitionLoader = definitionLoader;
    private readonly object _cacheLock = new();
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private IReadOnlyList<DeviceConfiguration> _devices = [];
    private volatile bool _initialized;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized) return;

        await _initializationLock.WaitAsync(cancellationToken);
        try
        {
            if (_initialized) return;

            if (!HasDatabase)
            {
                logger.LogError("PostgreSQL storage is not configured. Device configuration is unavailable until setup is completed.");
                lock (_cacheLock) { _devices = []; }
                _initialized = true;
                return;
            }

            await using var connection = await OpenConnectionAsync(cancellationToken);

            await EnsureSchemaAsync(connection);

                var existing = await LoadFromDbAsync(connection);
                if (existing is null && _seedDevices.Count > 0)
                {
                    logger.LogInformation("Importing {Count} device(s) from appsettings into database.", _seedDevices.Count);
                    var normalizedSeedDevices = NormalizeDevices(_seedDevices);
                    await SaveToDbAsync(connection, normalizedSeedDevices);
                    existing = normalizedSeedDevices;
                }

            lock (_cacheLock) { _devices = NormalizeDevices(existing ?? []); }

            _initialized = true;
            logger.LogInformation("Loaded {Count} device(s) from database.", _devices.Count);
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public IReadOnlyList<DeviceConfiguration> GetDevices()
    {
        EnsureInitialized();
        lock (_cacheLock) { return _devices; }
    }

    public async Task<IReadOnlyList<DeviceConfiguration>> SaveDevicesAsync(
        IReadOnlyList<DeviceConfiguration> devices, CancellationToken cancellationToken)
    {
        EnsureInitialized();

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Device configuration cannot be saved until PostgreSQL storage is configured.");
        }

        var normalizedDevices = NormalizeDevices(devices);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await SaveToDbAsync(connection, normalizedDevices);

        lock (_cacheLock) { _devices = normalizedDevices; }
        logger.LogInformation("Saved {Count} device(s) to database.", normalizedDevices.Count);
        return normalizedDevices;
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
            throw new InvalidOperationException("DeviceConfigStore has not been initialized. Call InitializeAsync first.");
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS device_config (
                id          INTEGER PRIMARY KEY DEFAULT 1,
                devices_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT  device_config_singleton CHECK (id = 1)
            );
            """;

        await connection.ExecuteAsync(sql);
    }

    private static async Task<IReadOnlyList<DeviceConfiguration>?> LoadFromDbAsync(NpgsqlConnection connection)
    {
        const string sql = "SELECT devices_json FROM device_config WHERE id = 1;";

        var result = await connection.ExecuteScalarAsync<string?>(sql);

        if (result is null)
            return null;

        return JsonSerializer.Deserialize<List<DeviceConfiguration>>(result, JsonOptions) ?? [];
    }

    private static async Task SaveToDbAsync(NpgsqlConnection connection, IReadOnlyList<DeviceConfiguration> devices)
    {
        const string sql = """
            INSERT INTO device_config (id, devices_json, updated_at)
            VALUES (1, @Json::jsonb, NOW())
            ON CONFLICT (id) DO UPDATE SET devices_json = @Json::jsonb, updated_at = NOW();
            """;

        var json = JsonSerializer.Serialize(devices, JsonOptions);
        await connection.ExecuteAsync(sql, new { Json = json });
    }

    private IReadOnlyList<DeviceConfiguration> NormalizeDevices(IReadOnlyList<DeviceConfiguration> devices)
    {
        if (devices.Count == 0)
        {
            return devices;
        }

        return devices
            .Select(device => DevicePollingIntervalResolver.Normalize(device, _definitionLoader))
            .ToArray();
    }
}
