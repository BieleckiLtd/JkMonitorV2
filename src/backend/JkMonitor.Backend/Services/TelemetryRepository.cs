using System.Text.Json;
using JkMonitor.Backend.Protocol;
using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace JkMonitor.Backend.Services;

public interface ITelemetryRepository
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task PersistAsync(BmsDeviceConfiguration device, JkParsedSample sample, CancellationToken cancellationToken);
}

public sealed class NoOpTelemetryRepository : ITelemetryRepository
{
    public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task PersistAsync(BmsDeviceConfiguration device, JkParsedSample sample, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class TimescaleTelemetryRepository(
    IOptions<MonitorConfiguration> configuration,
    ILogger<TimescaleTelemetryRepository> logger) : ITelemetryRepository
{
    private readonly StorageConfiguration _storage = configuration.Value.Storage;
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
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
    charging_enabled boolean NULL,
    discharging_enabled boolean NULL,
    balancing_enabled boolean NULL,
    battery_online boolean NULL
);

SELECT create_hypertable('jk_raw_samples', by_range('sampled_at'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS ix_jk_raw_samples_device_sampled_at
    ON jk_raw_samples (device_id, sampled_at DESC);

CREATE TABLE IF NOT EXISTS jk_rollup_1m (
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
    last_sampled_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_start, device_id)
);

SELECT create_hypertable('jk_rollup_1m', by_range('bucket_start'), if_not_exists => TRUE);

CREATE TABLE IF NOT EXISTS jk_rollup_5m (
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
    last_sampled_at timestamptz NOT NULL,
    PRIMARY KEY (bucket_start, device_id)
);

SELECT create_hypertable('jk_rollup_5m', by_range('bucket_start'), if_not_exists => TRUE);
", cancellationToken);

            _initialized = true;
            logger.LogInformation("TimescaleDB schema is ready.");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task PersistAsync(BmsDeviceConfiguration device, JkParsedSample sample, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = @"
INSERT INTO jk_raw_samples (
    sampled_at,
    device_id,
    display_name,
    protocol,
    register_profile,
    raw_frame_hex,
    snapshot,
    raw_registers,
    total_voltage_volts,
    current_amps,
    power_watts,
    state_of_charge_percent,
    min_cell_voltage_volts,
    max_cell_voltage_volts,
    delta_cell_voltage_volts,
    charging_enabled,
    discharging_enabled,
    balancing_enabled,
    battery_online)
VALUES (
    @sampled_at,
    @device_id,
    @display_name,
    @protocol,
    @register_profile,
    @raw_frame_hex,
    @snapshot,
    @raw_registers,
    @total_voltage_volts,
    @current_amps,
    @power_watts,
    @state_of_charge_percent,
    @min_cell_voltage_volts,
    @max_cell_voltage_volts,
    @delta_cell_voltage_volts,
    @charging_enabled,
    @discharging_enabled,
    @balancing_enabled,
    @battery_online);
";

            AddSnapshotParameters(command, device, sample);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }

        await UpsertRollupAsync(connection, transaction, "jk_rollup_1m", sample, device.DeviceId, TimeSpan.FromMinutes(1), cancellationToken);
        await UpsertRollupAsync(connection, transaction, "jk_rollup_5m", sample, device.DeviceId, TimeSpan.FromMinutes(5), cancellationToken);

        await transaction.CommitAsync(cancellationToken);
    }

    private static async Task UpsertRollupAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string tableName,
        JkParsedSample sample,
        string deviceId,
        TimeSpan bucketSize,
        CancellationToken cancellationToken)
    {
        var bucketStart = AlignBucket(sample.Snapshot.CollectedAt, bucketSize);

        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $@"
INSERT INTO {tableName} (
    bucket_start,
    device_id,
    sample_count,
    avg_total_voltage_volts,
    avg_current_amps,
    avg_power_watts,
    avg_state_of_charge_percent,
    min_cell_voltage_volts,
    max_cell_voltage_volts,
    avg_delta_cell_voltage_volts,
    last_sampled_at)
VALUES (
    @bucket_start,
    @device_id,
    1,
    @avg_total_voltage_volts,
    @avg_current_amps,
    @avg_power_watts,
    @avg_state_of_charge_percent,
    @min_cell_voltage_volts,
    @max_cell_voltage_volts,
    @avg_delta_cell_voltage_volts,
    @last_sampled_at)
ON CONFLICT (bucket_start, device_id)
DO UPDATE SET
    sample_count = {tableName}.sample_count + 1,
    avg_total_voltage_volts = CASE
        WHEN EXCLUDED.avg_total_voltage_volts IS NULL THEN {tableName}.avg_total_voltage_volts
        WHEN {tableName}.avg_total_voltage_volts IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_total_voltage_volts
        ELSE (({tableName}.avg_total_voltage_volts * {tableName}.sample_count) + EXCLUDED.avg_total_voltage_volts) / ({tableName}.sample_count + 1)
    END,
    avg_current_amps = CASE
        WHEN EXCLUDED.avg_current_amps IS NULL THEN {tableName}.avg_current_amps
        WHEN {tableName}.avg_current_amps IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_current_amps
        ELSE (({tableName}.avg_current_amps * {tableName}.sample_count) + EXCLUDED.avg_current_amps) / ({tableName}.sample_count + 1)
    END,
    avg_power_watts = CASE
        WHEN EXCLUDED.avg_power_watts IS NULL THEN {tableName}.avg_power_watts
        WHEN {tableName}.avg_power_watts IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_power_watts
        ELSE (({tableName}.avg_power_watts * {tableName}.sample_count) + EXCLUDED.avg_power_watts) / ({tableName}.sample_count + 1)
    END,
    avg_state_of_charge_percent = CASE
        WHEN EXCLUDED.avg_state_of_charge_percent IS NULL THEN {tableName}.avg_state_of_charge_percent
        WHEN {tableName}.avg_state_of_charge_percent IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_state_of_charge_percent
        ELSE (({tableName}.avg_state_of_charge_percent * {tableName}.sample_count) + EXCLUDED.avg_state_of_charge_percent) / ({tableName}.sample_count + 1)
    END,
    min_cell_voltage_volts = CASE
        WHEN EXCLUDED.min_cell_voltage_volts IS NULL THEN {tableName}.min_cell_voltage_volts
        WHEN {tableName}.min_cell_voltage_volts IS NULL THEN EXCLUDED.min_cell_voltage_volts
        ELSE LEAST({tableName}.min_cell_voltage_volts, EXCLUDED.min_cell_voltage_volts)
    END,
    max_cell_voltage_volts = CASE
        WHEN EXCLUDED.max_cell_voltage_volts IS NULL THEN {tableName}.max_cell_voltage_volts
        WHEN {tableName}.max_cell_voltage_volts IS NULL THEN EXCLUDED.max_cell_voltage_volts
        ELSE GREATEST({tableName}.max_cell_voltage_volts, EXCLUDED.max_cell_voltage_volts)
    END,
    avg_delta_cell_voltage_volts = CASE
        WHEN EXCLUDED.avg_delta_cell_voltage_volts IS NULL THEN {tableName}.avg_delta_cell_voltage_volts
        WHEN {tableName}.avg_delta_cell_voltage_volts IS NULL OR {tableName}.sample_count = 0 THEN EXCLUDED.avg_delta_cell_voltage_volts
        ELSE (({tableName}.avg_delta_cell_voltage_volts * {tableName}.sample_count) + EXCLUDED.avg_delta_cell_voltage_volts) / ({tableName}.sample_count + 1)
    END,
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
        command.Parameters.AddWithValue("last_sampled_at", sample.Snapshot.CollectedAt);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void AddSnapshotParameters(NpgsqlCommand command, BmsDeviceConfiguration device, JkParsedSample sample)
    {
        command.Parameters.AddWithValue("sampled_at", sample.Snapshot.CollectedAt);
        command.Parameters.AddWithValue("device_id", device.DeviceId);
        command.Parameters.AddWithValue("display_name", device.DisplayName);
        command.Parameters.AddWithValue("protocol", device.Protocol);
        command.Parameters.AddWithValue("register_profile", device.RegisterProfile);
        command.Parameters.AddWithValue("raw_frame_hex", sample.RawFrameHex);
        command.Parameters.AddWithValue("snapshot", JsonSerializer.Serialize(sample.Snapshot));
        command.Parameters.AddWithValue("raw_registers", JsonSerializer.Serialize(sample.RawRegisters));
        command.Parameters.AddWithValue("total_voltage_volts", (object?)sample.Snapshot.TotalVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("current_amps", (object?)sample.Snapshot.CurrentAmps ?? DBNull.Value);
        command.Parameters.AddWithValue("power_watts", (object?)sample.Snapshot.PowerWatts ?? DBNull.Value);
        command.Parameters.AddWithValue("state_of_charge_percent", (object?)sample.Snapshot.StateOfChargePercent ?? DBNull.Value);
        command.Parameters.AddWithValue("min_cell_voltage_volts", (object?)sample.Snapshot.MinCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("max_cell_voltage_volts", (object?)sample.Snapshot.MaxCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("delta_cell_voltage_volts", (object?)sample.Snapshot.DeltaCellVoltageVolts ?? DBNull.Value);
        command.Parameters.AddWithValue("charging_enabled", (object?)sample.Snapshot.ChargingEnabled ?? DBNull.Value);
        command.Parameters.AddWithValue("discharging_enabled", (object?)sample.Snapshot.DischargingEnabled ?? DBNull.Value);
        command.Parameters.AddWithValue("balancing_enabled", (object?)sample.Snapshot.BalancingEnabled ?? DBNull.Value);
        command.Parameters.AddWithValue("battery_online", (object?)sample.Snapshot.BatteryOnline ?? DBNull.Value);
    }

    private static DateTimeOffset AlignBucket(DateTimeOffset value, TimeSpan bucketSize)
    {
        var ticks = value.UtcTicks - (value.UtcTicks % bucketSize.Ticks);
        return new DateTimeOffset(ticks, TimeSpan.Zero);
    }

    private static async Task ExecuteNonQueryAsync(NpgsqlConnection connection, string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}