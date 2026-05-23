using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// PostgreSQL-backed store for device instances.
/// Each device row contains the resolved definition snapshot used by the runtime.
/// </summary>
public sealed class DeviceConfigStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<DeviceConfigStore> logger,
    DeviceDefinitionLoader definitionLoader)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    private readonly DeviceDefinitionLoader _definitionLoader = definitionLoader;
    private readonly object _cacheLock = new();
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private IReadOnlyList<DeviceConfiguration> _devices = [];
    private IReadOnlyDictionary<string, int> _persistedDeviceIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
    private IReadOnlyList<string> _rememberedDeviceIds = [];
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
                lock (_cacheLock)
                {
                    _devices = [];
                    _persistedDeviceIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                    _rememberedDeviceIds = [];
                }

                _initialized = true;
                return;
            }

            await using var connection = await OpenConnectionAsync(cancellationToken);
            await EnsureSchemaAsync(connection);

            var loadedDevices = await LoadFromDbAsync(connection);
            loadedDevices = await ReconcileDefinitionsAsync(connection, loadedDevices);
            UpdateCache(loadedDevices);

            _initialized = true;
            logger.LogInformation("Loaded {Count} device(s) from database.", loadedDevices.Devices.Count);
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public IReadOnlyList<DeviceConfiguration> GetDevices()
    {
        EnsureInitialized();
        lock (_cacheLock)
        {
            return _devices;
        }
    }

    public IReadOnlyList<string> GetRememberedDeviceIds()
    {
        EnsureInitialized();
        lock (_cacheLock)
        {
            return _rememberedDeviceIds;
        }
    }

    public async Task ReloadAsync(CancellationToken cancellationToken)
    {
        EnsureInitialized();

        if (!HasDatabase)
        {
            lock (_cacheLock)
            {
                _devices = [];
                _persistedDeviceIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                _rememberedDeviceIds = [];
            }

            return;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var loadedDevices = await LoadFromDbAsync(connection);
        UpdateCache(loadedDevices);
    }

    public bool TryGetPersistedDeviceId(string deviceKey, out int deviceId)
    {
        EnsureInitialized();
        lock (_cacheLock)
        {
            return _persistedDeviceIds.TryGetValue(deviceKey, out deviceId);
        }
    }

    public int GetPersistedDeviceId(string deviceKey)
    {
        if (TryGetPersistedDeviceId(deviceKey, out var deviceId))
        {
            return deviceId;
        }

        throw new InvalidOperationException($"Device '{deviceKey}' is not present in the persisted configuration.");
    }

    public async Task<IReadOnlyList<DeviceConfiguration>> SaveDevicesAsync(
        IReadOnlyList<DeviceConfiguration> devices,
        CancellationToken cancellationToken)
    {
        EnsureInitialized();

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Device configuration cannot be saved until PostgreSQL storage is configured.");
        }

        var materializedDevices = MaterializeDevices(devices);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await RememberDeviceIdsAsync(connection, transaction, materializedDevices.Select(device => device.DeviceId).ToArray());
        await UpsertDevicesAsync(connection, transaction, materializedDevices);
        await DeleteRemovedDevicesAsync(connection, transaction, materializedDevices.Select(device => device.DeviceId).ToArray());

        await transaction.CommitAsync(cancellationToken);

        var reloadedDevices = await LoadFromDbAsync(connection);
        UpdateCache(reloadedDevices);

        logger.LogInformation("Saved {Count} device(s) to database.", reloadedDevices.Devices.Count);
        return reloadedDevices.Devices;
    }

    private void EnsureInitialized()
    {
        if (!_initialized)
        {
            throw new InvalidOperationException("DeviceConfigStore has not been initialized. Call InitializeAsync first.");
        }
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS "Devices" (
                "DeviceId" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                "DeviceKey" TEXT NOT NULL UNIQUE,
                "DisplayName" TEXT NOT NULL,
                "SortOrder" INTEGER NOT NULL DEFAULT 0,
                "DefinitionId" TEXT NOT NULL,
                "DefinitionVersion" TEXT NULL,
                "DefinitionJson" JSONB NOT NULL,
                "DefinitionHash" TEXT NOT NULL,
                "HasDefinitionOverride" BOOLEAN NOT NULL DEFAULT FALSE,
                "TransportPortName" TEXT NULL,
                "BleSettingsPin" TEXT NULL,
                "HttpUsername" TEXT NULL,
                "HttpPassword" TEXT NULL,
                "Address" SMALLINT NOT NULL,
                "IsMaster" BOOLEAN NOT NULL DEFAULT FALSE,
                "PollIntervalMilliseconds" INTEGER NOT NULL,
                "Enabled" BOOLEAN NOT NULL DEFAULT TRUE,
                "CellVoltageSmoothingFactor" NUMERIC NOT NULL DEFAULT 0,
                "CellVoltageSmoothingBreakoutMillivolts" INTEGER NOT NULL DEFAULT 0,
                "DisplayPrecisionJson" JSONB NOT NULL DEFAULT '{}'::jsonb,
                "TemperatureUnit" TEXT NOT NULL DEFAULT 'c',
                "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS "RememberedDeviceIds" (
                "DeviceKey" TEXT NOT NULL PRIMARY KEY,
                "LastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            """;

        await connection.ExecuteAsync(sql);
        await connection.ExecuteAsync("""
            ALTER TABLE "Devices"
            ADD COLUMN IF NOT EXISTS "HasDefinitionOverride" BOOLEAN NOT NULL DEFAULT FALSE;
            """);
        await connection.ExecuteAsync("""
            ALTER TABLE "Devices"
            ADD COLUMN IF NOT EXISTS "SortOrder" INTEGER NOT NULL DEFAULT 0;
            """);
        await connection.ExecuteAsync("""
            ALTER TABLE "Devices"
            ADD COLUMN IF NOT EXISTS "TemperatureUnit" TEXT NOT NULL DEFAULT 'c';
            """);
        await connection.ExecuteAsync("""
            ALTER TABLE "Devices"
            ADD COLUMN IF NOT EXISTS "HttpUsername" TEXT NULL;
            """);
        await connection.ExecuteAsync("""
            ALTER TABLE "Devices"
            ADD COLUMN IF NOT EXISTS "HttpPassword" TEXT NULL;
            """);
    }

    private async Task<LoadedDevices> LoadFromDbAsync(NpgsqlConnection connection)
    {
        const string sql = """
            SELECT
                "DeviceId",
                "DeviceKey",
                "DisplayName",
                "SortOrder",
                "DefinitionId",
                "DefinitionVersion",
                "DefinitionJson"::text AS "DefinitionJson",
                "DefinitionHash",
                "HasDefinitionOverride",
                "TransportPortName",
                "BleSettingsPin",
                "HttpUsername",
                "HttpPassword",
                "Address",
                "IsMaster",
                "PollIntervalMilliseconds",
                "Enabled",
                "CellVoltageSmoothingFactor",
                "CellVoltageSmoothingBreakoutMillivolts",
                "DisplayPrecisionJson"::text AS "DisplayPrecisionJson",
                "TemperatureUnit"
            FROM "Devices"
            ORDER BY "SortOrder", "DisplayName", "DeviceKey";
            """;

        var rows = (await connection.QueryAsync<StoredDeviceRow>(sql)).ToArray();
        var rememberedIds = (await connection.QueryAsync<string>("""
            SELECT "DeviceKey"
            FROM "RememberedDeviceIds"
            ORDER BY "LastSeenAt" DESC, "DeviceKey";
            """)).ToArray();

        var devices = rows
            .Select(row => new DeviceConfiguration
            {
                DeviceId = row.DeviceKey,
                DisplayName = row.DisplayName,
                SortOrder = row.SortOrder,
                DefinitionId = row.DefinitionId,
                TransportPortName = row.TransportPortName,
                BleSettingsPin = row.BleSettingsPin,
                HttpUsername = row.HttpUsername,
                HttpPassword = row.HttpPassword,
                Address = checked((byte)row.Address),
                IsMaster = row.IsMaster,
                PollIntervalMilliseconds = row.PollIntervalMilliseconds,
                Enabled = row.Enabled,
                CellVoltageSmoothingFactor = row.CellVoltageSmoothingFactor,
                CellVoltageSmoothingBreakoutMillivolts = row.CellVoltageSmoothingBreakoutMillivolts,
                DisplayPrecision = DeserializeDisplayPrecision(row.DisplayPrecisionJson),
                TemperatureUnit = string.Equals(row.TemperatureUnit, "f", StringComparison.OrdinalIgnoreCase) ? "f" : "c",
                DefinitionVersion = row.DefinitionVersion,
                HasDefinitionOverride = row.HasDefinitionOverride,
                DefinitionJson = row.DefinitionJson,
                DefinitionHash = row.DefinitionHash
            })
            .ToArray();

        var persistedIds = rows.ToDictionary(row => row.DeviceKey, row => row.DeviceId, StringComparer.OrdinalIgnoreCase);
        return new LoadedDevices(devices, persistedIds, rememberedIds);
    }

    /// <summary>
    /// If any device's file-based definition has changed since the DB snapshot was
    /// written, update the DB row so the runtime uses the current definition.
    /// This ensures definition changes deployed via the installer take effect on
    /// the next service start without requiring a manual API re-save.
    /// </summary>
    private async Task<LoadedDevices> ReconcileDefinitionsAsync(
        NpgsqlConnection connection,
        LoadedDevices loaded)
    {
        var staleDevices = new List<DeviceConfiguration>();
        foreach (var device in loaded.Devices)
        {
            if (device.HasDefinitionOverride)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(device.DefinitionId))
                continue;

            if (!_definitionLoader.TryGet(device.DefinitionId, out var fileDefinition) || fileDefinition is null)
                continue;

            var fileJson = JsonSerializer.Serialize(fileDefinition, JsonOptions);
            var fileHash = ComputeSha256(fileJson);
            if (string.Equals(fileHash, device.DefinitionHash, StringComparison.OrdinalIgnoreCase))
                continue;

            staleDevices.Add(new DeviceConfiguration
            {
                DeviceId = device.DeviceId,
                DisplayName = device.DisplayName,
                DefinitionId = device.DefinitionId,
                TransportPortName = device.TransportPortName,
                BleSettingsPin = device.BleSettingsPin,
                HttpUsername = device.HttpUsername,
                HttpPassword = device.HttpPassword,
                Address = device.Address,
                IsMaster = device.IsMaster,
                SortOrder = device.SortOrder,
                Enabled = device.Enabled,
                CellVoltageSmoothingFactor = device.CellVoltageSmoothingFactor,
                CellVoltageSmoothingBreakoutMillivolts = device.CellVoltageSmoothingBreakoutMillivolts,
                DisplayPrecision = device.DisplayPrecision,
                TemperatureUnit = device.TemperatureUnit,
                HasDefinitionOverride = false,
                DefinitionJson = fileJson,
                DefinitionHash = fileHash,
                DefinitionVersion = fileDefinition.Version,
                PollIntervalMilliseconds = DevicePollingIntervalResolver.Resolve(fileDefinition)
            });
        }

        if (staleDevices.Count == 0)
            return loaded;

        await using var transaction = await connection.BeginTransactionAsync();
        await UpsertDevicesAsync(connection, transaction, staleDevices);
        await transaction.CommitAsync();

        foreach (var device in staleDevices)
        {
            logger.LogInformation(
                "Reconciled stale definition snapshot for device {DeviceId}. DefinitionId={DefinitionId}.",
                device.DeviceId,
                device.DefinitionId);
        }

        return await LoadFromDbAsync(connection);
    }

    private static DisplayPrecisionConfiguration DeserializeDisplayPrecision(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return new DisplayPrecisionConfiguration();
        }

        return JsonSerializer.Deserialize<DisplayPrecisionConfiguration>(json, JsonOptions)
            ?? new DisplayPrecisionConfiguration();
    }

    private IReadOnlyList<DeviceConfiguration> MaterializeDevices(IReadOnlyList<DeviceConfiguration> devices)
    {
        var normalizedDevices = new List<DeviceConfiguration>(devices.Count);
        var seenDeviceIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var device in devices)
        {
            if (string.IsNullOrWhiteSpace(device.DeviceId))
            {
                throw new InvalidOperationException("Each device must have a DeviceId.");
            }

            if (!seenDeviceIds.Add(device.DeviceId.Trim()))
            {
                throw new InvalidOperationException($"Duplicate DeviceId '{device.DeviceId}' is not allowed.");
            }

            var definition = device.ResolveDefinition(_definitionLoader);
            var definitionJson = JsonSerializer.Serialize(definition, JsonOptions);
            var definitionHash = ComputeSha256(definitionJson);
            var hasDefinitionOverride = HasDefinitionOverride(device, definition, definitionHash);

            normalizedDevices.Add(new DeviceConfiguration
            {
                DeviceId = device.DeviceId.Trim(),
                DisplayName = string.IsNullOrWhiteSpace(device.DisplayName) ? definition.Device.Name : device.DisplayName.Trim(),
                SortOrder = normalizedDevices.Count,
                DefinitionId = definition.Device.Id,
                TransportPortName = string.IsNullOrWhiteSpace(device.TransportPortName) ? null : device.TransportPortName.Trim(),
                BleSettingsPin = string.IsNullOrWhiteSpace(device.BleSettingsPin) ? null : device.BleSettingsPin.Trim(),
                HttpUsername = string.IsNullOrWhiteSpace(device.HttpUsername) ? null : device.HttpUsername.Trim(),
                HttpPassword = string.IsNullOrWhiteSpace(device.HttpPassword) ? null : device.HttpPassword,
                Address = device.Address,
                IsMaster = device.IsMaster,
                PollIntervalMilliseconds = DevicePollingIntervalResolver.Resolve(definition),
                Enabled = device.Enabled,
                CellVoltageSmoothingFactor = device.CellVoltageSmoothingFactor,
                CellVoltageSmoothingBreakoutMillivolts = device.CellVoltageSmoothingBreakoutMillivolts,
                DisplayPrecision = device.DisplayPrecision,
                TemperatureUnit = string.Equals(device.TemperatureUnit, "f", StringComparison.OrdinalIgnoreCase) ? "f" : "c",
                HasDefinitionOverride = hasDefinitionOverride,
                DefinitionVersion = definition.Version,
                DefinitionJson = definitionJson,
                DefinitionHash = definitionHash
            });
        }

        return normalizedDevices;
    }

    private static async Task UpsertDevicesAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        IReadOnlyList<DeviceConfiguration> devices)
    {
        const string sql = """
            INSERT INTO "Devices" (
                "DeviceKey",
                "DisplayName",
                "SortOrder",
                "DefinitionId",
                "DefinitionVersion",
                "DefinitionJson",
                "DefinitionHash",
                "HasDefinitionOverride",
                "TransportPortName",
                "BleSettingsPin",
                "HttpUsername",
                "HttpPassword",
                "Address",
                "IsMaster",
                "PollIntervalMilliseconds",
                "Enabled",
                "CellVoltageSmoothingFactor",
                "CellVoltageSmoothingBreakoutMillivolts",
                "DisplayPrecisionJson",
                "TemperatureUnit",
                "UpdatedAt"
            )
            VALUES (
                @DeviceKey,
                @DisplayName,
                @SortOrder,
                @DefinitionId,
                @DefinitionVersion,
                @DefinitionJson::jsonb,
                @DefinitionHash,
                @HasDefinitionOverride,
                @TransportPortName,
                @BleSettingsPin,
                @HttpUsername,
                @HttpPassword,
                @Address,
                @IsMaster,
                @PollIntervalMilliseconds,
                @Enabled,
                @CellVoltageSmoothingFactor,
                @CellVoltageSmoothingBreakoutMillivolts,
                @DisplayPrecisionJson::jsonb,
                @TemperatureUnit,
                NOW()
            )
            ON CONFLICT ("DeviceKey") DO UPDATE SET
                "DisplayName" = EXCLUDED."DisplayName",
                "SortOrder" = EXCLUDED."SortOrder",
                "DefinitionId" = EXCLUDED."DefinitionId",
                "DefinitionVersion" = EXCLUDED."DefinitionVersion",
                "DefinitionJson" = EXCLUDED."DefinitionJson",
                "DefinitionHash" = EXCLUDED."DefinitionHash",
                "HasDefinitionOverride" = EXCLUDED."HasDefinitionOverride",
                "TransportPortName" = EXCLUDED."TransportPortName",
                "BleSettingsPin" = EXCLUDED."BleSettingsPin",
                "HttpUsername" = EXCLUDED."HttpUsername",
                "HttpPassword" = EXCLUDED."HttpPassword",
                "Address" = EXCLUDED."Address",
                "IsMaster" = EXCLUDED."IsMaster",
                "PollIntervalMilliseconds" = EXCLUDED."PollIntervalMilliseconds",
                "Enabled" = EXCLUDED."Enabled",
                "CellVoltageSmoothingFactor" = EXCLUDED."CellVoltageSmoothingFactor",
                "CellVoltageSmoothingBreakoutMillivolts" = EXCLUDED."CellVoltageSmoothingBreakoutMillivolts",
                "DisplayPrecisionJson" = EXCLUDED."DisplayPrecisionJson",
                "TemperatureUnit" = EXCLUDED."TemperatureUnit",
                "UpdatedAt" = NOW();
            """;

        foreach (var device in devices)
        {
            await connection.ExecuteAsync(
                new CommandDefinition(
                    sql,
                    new
                    {
                        DeviceKey = device.DeviceId,
                        device.DisplayName,
                        device.SortOrder,
                        device.DefinitionId,
                        device.DefinitionVersion,
                        device.DefinitionJson,
                        device.DefinitionHash,
                        device.HasDefinitionOverride,
                        device.TransportPortName,
                        device.BleSettingsPin,
                        device.HttpUsername,
                        device.HttpPassword,
                        device.Address,
                        device.IsMaster,
                        device.PollIntervalMilliseconds,
                        device.Enabled,
                        device.CellVoltageSmoothingFactor,
                        device.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecisionJson = JsonSerializer.Serialize(device.DisplayPrecision, JsonOptions),
                        device.TemperatureUnit
                    },
                    transaction));
        }
    }

    private static async Task RememberDeviceIdsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        IReadOnlyCollection<string> deviceKeys)
    {
        if (deviceKeys.Count == 0)
        {
            return;
        }

        const string sql = """
            INSERT INTO "RememberedDeviceIds" (
                "DeviceKey",
                "LastSeenAt"
            )
            VALUES (
                @DeviceKey,
                NOW()
            )
            ON CONFLICT ("DeviceKey") DO UPDATE SET
                "LastSeenAt" = NOW();
            """;

        foreach (var deviceKey in deviceKeys)
        {
            await connection.ExecuteAsync(
                new CommandDefinition(
                    sql,
                    new { DeviceKey = deviceKey },
                    transaction));
        }
    }

    private static async Task DeleteRemovedDevicesAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        IReadOnlyCollection<string> desiredDeviceKeys)
    {
        if (desiredDeviceKeys.Count == 0)
        {
            await connection.ExecuteAsync(
                new CommandDefinition("""DELETE FROM "Devices";""", transaction: transaction));
            return;
        }

        const string sql = """
            DELETE FROM "Devices"
            WHERE "DeviceKey" <> ALL(@DeviceKeys);
            """;

        await connection.ExecuteAsync(
            new CommandDefinition(
                sql,
                new { DeviceKeys = desiredDeviceKeys.ToArray() },
                transaction));
    }

    private void UpdateCache(LoadedDevices loadedDevices)
    {
        lock (_cacheLock)
        {
            _devices = loadedDevices.Devices;
            _persistedDeviceIds = loadedDevices.PersistedDeviceIds;
            _rememberedDeviceIds = loadedDevices.RememberedDeviceIds;
        }
    }

    private static string ComputeSha256(string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value);
        var hash = SHA256.HashData(bytes);
        return Convert.ToHexString(hash);
    }

    private bool HasDefinitionOverride(
        DeviceConfiguration device,
        FluxMonitor.Contracts.DeviceDefinition.DeviceDefinition definition,
        string definitionHash)
    {
        if (_definitionLoader.TryGet(definition.Device.Id, out var catalogDefinition) &&
            catalogDefinition is not null)
        {
            var catalogJson = JsonSerializer.Serialize(catalogDefinition, JsonOptions);
            var catalogHash = ComputeSha256(catalogJson);
            return !string.Equals(definitionHash, catalogHash, StringComparison.OrdinalIgnoreCase);
        }

        return !string.IsNullOrWhiteSpace(device.DefinitionJson);
    }

    private sealed class StoredDeviceRow
    {
        public int DeviceId { get; set; }
        public string DeviceKey { get; set; } = string.Empty;
        public string DisplayName { get; set; } = string.Empty;
        public int SortOrder { get; set; }
        public string DefinitionId { get; set; } = string.Empty;
        public string? DefinitionVersion { get; set; }
        public string DefinitionJson { get; set; } = string.Empty;
        public string DefinitionHash { get; set; } = string.Empty;
        public bool HasDefinitionOverride { get; set; }
        public string? TransportPortName { get; set; }
        public string? BleSettingsPin { get; set; }
        public string? HttpUsername { get; set; }
        public string? HttpPassword { get; set; }
        public short Address { get; set; }
        public bool IsMaster { get; set; }
        public int PollIntervalMilliseconds { get; set; }
        public bool Enabled { get; set; }
        public decimal CellVoltageSmoothingFactor { get; set; }
        public int CellVoltageSmoothingBreakoutMillivolts { get; set; }
        public string? DisplayPrecisionJson { get; set; }
        public string TemperatureUnit { get; set; } = "c";
    }

    private sealed record LoadedDevices(
        IReadOnlyList<DeviceConfiguration> Devices,
        IReadOnlyDictionary<string, int> PersistedDeviceIds,
        IReadOnlyList<string> RememberedDeviceIds);
}
