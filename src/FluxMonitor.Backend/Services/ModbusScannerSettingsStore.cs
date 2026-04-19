using Dapper;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class ModbusScannerSettingsStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<ModbusScannerSettingsStore> logger)
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
            logger.LogInformation("Modbus scanner saved settings store initialized.");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<ModbusScannerSavedSettingsSnapshot> GetSnapshotAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!HasDatabase)
        {
            return new ModbusScannerSavedSettingsSnapshot
            {
                StorageAvailable = false
            };
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var rows = await connection.QueryAsync<ModbusScannerSettingRow>(new CommandDefinition("""
            SELECT
                name AS "Name",
                updated_at AT TIME ZONE 'UTC' AS "UpdatedAtUtc",
                port_name AS "PortName",
                slave_address AS "SlaveAddress",
                baud_rate AS "BaudRate",
                parity AS "Parity",
                data_bits AS "DataBits",
                stop_bits AS "StopBits",
                response_timeout_ms AS "ResponseTimeoutMs",
                retry_count AS "RetryCount",
                start_register AS "StartRegister",
                register_count AS "RegisterCount",
                registers_per_request AS "RegistersPerRequest",
                register_kind AS "RegisterKind"
            FROM modbus_scanner_saved_settings
            ORDER BY updated_at DESC, name;
            """, cancellationToken: cancellationToken));

        return new ModbusScannerSavedSettingsSnapshot
        {
            StorageAvailable = true,
            Settings = rows.Select(MapSavedSetting).ToList()
        };
    }

    public async Task<ModbusScannerSavedSetting> SaveAsync(
        string? name,
        ModbusScannerReadRequest request,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Modbus scanner settings cannot be saved until PostgreSQL storage is configured.");
        }

        var normalizedName = NormalizeName(name);
        var normalizedRequest = ModbusScannerService.NormalizeRequest(request);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var row = await connection.QuerySingleAsync<ModbusScannerSettingRow>(new CommandDefinition("""
            INSERT INTO modbus_scanner_saved_settings (
                name,
                port_name,
                slave_address,
                baud_rate,
                parity,
                data_bits,
                stop_bits,
                response_timeout_ms,
                retry_count,
                start_register,
                register_count,
                registers_per_request,
                register_kind,
                updated_at)
            VALUES (
                @Name,
                @PortName,
                @SlaveAddress,
                @BaudRate,
                @Parity,
                @DataBits,
                @StopBits,
                @ResponseTimeoutMs,
                @RetryCount,
                @StartRegister,
                @RegisterCount,
                @RegistersPerRequest,
                @RegisterKind,
                NOW())
            ON CONFLICT (name) DO UPDATE
            SET
                port_name = EXCLUDED.port_name,
                slave_address = EXCLUDED.slave_address,
                baud_rate = EXCLUDED.baud_rate,
                parity = EXCLUDED.parity,
                data_bits = EXCLUDED.data_bits,
                stop_bits = EXCLUDED.stop_bits,
                response_timeout_ms = EXCLUDED.response_timeout_ms,
                retry_count = EXCLUDED.retry_count,
                start_register = EXCLUDED.start_register,
                register_count = EXCLUDED.register_count,
                registers_per_request = EXCLUDED.registers_per_request,
                register_kind = EXCLUDED.register_kind,
                updated_at = NOW()
            RETURNING
                name AS "Name",
                updated_at AT TIME ZONE 'UTC' AS "UpdatedAtUtc",
                port_name AS "PortName",
                slave_address AS "SlaveAddress",
                baud_rate AS "BaudRate",
                parity AS "Parity",
                data_bits AS "DataBits",
                stop_bits AS "StopBits",
                response_timeout_ms AS "ResponseTimeoutMs",
                retry_count AS "RetryCount",
                start_register AS "StartRegister",
                register_count AS "RegisterCount",
                registers_per_request AS "RegistersPerRequest",
                register_kind AS "RegisterKind";
            """, new
        {
            Name = normalizedName,
            normalizedRequest.PortName,
            normalizedRequest.SlaveAddress,
            normalizedRequest.BaudRate,
            normalizedRequest.Parity,
            normalizedRequest.DataBits,
            normalizedRequest.StopBits,
            normalizedRequest.ResponseTimeoutMs,
            normalizedRequest.RetryCount,
            normalizedRequest.StartRegister,
            normalizedRequest.RegisterCount,
            normalizedRequest.RegistersPerRequest,
            normalizedRequest.RegisterKind
        }, cancellationToken: cancellationToken));

        return MapSavedSetting(row);
    }

    public async Task DeleteAsync(string? name, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Modbus scanner settings cannot be deleted until PostgreSQL storage is configured.");
        }

        var normalizedName = NormalizeName(name);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        var deleted = await connection.ExecuteAsync(new CommandDefinition("""
            DELETE FROM modbus_scanner_saved_settings
            WHERE name = @Name;
            """, new { Name = normalizedName }, cancellationToken: cancellationToken));

        if (deleted == 0)
        {
            throw new InvalidOperationException($"No saved Modbus scanner setting named '{normalizedName}' exists.");
        }
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        await connection.ExecuteAsync(new CommandDefinition("""
            CREATE TABLE IF NOT EXISTS modbus_scanner_saved_settings (
                name text PRIMARY KEY,
                port_name text NOT NULL,
                slave_address integer NOT NULL,
                baud_rate integer NOT NULL,
                parity text NOT NULL,
                data_bits integer NOT NULL,
                stop_bits integer NOT NULL,
                response_timeout_ms integer NOT NULL,
                retry_count integer NOT NULL,
                start_register integer NOT NULL,
                register_count integer NOT NULL,
                registers_per_request integer NOT NULL,
                register_kind text NOT NULL,
                updated_at timestamptz NOT NULL DEFAULT NOW()
            );
            """, cancellationToken: cancellationToken));
    }

    private static string NormalizeName(string? name)
    {
        var normalized = name?.Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            throw new InvalidOperationException("A saved settings name is required.");
        }

        if (normalized.Length > 80)
        {
            throw new InvalidOperationException("Saved settings names must be 80 characters or fewer.");
        }

        return normalized;
    }

    private static ModbusScannerSavedSetting MapSavedSetting(ModbusScannerSettingRow row)
    {
        return new ModbusScannerSavedSetting
        {
            Name = row.Name,
            UpdatedAtUtc = DateTime.SpecifyKind(row.UpdatedAtUtc, DateTimeKind.Utc).ToString("O"),
            Settings = new ModbusScannerReadRequest
            {
                PortName = row.PortName,
                SlaveAddress = row.SlaveAddress,
                BaudRate = row.BaudRate,
                Parity = row.Parity,
                DataBits = row.DataBits,
                StopBits = row.StopBits,
                ResponseTimeoutMs = row.ResponseTimeoutMs,
                RetryCount = row.RetryCount,
                StartRegister = row.StartRegister,
                RegisterCount = row.RegisterCount,
                RegistersPerRequest = row.RegistersPerRequest,
                RegisterKind = row.RegisterKind
            }
        };
    }

    private sealed class ModbusScannerSettingRow
    {
        public required string Name { get; init; }
        public DateTime UpdatedAtUtc { get; init; }
        public required string PortName { get; init; }
        public int SlaveAddress { get; init; }
        public int BaudRate { get; init; }
        public required string Parity { get; init; }
        public int DataBits { get; init; }
        public int StopBits { get; init; }
        public int ResponseTimeoutMs { get; init; }
        public int RetryCount { get; init; }
        public int StartRegister { get; init; }
        public int RegisterCount { get; init; }
        public int RegistersPerRequest { get; init; }
        public required string RegisterKind { get; init; }
    }
}
