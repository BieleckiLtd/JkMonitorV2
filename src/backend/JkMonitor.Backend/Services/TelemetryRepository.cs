using System.Collections.Concurrent;
using System.Text.Json;
using JkMonitor.Backend.Models;
using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace JkMonitor.Backend.Services;

public interface ITelemetryRepository
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken);

    Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    Task ApplyRetentionAsync(CancellationToken cancellationToken);

    Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken);

    Task ExportAsync(Stream destination, CancellationToken cancellationToken);

    Task ImportAsync(Stream source, CancellationToken cancellationToken);
}

public sealed record TableSizeInfo(string TableName, long SizeBytes, string SizeFormatted, long RowCount);

public sealed record DatabaseSizeInfo(long TotalSizeBytes, string TotalSizeFormatted, IReadOnlyList<TableSizeInfo> Tables);

public sealed record HistoryDataPoint(
    DateTimeOffset Timestamp,
    decimal? TotalVoltageVolts,
    decimal? CurrentAmps,
    decimal? PowerWatts,
    decimal? StateOfChargePercent,
    decimal? MinCellVoltageVolts,
    decimal? MaxCellVoltageVolts,
    decimal? DeltaCellVoltageVolts,
    decimal? MosTemperatureCelsius,
    decimal? BatteryTemperatureCelsius);

public sealed record CellHistoryDataPoint(
    DateTimeOffset Timestamp,
    decimal? VoltageVolts);

public sealed class NoOpTelemetryRepository : ITelemetryRepository
{
    public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<HistoryDataPoint>>([]);

    public Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<CellHistoryDataPoint>>([]);

