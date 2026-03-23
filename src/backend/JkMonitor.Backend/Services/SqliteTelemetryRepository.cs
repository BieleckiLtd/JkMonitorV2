using System.Globalization;
using JkMonitor.Contracts.Configuration;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public sealed class SqliteTelemetryRepository(
    IOptions<MonitorConfiguration> configuration,
    ILogger<SqliteTelemetryRepository> logger) : ITelemetryRepository, IDisposable
{
    private readonly StorageConfiguration _storage = configuration.Value.Storage;
    private readonly RetentionConfiguration _retention = configuration.Value.Storage.Retention;
    private readonly SemaphoreSlim _initLock = new(1, 1);
    private volatile bool _initialized;
    private SqliteConnection? _connection;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized) return;

        await _initLock.WaitAsync(cancellationToken);
        try
        {
            if (_initialized) return;

            _connection = new SqliteConnection(_storage.ConnectionString);
            await _connection.OpenAsync(cancellationToken);

            // Enable WAL mode for concurrent read/write performance.
            await ExecuteAsync(_connection, "PRAGMA journal_mode=WAL;", cancellationToken);
            await ExecuteAsync(_connection, "PRAGMA synchronous=NORMAL;", cancellationToken);

            await ExecuteAsync(_connection, @"
CREATE TABLE IF NOT EXISTS ts_raw (
    sampled_at TEXT NOT NULL,
    device_id TEXT NOT NULL,
    total_voltage_v REAL,
    current_a REAL,
    power_w REAL,
    soc_pct REAL,
    min_cell_v REAL,
    max_cell_v REAL,
    delta_cell_v REAL,
    mos_temp_c REAL,
    battery_temp_c REAL
);", cancellationToken);

            await ExecuteAsync(_connection, @"
CREATE INDEX IF NOT EXISTS ix_ts_raw_device_time ON ts_raw(device_id, sampled_at);", cancellationToken);

            foreach (var table in new[] { "ts_1m", "ts_5m", "ts_1h" })
            {
                await ExecuteAsync(_connection, $@"
CREATE TABLE IF NOT EXISTS {table} (
    bucket TEXT NOT NULL,
    device_id TEXT NOT NULL,
    sample_count INTEGER NOT NULL DEFAULT 0,
    avg_voltage REAL,
    avg_current REAL,
    avg_power REAL,
    avg_soc REAL,
    min_cell_v REAL,
    max_cell_v REAL,
    avg_delta_v REAL,
    avg_mos_temp REAL,
    avg_battery_temp REAL,
    PRIMARY KEY (bucket, device_id)
);", cancellationToken);
            }

            _initialized = true;
            logger.LogInformation("SQLite time-series storage is ready ({ConnectionString}).", _storage.ConnectionString);
        }
        finally
        {
            _initLock.Release();
        }
    }

    public async Task PersistAsync(DeviceConfiguration device, Models.DevicePollResult sample, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);
        var conn = _connection!;
        var s = sample.Snapshot;
        var ts = s.CollectedAt.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        // Insert raw sample.
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
INSERT INTO ts_raw (sampled_at, device_id, total_voltage_v, current_a, power_w, soc_pct, min_cell_v, max_cell_v, delta_cell_v, mos_temp_c, battery_temp_c)
VALUES ($ts, $did, $v, $a, $w, $soc, $minv, $maxv, $dv, $mt, $bt);";
            AddSnapshotParams(cmd, ts, device.DeviceId, s);
            await cmd.ExecuteNonQueryAsync(cancellationToken);
        }

        // Upsert rollups.
        await UpsertRollupAsync(conn, "ts_1m", device.DeviceId, s, TimeSpan.FromMinutes(1), cancellationToken);
        await UpsertRollupAsync(conn, "ts_5m", device.DeviceId, s, TimeSpan.FromMinutes(5), cancellationToken);
        await UpsertRollupAsync(conn, "ts_1h", device.DeviceId, s, TimeSpan.FromHours(1), cancellationToken);
    }

    public async Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(
        string deviceId, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);
        var conn = _connection!;

        var (table, tsCol, voltCol, curCol, pwrCol, socCol, minCol, maxCol, deltaCol, mosTCol, batTCol) = resolution switch
        {
            "1s" => ("ts_raw", "sampled_at", "total_voltage_v", "current_a", "power_w", "soc_pct", "min_cell_v", "max_cell_v", "delta_cell_v", "mos_temp_c", "battery_temp_c"),
            "1m" => ("ts_1m", "bucket", "avg_voltage", "avg_current", "avg_power", "avg_soc", "min_cell_v", "max_cell_v", "avg_delta_v", "avg_mos_temp", "avg_battery_temp"),
            "5m" => ("ts_5m", "bucket", "avg_voltage", "avg_current", "avg_power", "avg_soc", "min_cell_v", "max_cell_v", "avg_delta_v", "avg_mos_temp", "avg_battery_temp"),
            "1h" => ("ts_1h", "bucket", "avg_voltage", "avg_current", "avg_power", "avg_soc", "min_cell_v", "max_cell_v", "avg_delta_v", "avg_mos_temp", "avg_battery_temp"),
            _ => ("ts_5m", "bucket", "avg_voltage", "avg_current", "avg_power", "avg_soc", "min_cell_v", "max_cell_v", "avg_delta_v", "avg_mos_temp", "avg_battery_temp"),
        };

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $@"
SELECT {tsCol}, {voltCol}, {curCol}, {pwrCol}, {socCol}, {minCol}, {maxCol}, {deltaCol}, {mosTCol}, {batTCol}
FROM {table}
WHERE device_id = $did AND {tsCol} >= $from AND {tsCol} <= $to
ORDER BY {tsCol}
LIMIT 2000;";
        cmd.Parameters.AddWithValue("$did", deviceId);
        cmd.Parameters.AddWithValue("$from", from.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));
        cmd.Parameters.AddWithValue("$to", to.UtcDateTime.ToString("o", CultureInfo.InvariantCulture));

        var points = new List<HistoryDataPoint>();
        await using var reader = await cmd.ExecuteReaderAsync(cancellationToken);

        while (await reader.ReadAsync(cancellationToken))
        {
            points.Add(new HistoryDataPoint(
                DateTimeOffset.Parse(reader.GetString(0), CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind),
                ReadNullableDecimal(reader, 1),
                ReadNullableDecimal(reader, 2),
                ReadNullableDecimal(reader, 3),
                ReadNullableDecimal(reader, 4),
                ReadNullableDecimal(reader, 5),
                ReadNullableDecimal(reader, 6),
                ReadNullableDecimal(reader, 7),
                ReadNullableDecimal(reader, 8),
                ReadNullableDecimal(reader, 9)));
        }

        return points;
    }

    public Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(
        string deviceId, int cellIndex, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<CellHistoryDataPoint>>([]);

    /// <summary>Delete samples older than the configured retention windows.</summary>
    public async Task ApplyRetentionAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);
        var conn = _connection!;
        var now = DateTimeOffset.UtcNow;

        var rawCutoff = now.AddMinutes(-_retention.RawSecondsWindowMinutes).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var m1Cutoff = now.AddHours(-_retention.OneMinuteWindowHours).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var m5Cutoff = now.AddDays(-_retention.FiveMinuteWindowDays).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);
        var h1Cutoff = now.AddDays(-_retention.OneHourWindowDays).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        await DeleteOlderThan(conn, "ts_raw", "sampled_at", rawCutoff, cancellationToken);
        await DeleteOlderThan(conn, "ts_1m", "bucket", m1Cutoff, cancellationToken);
        await DeleteOlderThan(conn, "ts_5m", "bucket", m5Cutoff, cancellationToken);
        await DeleteOlderThan(conn, "ts_1h", "bucket", h1Cutoff, cancellationToken);

        logger.LogDebug("Retention sweep completed.");
    }

    public void Dispose()
    {
        _connection?.Dispose();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private static async Task UpsertRollupAsync(
        SqliteConnection conn, string table, string deviceId,
        Contracts.Status.DeviceTelemetrySnapshot s, TimeSpan bucketSize,
        CancellationToken cancellationToken)
    {
        var bucket = AlignBucket(s.CollectedAt, bucketSize).UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $@"
INSERT INTO {table} (bucket, device_id, sample_count, avg_voltage, avg_current, avg_power, avg_soc, min_cell_v, max_cell_v, avg_delta_v, avg_mos_temp, avg_battery_temp)
VALUES ($bucket, $did, 1, $v, $a, $w, $soc, $minv, $maxv, $dv, $mt, $bt)
ON CONFLICT (bucket, device_id) DO UPDATE SET
    sample_count = sample_count + 1,
    avg_voltage   = CASE WHEN excluded.avg_voltage   IS NULL THEN avg_voltage   WHEN avg_voltage   IS NULL OR sample_count = 0 THEN excluded.avg_voltage   ELSE (avg_voltage   * sample_count + excluded.avg_voltage)   / (sample_count + 1) END,
    avg_current   = CASE WHEN excluded.avg_current   IS NULL THEN avg_current   WHEN avg_current   IS NULL OR sample_count = 0 THEN excluded.avg_current   ELSE (avg_current   * sample_count + excluded.avg_current)   / (sample_count + 1) END,
    avg_power     = CASE WHEN excluded.avg_power     IS NULL THEN avg_power     WHEN avg_power     IS NULL OR sample_count = 0 THEN excluded.avg_power     ELSE (avg_power     * sample_count + excluded.avg_power)     / (sample_count + 1) END,
    avg_soc       = CASE WHEN excluded.avg_soc       IS NULL THEN avg_soc       WHEN avg_soc       IS NULL OR sample_count = 0 THEN excluded.avg_soc       ELSE (avg_soc       * sample_count + excluded.avg_soc)       / (sample_count + 1) END,
    min_cell_v    = CASE WHEN excluded.min_cell_v    IS NULL THEN min_cell_v    WHEN min_cell_v    IS NULL THEN excluded.min_cell_v    ELSE MIN(min_cell_v, excluded.min_cell_v)    END,
    max_cell_v    = CASE WHEN excluded.max_cell_v    IS NULL THEN max_cell_v    WHEN max_cell_v    IS NULL THEN excluded.max_cell_v    ELSE MAX(max_cell_v, excluded.max_cell_v)    END,
    avg_delta_v   = CASE WHEN excluded.avg_delta_v   IS NULL THEN avg_delta_v   WHEN avg_delta_v   IS NULL OR sample_count = 0 THEN excluded.avg_delta_v   ELSE (avg_delta_v   * sample_count + excluded.avg_delta_v)   / (sample_count + 1) END,
    avg_mos_temp  = CASE WHEN excluded.avg_mos_temp  IS NULL THEN avg_mos_temp  WHEN avg_mos_temp  IS NULL OR sample_count = 0 THEN excluded.avg_mos_temp  ELSE (avg_mos_temp  * sample_count + excluded.avg_mos_temp)  / (sample_count + 1) END,
    avg_battery_temp = CASE WHEN excluded.avg_battery_temp IS NULL THEN avg_battery_temp WHEN avg_battery_temp IS NULL OR sample_count = 0 THEN excluded.avg_battery_temp ELSE (avg_battery_temp * sample_count + excluded.avg_battery_temp) / (sample_count + 1) END;
";
        cmd.Parameters.AddWithValue("$bucket", bucket);
        cmd.Parameters.AddWithValue("$did", deviceId);
        AddRollupValues(cmd, s);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void AddSnapshotParams(SqliteCommand cmd, string ts, string deviceId, Contracts.Status.DeviceTelemetrySnapshot s)
    {
        cmd.Parameters.AddWithValue("$ts", ts);
        cmd.Parameters.AddWithValue("$did", deviceId);
        AddRollupValues(cmd, s);
    }

    private static void AddRollupValues(SqliteCommand cmd, Contracts.Status.DeviceTelemetrySnapshot s)
    {
        cmd.Parameters.AddWithValue("$v", (object?)s.TotalVoltageVolts ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$a", (object?)s.CurrentAmps ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$w", (object?)s.PowerWatts ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$soc", (object?)s.StateOfChargePercent ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$minv", (object?)s.MinCellVoltageVolts ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$maxv", (object?)s.MaxCellVoltageVolts ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$dv", (object?)s.DeltaCellVoltageVolts ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$mt", (object?)s.MosTemperatureCelsius ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$bt", (object?)s.BatteryTemperatureCelsius ?? DBNull.Value);
    }

    private static async Task DeleteOlderThan(SqliteConnection conn, string table, string column, string cutoff, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = $"DELETE FROM {table} WHERE {column} < $cutoff;";
        cmd.Parameters.AddWithValue("$cutoff", cutoff);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static DateTimeOffset AlignBucket(DateTimeOffset value, TimeSpan bucketSize)
    {
        var ticks = value.UtcTicks - (value.UtcTicks % bucketSize.Ticks);
        return new DateTimeOffset(ticks, TimeSpan.Zero);
    }

    private static decimal? ReadNullableDecimal(SqliteDataReader reader, int ordinal)
        => reader.IsDBNull(ordinal) ? null : (decimal)reader.GetDouble(ordinal);

    private static async Task ExecuteAsync(SqliteConnection connection, string sql, CancellationToken ct)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
