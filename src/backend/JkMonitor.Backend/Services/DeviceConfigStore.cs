using System.Text.Json;
using System.Text.Json.Serialization;
using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Postgres-backed store for device configurations. Falls back to in-memory
/// when no database connection string is configured.
/// On first initialisation the store imports devices from appsettings (legacy)
/// and removes them from the file-based config.
/// </summary>
public sealed class DeviceConfigStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<DeviceConfigStore> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _connectionString = configuration.Value.Storage.ConnectionString;
    private readonly IReadOnlyList<DeviceConfiguration> _seedDevices = configuration.Value.Devices;
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

            if (string.IsNullOrWhiteSpace(_connectionString))
            {
                logger.LogWarning("No database connection string configured — device config will use seed values from appsettings (read-only).");
                lock (_cacheLock) { _devices = _seedDevices; }
                _initialized = true;
                return;
            }

            await using var connection = new NpgsqlConnection(_connectionString);
            await connection.OpenAsync(cancellationToken);

            await EnsureSchemaAsync(connection, cancellationToken);

            var existing = await LoadFromDbAsync(connection, cancellationToken);
            if (existing is null && _seedDevices.Count > 0)
            {
                logger.LogInformation("Importing {Count} device(s) from appsettings into database.", _seedDevices.Count);
                await SaveToDbAsync(connection, _seedDevices, cancellationToken);
                existing = _seedDevices;
            }

            lock (_cacheLock) { _devices = existing ?? []; }

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

        if (string.IsNullOrWhiteSpace(_connectionString))
        {
            lock (_cacheLock) { _devices = devices; }
            logger.LogInformation("Saved {Count} device(s) in memory (no database).", devices.Count);
            return devices;
        }

        await using var connection = new NpgsqlConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await SaveToDbAsync(connection, devices, cancellationToken);

        lock (_cacheLock) { _devices = devices; }
        logger.LogInformation("Saved {Count} device(s) to database.", devices.Count);
        return devices;
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
            throw new InvalidOperationException("DeviceConfigStore has not been initialized. Call InitializeAsync first.");
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS device_config (
                id          INTEGER PRIMARY KEY DEFAULT 1,
                devices_json JSONB NOT NULL DEFAULT '[]'::jsonb,
                updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT  device_config_singleton CHECK (id = 1)
            );
            """;

        await using var cmd = new NpgsqlCommand(sql, connection);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<IReadOnlyList<DeviceConfiguration>?> LoadFromDbAsync(
        NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = "SELECT devices_json FROM device_config WHERE id = 1;";

        await using var cmd = new NpgsqlCommand(sql, connection);
        var result = await cmd.ExecuteScalarAsync(cancellationToken);

        if (result is null or DBNull)
            return null;

        var json = result.ToString()!;
        return JsonSerializer.Deserialize<List<DeviceConfiguration>>(json, JsonOptions) ?? [];
    }

    private static async Task SaveToDbAsync(
        NpgsqlConnection connection, IReadOnlyList<DeviceConfiguration> devices, CancellationToken cancellationToken)
    {
        const string sql = """
            INSERT INTO device_config (id, devices_json, updated_at)
            VALUES (1, @json, NOW())
            ON CONFLICT (id) DO UPDATE SET devices_json = @json, updated_at = NOW();
            """;

        var json = JsonSerializer.Serialize(devices, JsonOptions);

        await using var cmd = new NpgsqlCommand(sql, connection);
        cmd.Parameters.Add(new NpgsqlParameter("@json", NpgsqlDbType.Jsonb) { Value = json });
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }
}