    public Task ApplyRetentionAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken)
        => Task.FromResult(new DatabaseSizeInfo(0, "0 B", []));

    public Task ExportAsync(Stream destination, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task ImportAsync(Stream source, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class TimescaleTelemetryRepository(
    IOptions<MonitorConfiguration> configuration,
    ILogger<TimescaleTelemetryRepository> logger) : ITelemetryRepository
{
    private readonly MonitorConfiguration _config = configuration.Value;
    private readonly StorageConfiguration _storage = configuration.Value.Storage;
    private readonly RetentionConfiguration _retention = configuration.Value.Storage.Retention;
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private volatile bool _initialized;
    private readonly ConcurrentDictionary<string, bool> _deviceDbInitialized = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _deviceDbLocks = new(StringComparer.OrdinalIgnoreCase);

    private static readonly string[] RollupTables = ["jk_rollup_1m", "jk_rollup_5m", "jk_rollup_1h"];
    private const int RetentionDeleteBatchSize = 5_000;
    private const int RetentionDeleteCommandTimeoutSeconds = 120;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized) return;

        await _initializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_initialized) return;

            await using var connection = new NpgsqlConnection(_storage.ConnectionString);
            await connection.OpenAsync(cancellationToken);

            await ExecuteNonQueryAsync(connection, @"
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS jk_raw_samples (
    sampled_at timestamptz NOT NULL,
    device_id text NOT NULL,
    display_name text NOT NULL,
    protocol text NOT NULL,
    register_profile text NOT NULL,
    raw_frame_hex text NOT NULL,
    snapshot jsonb NOT NULL,
    raw_registers jsonb NOT NULL,
    total_voltage_volts numeric NULL,
    current_amps numeric NULL,
    power_watts numeric NULL,
    state_of_charge_percent numeric NULL,
    min_cell_voltage_volts numeric NULL,
    max_cell_voltage_volts numeric NULL,
    delta_cell_voltage_volts numeric NULL,
    mos_temperature_celsius numeric NULL,
    battery_temperature_celsius numeric NULL,
    charging_enabled boolean NULL,
    discharging_enabled boolean NULL,
    balancing_enabled boolean NULL,
    battery_online boolean NULL,
    cell_voltages jsonb NULL
);

SELECT create_hypertable('jk_raw_samples', by_range('sampled_at'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS ix_jk_raw_samples_device_sampled_at
    ON jk_raw_samples (device_id, sampled_at DESC);
", cancellationToken);

            // Add columns to existing tables if they don't exist (safe migration).
            await ExecuteNonQueryAsync(connection, @"
DO $$ BEGIN
  ALTER TABLE jk_raw_samples ADD COLUMN IF NOT EXISTS mos_temperature_celsius numeric NULL;
  ALTER TABLE jk_raw_samples ADD COLUMN IF NOT EXISTS battery_temperature_celsius numeric NULL;
  ALTER TABLE jk_raw_samples ADD COLUMN IF NOT EXISTS cell_voltages jsonb NULL;
END $$;
", cancellationToken);

            foreach (var table in RollupTables)
            {
                await ExecuteNonQueryAsync(connection, $@"
CREATE TABLE IF NOT EXISTS {table} (
    bucket_start timestamptz NOT NULL,
    device_id text NOT NULL,
    sample_count integer NOT NULL,
    avg_total_voltage_volts numeric NULL,
    avg_current_amps numeric NULL,
    avg_power_watts numeric NULL,
    avg_state_of_charge_percent numeric NULL,
    min_cell_voltage_volts numeric NULL,
    max_cell_voltage_volts numeric NULL,
    avg_delta_cell_voltage_volts numeric NULL,
    avg_mos_temperature_celsius numeric NULL,
    avg_battery_temperature_celsius numeric NULL,
    avg_cell_voltages jsonb NULL,
    last_sampled_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_start, device_id)
);

SELECT create_hypertable('{table}', by_range('bucket_start'), if_not_exists => TRUE);

DO $$ BEGIN
  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS avg_mos_temperature_celsius numeric NULL;
  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS avg_battery_temperature_celsius numeric NULL;
  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS avg_cell_voltages jsonb NULL;
END $$;
", cancellationToken);
            }

            _initialized = true;
            logger.LogInformation("TimescaleDB schema is ready.");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    private string GetConnectionString(DeviceConfiguration? device)
    {
        if (device is not null && !string.IsNullOrWhiteSpace(device.DatabaseName))
        {
            var builder = new NpgsqlConnectionStringBuilder(_storage.ConnectionString)
            {
                Database = device.DatabaseName
            };
            return builder.ToString();
        }

        return _storage.ConnectionString;
    }

    private string GetConnectionStringByDeviceId(string deviceId)
    {
        var device = _config.Devices.FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
        return GetConnectionString(device);
    }

    private IReadOnlyList<string> GetAllConnectionStrings()
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { _storage.ConnectionString };
        foreach (var device in _config.Devices)
        {
            if (!string.IsNullOrWhiteSpace(device.DatabaseName))
                set.Add(GetConnectionString(device));
        }
        return set.ToList();
    }

    private async Task EnsureDeviceDbInitializedAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(device.DatabaseName)) return;
        if (_deviceDbInitialized.ContainsKey(device.DatabaseName)) return;

        var dbLock = _deviceDbLocks.GetOrAdd(device.DatabaseName, _ => new SemaphoreSlim(1, 1));
        await dbLock.WaitAsync(cancellationToken);
        try
        {
            if (_deviceDbInitialized.ContainsKey(device.DatabaseName)) return;

            var connStr = GetConnectionString(device);
            await using var connection = new NpgsqlConnection(connStr);
            await connection.OpenAsync(cancellationToken);

            await ExecuteNonQueryAsync(connection, @"
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS jk_raw_samples (
    sampled_at timestamptz NOT NULL,
    device_id text NOT NULL,
    display_name text NOT NULL,
    protocol text NOT NULL,
    register_profile text NOT NULL,
    raw_frame_hex text NOT NULL,
    snapshot jsonb NOT NULL,
    raw_registers jsonb NOT NULL,
    total_voltage_volts numeric NULL,
    current_amps numeric NULL,
    power_watts numeric NULL,
    state_of_charge_percent numeric NULL,
    min_cell_voltage_volts numeric NULL,
    max_cell_voltage_volts numeric NULL,
    delta_cell_voltage_volts numeric NULL,
    mos_temperature_celsius numeric NULL,
    battery_temperature_celsius numeric NULL,
    charging_enabled boolean NULL,
    discharging_enabled boolean NULL,
    balancing_enabled boolean NULL,
    battery_online boolean NULL,
    cell_voltages jsonb NULL
);

SELECT create_hypertable('jk_raw_samples', by_range('sampled_at'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS ix_jk_raw_samples_device_sampled_at
    ON jk_raw_samples (device_id, sampled_at DESC);
", cancellationToken);

            await ExecuteNonQueryAsync(connection, @"
DO $$ BEGIN
  ALTER TABLE jk_raw_samples ADD COLUMN IF NOT EXISTS mos_temperature_celsius numeric NULL;
  ALTER TABLE jk_raw_samples ADD COLUMN IF NOT EXISTS battery_temperature_celsius numeric NULL;
  ALTER TABLE jk_raw_samples ADD COLUMN IF NOT EXISTS cell_voltages jsonb NULL;
END $$;
", cancellationToken);

            foreach (var table in RollupTables)
            {
                await ExecuteNonQueryAsync(connection, $@"
CREATE TABLE IF NOT EXISTS {table} (
    bucket_start timestamptz NOT NULL,
    device_id text NOT NULL,
    sample_count integer NOT NULL,
    avg_total_voltage_volts numeric NULL,
    avg_current_amps numeric NULL,
    avg_power_watts numeric NULL,
    avg_state_of_charge_percent numeric NULL,
    min_cell_voltage_volts numeric NULL,
    max_cell_voltage_volts numeric NULL,
    avg_delta_cell_voltage_volts numeric NULL,
    avg_mos_temperature_celsius numeric NULL,
    avg_battery_temperature_celsius numeric NULL,
    avg_cell_voltages jsonb NULL,
    last_sampled_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_start, device_id)
);

SELECT create_hypertable('{table}', by_range('bucket_start'), if_not_exists => TRUE);

DO $$ BEGIN
  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS avg_mos_temperature_celsius numeric NULL;
  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS avg_battery_temperature_celsius numeric NULL;
  ALTER TABLE {table} ADD COLUMN IF NOT EXISTS avg_cell_voltages jsonb NULL;
END $$;
", cancellationToken);
            }

            _deviceDbInitialized[device.DatabaseName] = true;
            logger.LogInformation("Per-device TimescaleDB schema is ready for database '{DatabaseName}'.", device.DatabaseName);
        }
        finally
        {
            dbLock.Release();
        }
    }

    public async Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);
        await EnsureDeviceDbInitializedAsync(device, cancellationToken);

        var connectionString = GetConnectionString(device);
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = @"
INSERT INTO jk_raw_samples (
    sampled_at, device_id, display_name, protocol, register_profile,
    raw_frame_hex, snapshot, raw_registers,
    total_voltage_volts, current_amps, power_watts, state_of_charge_percent,
    min_cell_voltage_volts, max_cell_voltage_volts, delta_cell_voltage_volts,
    mos_temperature_celsius, battery_temperature_celsius,
    charging_enabled, discharging_enabled, balancing_enabled, battery_online,
    cell_voltages)
VALUES (
    @sampled_at, @device_id, @display_name, @protocol, @register_profile,
    @raw_frame_hex, @snapshot, @raw_registers,
    @total_voltage_volts, @current_amps, @power_watts, @state_of_charge_percent,
    @min_cell_voltage_volts, @max_cell_voltage_volts, @delta_cell_voltage_volts,
    @mos_temperature_celsius, @battery_temperature_celsius,
    @charging_enabled, @discharging_enabled, @balancing_enabled, @battery_online,
    @cell_voltages);
";
            AddSnapshotParameters(command, device, sample);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await UpsertRollupAsync(connection, transaction, "jk_rollup_1m", sample, device.DeviceId, TimeSpan.FromMinutes(1), cancellationToken);
        await UpsertRollupAsync(connection, transaction, "jk_rollup_5m", sample, device.DeviceId, TimeSpan.FromMinutes(5), cancellationToken);
        await UpsertRollupAsync(connection, transaction, "jk_rollup_1h", sample, device.DeviceId, TimeSpan.FromHours(1), cancellationToken);

        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var (table, tsCol, voltCol, curCol, pwrCol, socCol, minCol, maxCol, deltaCol, mosTCol, batTCol) = resolution switch
        {
            "1s" => ("jk_raw_samples", "sampled_at",
                     "total_voltage_volts", "current_amps", "power_watts", "state_of_charge_percent",
                     "min_cell_voltage_volts", "max_cell_voltage_volts", "delta_cell_voltage_volts",
                     "mos_temperature_celsius", "battery_temperature_celsius"),
            "1m" => ("jk_rollup_1m", "bucket_start",
                     "avg_total_voltage_volts", "avg_current_amps", "avg_power_watts", "avg_state_of_charge_percent",
                     "min_cell_voltage_volts", "max_cell_voltage_volts", "avg_delta_cell_voltage_volts",
                     "avg_mos_temperature_celsius", "avg_battery_temperature_celsius"),
            "5m" => ("jk_rollup_5m", "bucket_start",
                     "avg_total_voltage_volts", "avg_current_amps", "avg_power_watts", "avg_state_of_charge_percent",
                     "min_cell_voltage_volts", "max_cell_voltage_volts", "avg_delta_cell_voltage_volts",
                     "avg_mos_temperature_celsius", "avg_battery_temperature_celsius"),
            "1h" => ("jk_rollup_1h", "bucket_start",
                     "avg_total_voltage_volts", "avg_current_amps", "avg_power_watts", "avg_state_of_charge_percent",
                     "min_cell_voltage_volts", "max_cell_voltage_volts", "avg_delta_cell_voltage_volts",
                     "avg_mos_temperature_celsius", "avg_battery_temperature_celsius"),
            _ => ("jk_rollup_5m", "bucket_start",
                  "avg_total_voltage_volts", "avg_current_amps", "avg_power_watts", "avg_state_of_charge_percent",
                  "min_cell_voltage_volts", "max_cell_voltage_volts", "avg_delta_cell_voltage_volts",
                  "avg_mos_temperature_celsius", "avg_battery_temperature_celsius"),
        };

        await using var connection = new NpgsqlConnection(GetConnectionStringByDeviceId(deviceId));
        await connection.OpenAsync(cancellationToken);

        // ROUND rollup averages to 10 dp so values fit in System.Decimal (max 28-29 digits).
        string R(string col) => resolution == "1s" ? col : $"ROUND({col},10)";

        await using var command = connection.CreateCommand();
        command.CommandText = $@"
SELECT {tsCol}, {R(voltCol)}, {R(curCol)}, {R(pwrCol)}, {R(socCol)}, {R(minCol)}, {R(maxCol)}, {R(deltaCol)}, {R(mosTCol)}, {R(batTCol)}
FROM {table}
WHERE device_id = @device_id AND {tsCol} >= @from AND {tsCol} <= @to
ORDER BY {tsCol}
LIMIT 2000;
";
        command.Parameters.AddWithValue("device_id", deviceId);
        command.Parameters.AddWithValue("from", from);
        command.Parameters.AddWithValue("to", to);

        var points = new List<HistoryDataPoint>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            points.Add(new HistoryDataPoint(
                reader.GetDateTime(0),
                reader.IsDBNull(1) ? null : reader.GetDecimal(1),
                reader.IsDBNull(2) ? null : reader.GetDecimal(2),
                reader.IsDBNull(3) ? null : reader.GetDecimal(3),
                reader.IsDBNull(4) ? null : reader.GetDecimal(4),
                reader.IsDBNull(5) ? null : reader.GetDecimal(5),
                reader.IsDBNull(6) ? null : reader.GetDecimal(6),
                reader.IsDBNull(7) ? null : reader.GetDecimal(7),
                reader.IsDBNull(8) ? null : reader.GetDecimal(8),
                reader.IsDBNull(9) ? null : reader.GetDecimal(9)));
        }

        return points;
    }

    /// <summary>Delete samples older than the configured retention windows.</summary>
    public async Task ApplyRetentionAsync(CancellationToken cancellationToken)
    {
        var connectionStrings = GetAllConnectionStrings();
        var now = DateTimeOffset.UtcNow;

        foreach (var connStr in connectionStrings)
        {
            try
            {
                await using var connection = new NpgsqlConnection(connStr);
                await connection.OpenAsync(cancellationToken);

                await DeleteOlderThanAsync(connection, "jk_raw_samples", "sampled_at", now.AddMinutes(-_retention.RawSecondsWindowMinutes), cancellationToken);
                await DeleteOlderThanAsync(connection, "jk_rollup_1m", "bucket_start", now.AddHours(-_retention.OneMinuteWindowHours), cancellationToken);
                await DeleteOlderThanAsync(connection, "jk_rollup_5m", "bucket_start", now.AddDays(-_retention.FiveMinuteWindowDays), cancellationToken);

                if (_retention.OneHourWindowDays > 0)
                {
                    await DeleteOlderThanAsync(connection, "jk_rollup_1h", "bucket_start", now.AddDays(-_retention.OneHourWindowDays), cancellationToken);
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Retention sweep failed for a device database.");
            }
        }

        logger.LogDebug("Retention sweep completed.");
    }

    private static async Task UpsertRollupAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string tableName,
        DevicePollResult sample,
        string deviceId,
        TimeSpan bucketSize,
        CancellationToken cancellationToken)
    {
        var bucketStart = AlignBucket(sample.Snapshot.CollectedAt, bucketSize);

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $@"
INSERT INTO {tableName} (
    bucket_start, device_id, sample_count,
    avg_total_voltage_volts, avg_current_amps, avg_power_watts, avg_state_of_charge_percent,
    min_cell_voltage_volts, max_cell_voltage_volts, avg_delta_cell_voltage_volts,
    avg_mos_temperature_celsius, avg_battery_temperature_celsius,
    avg_cell_voltages,
    last_sampled_at)
VALUES (
    @bucket_start, @device_id, 1,
    @avg_total_voltage_volts, @avg_current_amps, @avg_power_watts, @avg_state_of_charge_percent,
    @min_cell_voltage_volts, @max_cell_voltage_volts, @avg_delta_cell_voltage_volts,
    @avg_mos_temperature_celsius, @avg_battery_temperature_celsius,
    @avg_cell_voltages,
    @last_sampled_at)
ON CONFLICT (bucket_start, device_id)
DO UPDATE SET
    sample_count = {tableName}.sample_count + 1,
    avg_total_voltage_volts = CASE WHEN EXCLUDED.avg_total_voltage_volts IS NULL THEN {tableName}.avg_total_voltage_volts WHEN {tableName}.avg_total_voltage_volts IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_total_voltage_volts ELSE (({tableName}.avg_total_voltage_volts * {tableName}.sample_count) + EXCLUDED.avg_total_voltage_volts) / ({tableName}.sample_count + 1) END,
    avg_current_amps = CASE WHEN EXCLUDED.avg_current_amps IS NULL THEN {tableName}.avg_current_amps WHEN {tableName}.avg_current_amps IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_current_amps ELSE (({tableName}.avg_current_amps * {tableName}.sample_count) + EXCLUDED.avg_current_amps) / ({tableName}.sample_count + 1) END,
    avg_power_watts = CASE WHEN EXCLUDED.avg_power_watts IS NULL THEN {tableName}.avg_power_watts WHEN {tableName}.avg_power_watts IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_power_watts ELSE (({tableName}.avg_power_watts * {tableName}.sample_count) + EXCLUDED.avg_power_watts) / ({tableName}.sample_count + 1) END,
    avg_state_of_charge_percent = CASE WHEN EXCLUDED.avg_state_of_charge_percent IS NULL THEN {tableName}.avg_state_of_charge_percent WHEN {tableName}.avg_state_of_charge_percent IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_state_of_charge_percent ELSE (({tableName}.avg_state_of_charge_percent * {tableName}.sample_count) + EXCLUDED.avg_state_of_charge_percent) / ({tableName}.sample_count + 1) END,
    min_cell_voltage_volts = CASE WHEN EXCLUDED.min_cell_voltage_volts IS NULL THEN {tableName}.min_cell_voltage_volts WHEN {tableName}.min_cell_voltage_volts IS NULL THEN EXCLUDED.min_cell_voltage_volts ELSE LEAST({tableName}.min_cell_voltage_volts, EXCLUDED.min_cell_voltage_volts) END,
    max_cell_voltage_volts = CASE WHEN EXCLUDED.max_cell_voltage_volts IS NULL THEN {tableName}.max_cell_voltage_volts WHEN {tableName}.max_cell_voltage_volts IS NULL THEN EXCLUDED.max_cell_voltage_volts ELSE GREATEST({tableName}.max_cell_voltage_volts, EXCLUDED.max_cell_voltage_volts) END,
    avg_delta_cell_voltage_volts = CASE WHEN EXCLUDED.avg_delta_cell_voltage_volts IS NULL THEN {tableName}.avg_delta_cell_voltage_volts WHEN {tableName}.avg_delta_cell_voltage_volts IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_delta_cell_voltage_volts ELSE (({tableName}.avg_delta_cell_voltage_volts * {tableName}.sample_count) + EXCLUDED.avg_delta_cell_voltage_volts) / ({tableName}.sample_count + 1) END,
    avg_mos_temperature_celsius = CASE WHEN EXCLUDED.avg_mos_temperature_celsius IS NULL THEN {tableName}.avg_mos_temperature_celsius WHEN {tableName}.avg_mos_temperature_celsius IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_mos_temperature_celsius ELSE (({tableName}.avg_mos_temperature_celsius * {tableName}.sample_count) + EXCLUDED.avg_mos_temperature_celsius) / ({tableName}.sample_count + 1) END,
    avg_battery_temperature_celsius = CASE WHEN EXCLUDED.avg_battery_temperature_celsius IS NULL THEN {tableName}.avg_battery_temperature_celsius WHEN {tableName}.avg_battery_temperature_celsius IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_battery_temperature_celsius ELSE (({tableName}.avg_battery_temperature_celsius * {tableName}.sample_count) + EXCLUDED.avg_battery_temperature_celsius) / ({tableName}.sample_count + 1) END,
    avg_cell_voltages = CASE WHEN EXCLUDED.avg_cell_voltages IS NULL THEN {tableName}.avg_cell_voltages WHEN {tableName}.avg_cell_voltages IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_cell_voltages ELSE (SELECT jsonb_object_agg(k, (COALESCE(({tableName}.avg_cell_voltages->>k)::numeric * {tableName}.sample_count, 0) + v::numeric) / ({tableName}.sample_count + 1)) FROM jsonb_each_text(EXCLUDED.avg_cell_voltages) AS j(k, v)) END,
    last_sampled_at = GREATEST({tableName}.last_sampled_at, EXCLUDED.last_sampled_at);
";

        command.Parameters.AddWithValue("bucket_start", bucketStart);
        command.Parameters.AddWithValue("device_id", deviceId);
        command.Parameters.AddWithValue("avg_total_voltage_volts", (object?)sample.Snapshot.TotalVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("avg_current_amps", (object?)sample.Snapshot.CurrentAmps ?? DBNull.Value);
        command.Parameters.AddWithValue("avg_power_watts", (object?)sample.Snapshot.PowerWatts ?? DBNull.Value);
        command.Parameters.AddWithValue("avg_state_of_charge_percent", (object?)sample.Snapshot.StateOfChargePercent ?? DBNull.Value);
        command.Parameters.AddWithValue("min_cell_voltage_volts", (object?)sample.Snapshot.MinCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("max_cell_voltage_volts", (object?)sample.Snapshot.MaxCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("avg_delta_cell_voltage_volts", (object?)sample.Snapshot.DeltaCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("avg_mos_temperature_celsius", (object?)sample.Snapshot.MosTemperatureCelsius ?? DBNull.Value);
        command.Parameters.AddWithValue("avg_battery_temperature_celsius", (object?)sample.Snapshot.BatteryTemperatureCelsius ?? DBNull.Value);
        command.Parameters.Add(new NpgsqlParameter("avg_cell_voltages", NpgsqlDbType.Jsonb) { Value = BuildCellVoltagesJson(sample.Snapshot.Cells) });
        command.Parameters.AddWithValue("last_sampled_at", sample.Snapshot.CollectedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void AddSnapshotParameters(NpgsqlCommand command, DeviceConfiguration device, DevicePollResult sample)
    {
        command.Parameters.AddWithValue("sampled_at", sample.Snapshot.CollectedAt);
        command.Parameters.AddWithValue("device_id", device.DeviceId);
        command.Parameters.AddWithValue("display_name", device.DisplayName);
        command.Parameters.AddWithValue("protocol", device.DefinitionId);
        command.Parameters.AddWithValue("register_profile", device.DefinitionId);
        command.Parameters.AddWithValue("raw_frame_hex", sample.RawFrameHex);
        command.Parameters.Add(new NpgsqlParameter("snapshot", NpgsqlDbType.Jsonb) { Value = JsonSerializer.Serialize(sample.Snapshot) });
        command.Parameters.Add(new NpgsqlParameter("raw_registers", NpgsqlDbType.Jsonb) { Value = JsonSerializer.Serialize(sample.RawRegisters) });
        command.Parameters.AddWithValue("total_voltage_volts", (object?)sample.Snapshot.TotalVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("current_amps", (object?)sample.Snapshot.CurrentAmps ?? DBNull.Value);
        command.Parameters.AddWithValue("power_watts", (object?)sample.Snapshot.PowerWatts ?? DBNull.Value);
        command.Parameters.AddWithValue("state_of_charge_percent", (object?)sample.Snapshot.StateOfChargePercent ?? DBNull.Value);
        command.Parameters.AddWithValue("min_cell_voltage_volts", (object?)sample.Snapshot.MinCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("max_cell_voltage_volts", (object?)sample.Snapshot.MaxCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("delta_cell_voltage_volts", (object?)sample.Snapshot.DeltaCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("mos_temperature_celsius", (object?)sample.Snapshot.MosTemperatureCelsius ?? DBNull.Value);
        command.Parameters.AddWithValue("battery_temperature_celsius", (object?)sample.Snapshot.BatteryTemperatureCelsius ?? DBNull.Value);
        command.Parameters.AddWithValue("charging_enabled", (object?)sample.Snapshot.ChargingEnabled ?? DBNull.Value);
        command.Parameters.AddWithValue("discharging_enabled", (object?)sample.Snapshot.DischargingEnabled ?? DBNull.Value);
        command.Parameters.AddWithValue("balancing_enabled", (object?)sample.Snapshot.BalancingEnabled ?? DBNull.Value);
        command.Parameters.AddWithValue("battery_online", (object?)sample.Snapshot.BatteryOnline ?? DBNull.Value);
        command.Parameters.Add(new NpgsqlParameter("cell_voltages", NpgsqlDbType.Jsonb) { Value = BuildCellVoltagesJson(sample.Snapshot.Cells) });
    }

    private static DateTimeOffset AlignBucket(DateTimeOffset value, TimeSpan bucketSize)
    {
        var ticks = value.UtcTicks - (value.UtcTicks % bucketSize.Ticks);
        return new DateTimeOffset(ticks, TimeSpan.Zero);
    }

    private async Task DeleteOlderThanAsync(NpgsqlConnection connection, string table, string column, DateTimeOffset cutoff, CancellationToken ct)
    {
        var totalDeleted = 0;
        var batches = 0;

        while (true)
        {
            ct.ThrowIfCancellationRequested();

            await using var cmd = connection.CreateCommand();
            cmd.CommandTimeout = RetentionDeleteCommandTimeoutSeconds;
            cmd.CommandText = $@"
WITH batch AS (
    SELECT tableoid, ctid
    FROM {table}
    WHERE {column} < @cutoff
    ORDER BY {column}
    LIMIT @batch_size
)
DELETE FROM {table} AS target
USING batch
WHERE target.tableoid = batch.tableoid
  AND target.ctid = batch.ctid;
";
            cmd.Parameters.AddWithValue("cutoff", cutoff);
            cmd.Parameters.AddWithValue("batch_size", NpgsqlDbType.Integer, RetentionDeleteBatchSize);

            var deleted = await cmd.ExecuteNonQueryAsync(ct);
            if (deleted == 0)
            {
                break;
            }

            totalDeleted += deleted;
            batches++;

            if (deleted < RetentionDeleteBatchSize)
            {
                break;
            }
        }

        if (totalDeleted > 0)
        {
            logger.LogInformation(
                "Retention deleted {DeletedRows} rows from {Table} older than {Cutoff} in {BatchCount} batches.",
                totalDeleted,
                table,
                cutoff,
                batches);
        }
    }

    private static async Task ExecuteNonQueryAsync(NpgsqlConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var cellKey = cellIndex.ToString();

        var (table, tsCol, voltExpr) = resolution switch
        {
            "1s" => ("jk_raw_samples", "sampled_at", $"(cell_voltages->>'{cellKey}')::numeric"),
            "1m" => ("jk_rollup_1m", "bucket_start", $"ROUND((avg_cell_voltages->>'{cellKey}')::numeric, 10)"),
            "5m" => ("jk_rollup_5m", "bucket_start", $"ROUND((avg_cell_voltages->>'{cellKey}')::numeric, 10)"),
            "1h" => ("jk_rollup_1h", "bucket_start", $"ROUND((avg_cell_voltages->>'{cellKey}')::numeric, 10)"),
            _ => ("jk_rollup_5m", "bucket_start", $"ROUND((avg_cell_voltages->>'{cellKey}')::numeric, 10)"),
        };

        await using var connection = new NpgsqlConnection(GetConnectionStringByDeviceId(deviceId));
        await connection.OpenAsync(cancellationToken);

        await using var command = connection.CreateCommand();
        command.CommandText = $@"
SELECT {tsCol}, {voltExpr}
FROM {table}
WHERE device_id = @device_id AND {tsCol} >= @from AND {tsCol} <= @to
ORDER BY {tsCol}
LIMIT 2000;
";
        command.Parameters.AddWithValue("device_id", deviceId);
        command.Parameters.AddWithValue("from", from);
        command.Parameters.AddWithValue("to", to);

        var points = new List<CellHistoryDataPoint>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            points.Add(new CellHistoryDataPoint(
                reader.GetDateTime(0),
                reader.IsDBNull(1) ? null : reader.GetDecimal(1)));
        }

        return points;
    }

    public async Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        // Total database size.
        long totalBytes = 0;
        await using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = "SELECT pg_database_size(current_database());";
            var result = await cmd.ExecuteScalarAsync(cancellationToken);
            totalBytes = result is long l ? l : 0;
        }

        // Per-table sizes.
        var tables = new List<TableSizeInfo>();
        var tableNames = new[] { "jk_raw_samples", "jk_rollup_1m", "jk_rollup_5m", "jk_rollup_1h" };

        foreach (var tableName in tableNames)
        {
            long tableBytes = 0;
            long rowCount = 0;

            await using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT pg_total_relation_size('{tableName}');";
                var result = await cmd.ExecuteScalarAsync(cancellationToken);
                tableBytes = result is long l ? l : 0;
            }

            await using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText = $"SELECT COUNT(*) FROM {tableName};";
                var result = await cmd.ExecuteScalarAsync(cancellationToken);
                rowCount = result is long l ? l : 0;
            }

            tables.Add(new TableSizeInfo(tableName, tableBytes, FormatBytes(tableBytes), rowCount));
        }

        return new DatabaseSizeInfo(totalBytes, FormatBytes(totalBytes), tables);
    }

    public async Task ExportAsync(Stream destination, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        var tableNames = new[] { "jk_raw_samples", "jk_rollup_1m", "jk_rollup_5m", "jk_rollup_1h" };

        var writer = new StreamWriter(destination, leaveOpen: true);
        await writer.WriteLineAsync("-- JkMonitor Database Export");
        await writer.WriteLineAsync($"-- Exported at: {DateTimeOffset.UtcNow:O}");
        await writer.WriteLineAsync();

        foreach (var tableName in tableNames)
        {
            await writer.WriteLineAsync($"-- TABLE: {tableName}");

            using var exportReader = await connection.BeginTextExportAsync(
                $"COPY {tableName} TO STDOUT (FORMAT CSV, HEADER)", cancellationToken);

            string? line;
            while ((line = await exportReader.ReadLineAsync(cancellationToken)) != null)
            {
                await writer.WriteLineAsync(line);
            }

            await writer.WriteLineAsync($"-- END: {tableName}");
            await writer.WriteLineAsync();
        }

        await writer.FlushAsync(cancellationToken);
    }

    public async Task ImportAsync(Stream source, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        var reader = new StreamReader(source);
        string? currentTable = null;
        bool headerSkipped = false;

        string? line;
        while ((line = await reader.ReadLineAsync(cancellationToken)) != null)
        {
            if (line.StartsWith("-- TABLE: "))
            {
                currentTable = line["-- TABLE: ".Length..].Trim();
                headerSkipped = false;

                // Validate table name against known tables.
                var allowedTables = new HashSet<string> { "jk_raw_samples", "jk_rollup_1m", "jk_rollup_5m", "jk_rollup_1h" };
                if (!allowedTables.Contains(currentTable))
                {
                    throw new InvalidOperationException($"Unknown table in import file: {currentTable}");
                }

                // Truncate the table before import.
                await using var truncateCmd = connection.CreateCommand();
                truncateCmd.CommandText = $"TRUNCATE {currentTable};";
                await truncateCmd.ExecuteNonQueryAsync(cancellationToken);

                continue;
            }

            if (line.StartsWith("TRUNCATE ") || line.StartsWith("-- ") || string.IsNullOrWhiteSpace(line))
            {
                if (line.StartsWith("-- END: "))
                {
                    currentTable = null;
                }

                continue;
            }

            if (currentTable != null)
            {
                if (!headerSkipped)
                {
                    // First data line after TABLE marker is the CSV header — start the COPY import.
                    headerSkipped = true;
                    var columns = line;

                    // Collect all CSV data lines for this table.
                    var csvLines = new List<string>();
                    while ((line = await reader.ReadLineAsync(cancellationToken)) != null)
                    {
                        if (line.StartsWith("-- END: "))
                        {
                            currentTable = null;
                            break;
                        }

                        if (line.StartsWith("-- ") || string.IsNullOrWhiteSpace(line))
                            continue;

                        csvLines.Add(line);
                    }

                    if (csvLines.Count > 0)
                    {
                        // Use COPY FROM STDIN with header.
                        await using var writer = await connection.BeginTextImportAsync(
                            $"COPY {currentTable} FROM STDIN (FORMAT CSV, HEADER)", cancellationToken);
                        await writer.WriteLineAsync(columns);
                        foreach (var dataLine in csvLines)
                        {
                            await writer.WriteLineAsync(dataLine);
                        }
                    }
                }
            }
        }

        logger.LogInformation("Database import completed successfully.");
    }

    private static object BuildCellVoltagesJson(IReadOnlyList<Contracts.Status.CellVoltageSnapshot> cells)
    {
        if (cells.Count == 0) return DBNull.Value;
        var dict = new Dictionary<string, decimal>(cells.Count);
        foreach (var cell in cells)
            dict[cell.Index.ToString()] = cell.VoltageVolts;
        return JsonSerializer.Serialize(dict);
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var index = 0;
        var value = (double)bytes;
        while (value >= 1024 && index < units.Length - 1)
        {
            value /= 1024;
            index++;
        }

        return $"{value:F1} {units[index]}";
    }
}