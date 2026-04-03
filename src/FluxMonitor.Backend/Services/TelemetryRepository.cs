using System.Globalization;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace FluxMonitor.Backend.Services;

public interface ITelemetryRepository
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken);

    Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    Task ApplyRetentionAsync(CancellationToken cancellationToken);

    Task FlushBufferedAsync(bool includeActiveBucket, CancellationToken cancellationToken);

    Task<CompressionStats?> GetCompressionStatsAsync(CancellationToken cancellationToken);

    Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken);

    Task ExportAsync(Stream destination, CancellationToken cancellationToken);

    Task ImportAsync(Stream source, CancellationToken cancellationToken);
}

public sealed record TableSizeInfo(string TableName, long SizeBytes, string SizeFormatted, long RowCount);

public sealed record DatabaseSizeInfo(long TotalSizeBytes, string TotalSizeFormatted, IReadOnlyList<TableSizeInfo> Tables);

public sealed record CompressionStats(
    int TotalChunks,
    int CompressedChunks,
    int UncompressedChunks,
    long UncompressedSizeBytes,
    string UncompressedSizeFormatted,
    long CompressedSizeBytes,
    string CompressedSizeFormatted,
    double CompressionRatio);

public sealed record HistoryDataPoint(
    DateTimeOffset Timestamp,
    double? TotalVoltageVolts,
    double? CurrentAmps,
    double? PowerWatts,
    double? StateOfChargePercent,
    double? MinCellVoltageVolts,
    double? MaxCellVoltageVolts,
    double? DeltaCellVoltageVolts,
    double? MosTemperatureCelsius,
    double? BatteryTemperatureCelsius);

public sealed record CellHistoryDataPoint(
    DateTimeOffset Timestamp,
    double? VoltageVolts);

public sealed class NoOpTelemetryRepository : ITelemetryRepository
{
    public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<HistoryDataPoint>>([]);

    public Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<CellHistoryDataPoint>>([]);

    public Task ApplyRetentionAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task FlushBufferedAsync(bool includeActiveBucket, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<CompressionStats?> GetCompressionStatsAsync(CancellationToken cancellationToken)
        => Task.FromResult<CompressionStats?>(null);

    public Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken)
        => Task.FromResult(new DatabaseSizeInfo(0, "0 B", []));

    public Task ExportAsync(Stream destination, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task ImportAsync(Stream source, CancellationToken cancellationToken) => Task.CompletedTask;
}

public sealed class TimescaleTelemetryRepository(
    IOptions<MonitorConfiguration> configuration,
    DeviceConfigStore deviceConfigStore,
    DeviceDefinitionLoader definitionLoader,
    ILogger<TimescaleTelemetryRepository> logger) : ITelemetryRepository
{
    private readonly StorageConfiguration _storage = configuration.Value.Storage;
    private readonly RetentionConfiguration _retention = configuration.Value.Storage.Retention;
    private readonly CompressionConfiguration _compression = configuration.Value.Storage.Compression;
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _stateGate = new();
    private readonly Dictionary<string, Queue<BufferedSnapshot>> _recentSamples = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<AggregateKey, AggregateAccumulator> _pendingBuckets = new();
    private volatile bool _initialized;
    private volatile bool _timescaleMetadataAvailable;

    private static readonly string[] ExportTables = ["Devices", "Measurements"];
    private const int RetentionDeleteBatchSize = 5_000;
    private const int RetentionDeleteCommandTimeoutSeconds = 120;

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

            var useTimescale = await TryEnableTimescaleAsync(connection, cancellationToken);
            useTimescale = await EnsureTelemetrySchemaAsync(connection, useTimescale, cancellationToken);

            _timescaleMetadataAvailable = useTimescale;
            _initialized = true;

            logger.LogInformation(
                useTimescale
                    ? "Telemetry schema is ready with a single 5-minute Measurements hypertable and 10-minute in-memory raw cache."
                    : "Telemetry schema is ready using plain PostgreSQL storage with 10-minute in-memory raw cache.");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(device);
        ArgumentNullException.ThrowIfNull(sample);

        await InitializeAsync(cancellationToken);

        var definition = device.ResolveDefinition(definitionLoader);
        var measurements = BuildNumericMeasurements(sample, definition);
        if (measurements.Count == 0)
        {
            return;
        }

        var currentBucket = AlignToBucketBoundaryFloor(sample.Snapshot.CollectedAt, "5m");
        List<MeasurementValueRow> rowsToPersist;

        lock (_stateGate)
        {
            EnqueueRecentSampleLocked(device.DeviceId, sample.Snapshot.CollectedAt, measurements);
            AccumulateFiveMinuteBucketLocked(device.DeviceId, currentBucket, measurements);
            rowsToPersist = DrainPendingBucketsLocked(currentBucket);
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);
    }

    public async Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(
        string deviceId,
        string resolution,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
        if (device is null)
        {
            return [];
        }

        var definition = device.ResolveDefinition(definitionLoader);
        var sensors = ResolveHistorySensors(definition);
        var sensorNames = sensors
            .AsEnumerable()
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (sensorNames.Length == 0)
        {
            return [];
        }

        return string.Equals(resolution, "1s", StringComparison.Ordinal)
            ? QueryBufferedHistory(deviceId, sensors, from, to)
            : await QueryPersistedHistoryAsync(deviceId, sensors, from, to, cancellationToken);
    }

    public async Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(
        string deviceId,
        int cellIndex,
        string resolution,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
        if (device is null)
        {
            return [];
        }

        var definition = device.ResolveDefinition(definitionLoader);
        var cellEntityKey = FindCellArrayEntityKey(definition);
        if (string.IsNullOrWhiteSpace(cellEntityKey))
        {
            return [];
        }

        var sensorName = BuildCellSensorName(cellEntityKey, cellIndex);

        return string.Equals(resolution, "1s", StringComparison.Ordinal)
            ? QueryBufferedCellHistory(deviceId, sensorName, from, to)
            : await QueryPersistedCellHistoryAsync(deviceId, sensorName, from, to, cancellationToken);
    }

    public async Task ApplyRetentionAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        List<MeasurementValueRow> rowsToPersist;
        var now = DateTimeOffset.UtcNow;
        var currentBucket = AlignToBucketBoundaryFloor(now, "5m");

        lock (_stateGate)
        {
            TrimRecentSamplesLocked(now.Subtract(GetRawHistoryWindow()));
            rowsToPersist = DrainPendingBucketsLocked(currentBucket);
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);

        if (_retention.FiveMinuteWindowDays <= 0)
        {
            logger.LogInformation(
                "Retention sweep kept all persisted 5-minute samples. In-memory raw history remains capped at {Minutes} minutes.",
                GetRawHistoryWindow().TotalMinutes);
            return;
        }

        var cutoff = now.Subtract(TimeSpan.FromDays(_retention.FiveMinuteWindowDays));

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        var deleteStats = await DeleteOlderThanAsync(connection, "Measurements", "Time", cutoff, cancellationToken);
        logger.LogInformation(
            "Retention sweep finished. PersistedRowsFlushed={PersistedRowsFlushed}, PersistedCutoff={PersistedCutoff}, DeletedRows={DeletedRows}, DeleteBatches={DeleteBatches}.",
            rowsToPersist.Count,
            cutoff,
            deleteStats.DeletedRows,
            deleteStats.Batches);
    }

    public async Task FlushBufferedAsync(bool includeActiveBucket, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var drainBeforeExclusive = includeActiveBucket
            ? AlignToBucketBoundaryCeiling(DateTimeOffset.UtcNow, "5m")
            : AlignToBucketBoundaryFloor(DateTimeOffset.UtcNow, "5m");

        List<MeasurementValueRow> rowsToPersist;
        lock (_stateGate)
        {
            rowsToPersist = DrainPendingBucketsLocked(drainBeforeExclusive);
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);

        if (rowsToPersist.Count > 0)
        {
            logger.LogInformation(
                "Flushed {PersistedRows} buffered telemetry rows to storage. IncludeActiveBucket={IncludeActiveBucket}.",
                rowsToPersist.Count,
                includeActiveBucket);
        }
    }

    public async Task<CompressionStats?> GetCompressionStatsAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!_timescaleMetadataAvailable)
        {
            return null;
        }

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = """
                SELECT
                    COUNT(*)::int AS total_chunks,
                    COUNT(*) FILTER (WHERE is_compressed)::int AS compressed_chunks,
                    COUNT(*) FILTER (WHERE NOT is_compressed)::int AS uncompressed_chunks,
                    COALESCE(SUM(before_compression_total_bytes), 0)::bigint AS before_bytes,
                    COALESCE(SUM(after_compression_total_bytes), 0)::bigint AS after_bytes
                FROM hypertable_compression_stats('"Measurements"');
                """;

            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                return null;
            }

            var totalChunks = reader.GetInt32(0);
            var compressedChunks = reader.GetInt32(1);
            var uncompressedChunks = reader.GetInt32(2);
            var beforeBytes = reader.GetInt64(3);
            var afterBytes = reader.GetInt64(4);
            var ratio = afterBytes > 0 ? (double)beforeBytes / afterBytes : 0;

            return new CompressionStats(
                totalChunks,
                compressedChunks,
                uncompressedChunks,
                beforeBytes,
                FormatBytes(beforeBytes),
                afterBytes,
                FormatBytes(afterBytes),
                Math.Round(ratio, 2));
        }
        catch (PostgresException)
        {
            return null;
        }
    }

    public async Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        long totalBytes;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT pg_database_size(current_database());";
            totalBytes = ConvertDatabaseScalarToInt64(await command.ExecuteScalarAsync(cancellationToken));
        }

        var tables = new List<TableSizeInfo>(ExportTables.Length);
        foreach (var tableName in ExportTables)
        {
            var tableBytes = await GetTableSizeBytesAsync(connection, tableName, cancellationToken);
            long rowCount;

            await using (var countCommand = connection.CreateCommand())
            {
                countCommand.CommandText = $"""SELECT COUNT(*) FROM "{tableName}";""";
                rowCount = ConvertDatabaseScalarToInt64(await countCommand.ExecuteScalarAsync(cancellationToken));
            }

            tables.Add(new TableSizeInfo(tableName, tableBytes, FormatBytes(tableBytes), rowCount));
        }

        return new DatabaseSizeInfo(totalBytes, FormatBytes(totalBytes), tables);
    }

    public async Task ExportAsync(Stream destination, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);
        await FlushBufferedAsync(includeActiveBucket: false, cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        await using var writer = new StreamWriter(destination, leaveOpen: true);
        await writer.WriteLineAsync("-- FluxMonitor Database Export");
        await writer.WriteLineAsync($"-- Exported at: {DateTimeOffset.UtcNow:O}");
        await writer.WriteLineAsync();

        foreach (var tableName in ExportTables)
        {
            await writer.WriteLineAsync($"-- TABLE: {tableName}");
            using var exportReader = await connection.BeginTextExportAsync(
                $"""COPY "{tableName}" TO STDOUT (FORMAT CSV, HEADER)""",
                cancellationToken);

            string? line;
            while ((line = await exportReader.ReadLineAsync(cancellationToken)) is not null)
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

        await using (var truncateCommand = connection.CreateCommand())
        {
            truncateCommand.CommandText = """
                TRUNCATE TABLE "Measurements", "Devices" RESTART IDENTITY CASCADE;
                """;
            await truncateCommand.ExecuteNonQueryAsync(cancellationToken);
        }

        var reader = new StreamReader(source);
        string? currentTable = null;
        bool headerSkipped = false;
        NpgsqlCopyTextWriter? importWriter = null;

        try
        {
            string? line;
            while ((line = await reader.ReadLineAsync(cancellationToken)) is not null)
            {
                if (line.StartsWith("-- TABLE: ", StringComparison.Ordinal))
                {
                    currentTable = line["-- TABLE: ".Length..].Trim();
                    if (!SupportsImportTable(currentTable))
                    {
                        logger.LogWarning(
                            "Ignoring unsupported table '{TableName}' in import file.",
                            currentTable);
                        headerSkipped = false;
                        continue;
                    }

                    importWriter = await connection.BeginTextImportAsync(
                        $"""COPY "{currentTable}" FROM STDIN (FORMAT CSV, HEADER)""",
                        cancellationToken);
                    headerSkipped = false;
                    continue;
                }

                if (line.StartsWith("-- END: ", StringComparison.Ordinal))
                {
                    if (importWriter is not null)
                    {
                        await importWriter.DisposeAsync();
                        importWriter = null;
                    }

                    currentTable = null;
                    continue;
                }

                if (currentTable is null || importWriter is null)
                {
                    continue;
                }

                if (!headerSkipped)
                {
                    headerSkipped = true;
                }

                await importWriter.WriteLineAsync(line);
            }
        }
        finally
        {
            if (importWriter is not null)
            {
                await importWriter.DisposeAsync();
            }
        }

        lock (_stateGate)
        {
            _recentSamples.Clear();
            _pendingBuckets.Clear();
        }
    }

    internal static (DateTimeOffset FromInclusive, DateTimeOffset ToExclusive)? TryGetAlignedRollupWindow(
        DateTimeOffset fromInclusive,
        DateTimeOffset toExclusive,
        string resolution)
    {
        var alignedFrom = AlignToBucketBoundaryFloor(fromInclusive, resolution);
        var alignedTo = AlignToBucketBoundaryFloor(toExclusive, resolution);

        return alignedFrom < alignedTo
            ? (alignedFrom, alignedTo)
            : null;
    }

    internal static DateTimeOffset AlignToBucketBoundaryFloor(DateTimeOffset value, string resolution)
    {
        var bucketSize = GetBucketSize(resolution);
        var utcValue = value.ToUniversalTime();
        var alignedTicks = utcValue.UtcDateTime.Ticks - (utcValue.UtcDateTime.Ticks % bucketSize.Ticks);
        return new DateTimeOffset(alignedTicks, TimeSpan.Zero);
    }

    internal static DateTimeOffset AlignToBucketBoundaryCeiling(DateTimeOffset value, string resolution)
    {
        var alignedFloor = AlignToBucketBoundaryFloor(value, resolution);
        var utcValue = value.ToUniversalTime();

        return alignedFloor == utcValue
            ? alignedFloor
            : alignedFloor.Add(GetBucketSize(resolution));
    }

    internal static long ConvertDatabaseScalarToInt64(object? result) => result switch
    {
        null => 0,
        DBNull => 0,
        long value => value,
        int value => value,
        short value => value,
        byte value => value,
        decimal value => decimal.ToInt64(value),
        double value => Convert.ToInt64(value, CultureInfo.InvariantCulture),
        float value => Convert.ToInt64(value, CultureInfo.InvariantCulture),
        ulong value => checked((long)value),
        IConvertible value => value.ToInt64(CultureInfo.InvariantCulture),
        _ => 0
    };

    internal static DateTimeOffset? ConvertDatabaseScalarToDateTimeOffset(object? result) => result switch
    {
        null => null,
        DBNull => null,
        DateTimeOffset value => value.ToUniversalTime(),
        DateTime value when value.Kind == DateTimeKind.Unspecified
            => new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)),
        DateTime value => new DateTimeOffset(value).ToUniversalTime(),
        _ => throw new InvalidOperationException(
            $"Expected a timestamp scalar but received {result.GetType().FullName}.")
    };

    internal static string BuildDeleteOlderThanSql(string table, string column)
    {
        if (string.Equals(table, "Measurements", StringComparison.Ordinal) &&
            string.Equals(column, "Time", StringComparison.Ordinal))
        {
            return """
                WITH batch AS (
                    SELECT "Time", "DeviceId", "SensorName"
                    FROM "Measurements"
                    WHERE "Time" < @Cutoff
                    ORDER BY "Time", "DeviceId", "SensorName"
                    LIMIT @BatchSize
                )
                DELETE FROM "Measurements" AS target
                USING batch
                WHERE target."Time" = batch."Time"
                  AND target."DeviceId" = batch."DeviceId"
                  AND target."SensorName" = batch."SensorName";
                """;
        }

        return $"""
            WITH batch AS (
                SELECT ctid
                FROM "{table}"
                WHERE "{column}" < @Cutoff
                ORDER BY "{column}"
                LIMIT @BatchSize
            )
            DELETE FROM "{table}" AS target
            USING batch
            WHERE target.ctid = batch.ctid;
            """;
    }

    internal static string BuildTableSizeSql(bool includeTimescaleChunks) => includeTimescaleChunks
        ? """
            SELECT pg_total_relation_size(format('%I.%I', current_schema(), @TableName)::regclass) + COALESCE(
                (
                    SELECT SUM(pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name)::regclass))
                    FROM timescaledb_information.chunks
                    WHERE hypertable_schema = current_schema()
                      AND hypertable_name = @TableName
                ),
                0
            );
            """
        : """
            SELECT pg_total_relation_size(format('%I.%I', current_schema(), @TableName)::regclass);
            """;

    internal static string BuildEnableCompressionSql() => """
        ALTER TABLE "Measurements" SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = '"DeviceId", "SensorName"',
            timescaledb.compress_orderby = '"Time" DESC'
        );
        """;

    internal static bool SupportsImportTable(string tableName)
        => ExportTables.Contains(tableName, StringComparer.Ordinal);

    internal static string BuildCompressionPolicySql(int intervalMinutes) => $"""
        SELECT remove_compression_policy('"Measurements"', if_exists => true);
        SELECT add_compression_policy('"Measurements"', INTERVAL '{intervalMinutes} minutes');
        """;

    private async Task<bool> EnsureTelemetrySchemaAsync(
        NpgsqlConnection connection,
        bool useTimescale,
        CancellationToken cancellationToken)
    {
        if (await ShouldResetMeasurementsSchemaAsync(connection, cancellationToken))
        {
            logger.LogWarning("Resetting telemetry storage to the simplified Measurements(device, sensor, value) schema.");
            await ExecuteNonQueryAsync(connection, """DROP TABLE IF EXISTS "Measurements" CASCADE;""", cancellationToken);
        }

        await ExecuteNonQueryAsync(connection, """
            DROP TABLE IF EXISTS "DeviceSensors" CASCADE;
            DROP TABLE IF EXISTS public.jk_raw_samples CASCADE;
            DROP TABLE IF EXISTS public.jk_rollup_1m CASCADE;
            DROP TABLE IF EXISTS public.jk_rollup_5m CASCADE;
            DROP TABLE IF EXISTS public.jk_rollup_1h CASCADE;
            """, cancellationToken);

        await ExecuteNonQueryAsync(connection, """
            CREATE TABLE IF NOT EXISTS "Measurements" (
                "Time" TIMESTAMPTZ NOT NULL,
                "DeviceId" TEXT NOT NULL,
                "SensorName" TEXT NOT NULL,
                "Value" DOUBLE PRECISION NOT NULL,
                CONSTRAINT "PK_Measurements" PRIMARY KEY ("Time", "DeviceId", "SensorName")
            );
            """, cancellationToken);

        if (useTimescale)
        {
            useTimescale = await TryConvertMeasurementsToHypertableAsync(connection, cancellationToken);
        }

        if (useTimescale)
        {
            await TryEnableCompressionAsync(connection, cancellationToken);
        }

        await ExecuteNonQueryAsync(connection, """
            CREATE INDEX IF NOT EXISTS "IX_Measurements_DeviceId_TimeDesc"
                ON "Measurements" ("DeviceId", "Time" DESC);

            CREATE INDEX IF NOT EXISTS "IX_Measurements_DeviceId_SensorName_TimeDesc"
                ON "Measurements" ("DeviceId", "SensorName", "Time" DESC);
            """, cancellationToken);

        return useTimescale;
    }

    private async Task<bool> ShouldResetMeasurementsSchemaAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'Measurements';
            """;

        var columns = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            columns[reader.GetString(0)] = reader.GetString(1);
        }

        if (columns.Count == 0)
        {
            return false;
        }

        return !columns.TryGetValue("Time", out var timeType) ||
               !columns.TryGetValue("DeviceId", out var deviceIdType) ||
               !columns.TryGetValue("SensorName", out var sensorNameType) ||
               !columns.TryGetValue("Value", out var valueType) ||
               columns.ContainsKey("SensorId") ||
               columns.ContainsKey("ValueDouble") ||
               !string.Equals(timeType, "timestamp with time zone", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(deviceIdType, "text", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(sensorNameType, "text", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(valueType, "double precision", StringComparison.OrdinalIgnoreCase);
    }

    private void EnqueueRecentSampleLocked(
        string deviceId,
        DateTimeOffset timestamp,
        IReadOnlyDictionary<string, double> measurements)
    {
        if (!_recentSamples.TryGetValue(deviceId, out var queue))
        {
            queue = new Queue<BufferedSnapshot>();
            _recentSamples[deviceId] = queue;
        }

        queue.Enqueue(new BufferedSnapshot(timestamp.ToUniversalTime(), new Dictionary<string, double>(measurements, StringComparer.OrdinalIgnoreCase)));
        TrimQueueLocked(queue, DateTimeOffset.UtcNow.Subtract(GetRawHistoryWindow()));
    }

    private void AccumulateFiveMinuteBucketLocked(
        string deviceId,
        DateTimeOffset bucketStart,
        IReadOnlyDictionary<string, double> measurements)
    {
        foreach (var measurement in measurements)
        {
            var key = new AggregateKey(deviceId, bucketStart, measurement.Key);
            if (!_pendingBuckets.TryGetValue(key, out var accumulator))
            {
                accumulator = new AggregateAccumulator();
                _pendingBuckets[key] = accumulator;
            }

            accumulator.Add(measurement.Value);
        }
    }

    private List<MeasurementValueRow> DrainPendingBucketsLocked(DateTimeOffset drainBeforeExclusive)
    {
        if (_pendingBuckets.Count == 0)
        {
            return [];
        }

        var completedKeys = _pendingBuckets.Keys
            .Where(key => key.Time < drainBeforeExclusive)
            .OrderBy(key => key.Time)
            .ThenBy(key => key.DeviceId, StringComparer.OrdinalIgnoreCase)
            .ThenBy(key => key.SensorName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (completedKeys.Length == 0)
        {
            return [];
        }

        var rows = new List<MeasurementValueRow>(completedKeys.Length);
        foreach (var key in completedKeys)
        {
            if (_pendingBuckets.Remove(key, out var accumulator) && accumulator.HasValue)
            {
                rows.Add(new MeasurementValueRow(key.Time, key.DeviceId, key.SensorName, accumulator.Average));
            }
        }

        return rows;
    }

    private void TrimRecentSamplesLocked(DateTimeOffset cutoff)
    {
        foreach (var queue in _recentSamples.Values)
        {
            TrimQueueLocked(queue, cutoff);
        }
    }

    private static void TrimQueueLocked(Queue<BufferedSnapshot> queue, DateTimeOffset cutoff)
    {
        while (queue.Count > 0 && queue.Peek().Timestamp < cutoff)
        {
            queue.Dequeue();
        }
    }

    private async Task UpsertMeasurementsAsync(
        IReadOnlyList<MeasurementValueRow> rows,
        CancellationToken cancellationToken)
    {
        if (rows.Count == 0)
        {
            return;
        }

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var batch = new NpgsqlBatch(connection, transaction);

        const string sql = """
            INSERT INTO "Measurements" (
                "Time",
                "DeviceId",
                "SensorName",
                "Value"
            )
            VALUES (
                @Time,
                @DeviceId,
                @SensorName,
                @Value
            )
            ON CONFLICT ("Time", "DeviceId", "SensorName") DO UPDATE SET
                "Value" = EXCLUDED."Value";
            """;

        foreach (var row in rows)
        {
            var command = new NpgsqlBatchCommand(sql);
            command.Parameters.AddWithValue("Time", row.Time);
            command.Parameters.AddWithValue("DeviceId", row.DeviceId);
            command.Parameters.AddWithValue("SensorName", row.SensorName);
            command.Parameters.AddWithValue("Value", row.Value);
            batch.BatchCommands.Add(command);
        }

        await batch.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private IReadOnlyList<HistoryDataPoint> QueryBufferedHistory(
        string deviceId,
        ResolvedHistorySensors sensors,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        List<BufferedSnapshot> samples;

        lock (_stateGate)
        {
            if (!_recentSamples.TryGetValue(deviceId, out var queue))
            {
                return [];
            }

            samples = queue
                .Where(sample => sample.Timestamp >= from && sample.Timestamp <= to)
                .ToList();
        }

        if (samples.Count == 0)
        {
            return [];
        }

        var points = new SortedDictionary<DateTimeOffset, HistoryPointAccumulator>();

        foreach (var sample in samples)
        {
            var secondBucket = AlignToBucketBoundaryFloor(sample.Timestamp, "1s");
            if (!points.TryGetValue(secondBucket, out var accumulator))
            {
                accumulator = new HistoryPointAccumulator();
                points[secondBucket] = accumulator;
            }

            accumulator.Add(sample.Measurements, sensors);
        }

        return points
            .Select(entry => entry.Value.ToHistoryDataPoint(entry.Key))
            .ToArray();
    }

    private async Task<IReadOnlyList<HistoryDataPoint>> QueryPersistedHistoryAsync(
        string deviceId,
        ResolvedHistorySensors sensors,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        var effectiveFrom = AlignToBucketBoundaryFloor(from, "5m");
        var sensorNames = sensors
            .AsEnumerable()
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var rows = await LoadPersistedMeasurementRowsAsync(deviceId, sensorNames, effectiveFrom, to, cancellationToken);
        rows.AddRange(GetPendingMeasurementRows(deviceId, sensorNames, effectiveFrom, to));

        if (rows.Count == 0)
        {
            return [];
        }

        var points = new SortedDictionary<DateTimeOffset, HistoryPointAccumulator>();
        foreach (var row in rows.OrderBy(row => row.Time))
        {
            if (!points.TryGetValue(row.Time, out var accumulator))
            {
                accumulator = new HistoryPointAccumulator();
                points[row.Time] = accumulator;
            }

            accumulator.Add(row.SensorName, row.Value, sensors);
        }

        return points
            .Select(entry => entry.Value.ToHistoryDataPoint(entry.Key))
            .ToArray();
    }

    private IReadOnlyList<CellHistoryDataPoint> QueryBufferedCellHistory(
        string deviceId,
        string sensorName,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        List<BufferedSnapshot> samples;

        lock (_stateGate)
        {
            if (!_recentSamples.TryGetValue(deviceId, out var queue))
            {
                return [];
            }

            samples = queue
                .Where(sample => sample.Timestamp >= from && sample.Timestamp <= to)
                .ToList();
        }

        if (samples.Count == 0)
        {
            return [];
        }

        var points = new SortedDictionary<DateTimeOffset, NumericAccumulator>();
        foreach (var sample in samples)
        {
            if (!sample.Measurements.TryGetValue(sensorName, out var value))
            {
                continue;
            }

            var secondBucket = AlignToBucketBoundaryFloor(sample.Timestamp, "1s");
            if (!points.TryGetValue(secondBucket, out var accumulator))
            {
                accumulator = new NumericAccumulator();
                points[secondBucket] = accumulator;
            }

            accumulator.Add(value);
        }

        return points
            .Select(entry => new CellHistoryDataPoint(entry.Key, entry.Value.Value))
            .ToArray();
    }

    private async Task<IReadOnlyList<CellHistoryDataPoint>> QueryPersistedCellHistoryAsync(
        string deviceId,
        string sensorName,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        var effectiveFrom = AlignToBucketBoundaryFloor(from, "5m");
        var rows = await LoadPersistedMeasurementRowsAsync(deviceId, [sensorName], effectiveFrom, to, cancellationToken);
        rows.AddRange(GetPendingMeasurementRows(deviceId, [sensorName], effectiveFrom, to));

        return rows
            .OrderBy(row => row.Time)
            .Select(row => new CellHistoryDataPoint(row.Time, row.Value))
            .ToArray();
    }

    private async Task<List<MeasurementValueRow>> LoadPersistedMeasurementRowsAsync(
        string deviceId,
        IReadOnlyList<string> sensorNames,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        if (sensorNames.Count == 0)
        {
            return [];
        }

        var rows = new List<MeasurementValueRow>();

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT "Time", "SensorName", "Value"
            FROM "Measurements"
            WHERE "DeviceId" = @DeviceId
              AND "Time" >= @From
              AND "Time" <= @To
              AND "SensorName" = ANY(@SensorNames)
            ORDER BY "Time", "SensorName";
            """;
        command.Parameters.AddWithValue("DeviceId", deviceId);
        command.Parameters.AddWithValue("From", from);
        command.Parameters.AddWithValue("To", to);
        command.Parameters.Add(new NpgsqlParameter("SensorNames", NpgsqlDbType.Array | NpgsqlDbType.Text)
        {
            Value = sensorNames.ToArray()
        });

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new MeasurementValueRow(
                reader.GetFieldValue<DateTimeOffset>(0),
                deviceId,
                reader.GetString(1),
                reader.GetDouble(2)));
        }

        return rows;
    }

    private List<MeasurementValueRow> GetPendingMeasurementRows(
        string deviceId,
        IReadOnlyList<string> sensorNames,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        lock (_stateGate)
        {
            var nameSet = sensorNames.ToHashSet(StringComparer.OrdinalIgnoreCase);
            return _pendingBuckets
                .Where(entry =>
                    string.Equals(entry.Key.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase) &&
                    nameSet.Contains(entry.Key.SensorName) &&
                    entry.Key.Time >= from &&
                    entry.Key.Time <= to &&
                    entry.Value.HasValue)
                .OrderBy(entry => entry.Key.Time)
                .ThenBy(entry => entry.Key.SensorName, StringComparer.OrdinalIgnoreCase)
                .Select(entry => new MeasurementValueRow(entry.Key.Time, entry.Key.DeviceId, entry.Key.SensorName, entry.Value.Average))
                .ToList();
        }
    }

    private async Task<(long DeletedRows, int Batches)> DeleteOlderThanAsync(
        NpgsqlConnection connection,
        string table,
        string column,
        DateTimeOffset cutoff,
        CancellationToken cancellationToken)
    {
        var totalDeleted = 0L;
        var batches = 0;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            await using var command = connection.CreateCommand();
            command.CommandTimeout = RetentionDeleteCommandTimeoutSeconds;
            command.CommandText = BuildDeleteOlderThanSql(table, column);
            command.Parameters.AddWithValue("Cutoff", cutoff);
            command.Parameters.AddWithValue("BatchSize", NpgsqlDbType.Integer, RetentionDeleteBatchSize);

            var deleted = await command.ExecuteNonQueryAsync(cancellationToken);
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

        return (totalDeleted, batches);
    }

    private async Task<long> GetTableSizeBytesAsync(
        NpgsqlConnection connection,
        string tableName,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = BuildTableSizeSql(_timescaleMetadataAvailable);
        command.Parameters.AddWithValue("TableName", tableName);
        return ConvertDatabaseScalarToInt64(await command.ExecuteScalarAsync(cancellationToken));
    }

    private static async Task ExecuteNonQueryAsync(
        NpgsqlConnection connection,
        string sql,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<bool> TryConvertMeasurementsToHypertableAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        try
        {
            await ExecuteNonQueryAsync(
                connection,
                """SELECT create_hypertable('"Measurements"', by_range('Time'), if_not_exists => TRUE);""",
                cancellationToken);
            return true;
        }
        catch (PostgresException exception)
        {
            logger.LogWarning(
                exception,
                "Measurements table could not be converted to a TimescaleDB hypertable for database '{Database}'. Continuing with plain PostgreSQL tables.",
                connection.Database);
            return false;
        }
    }

    private async Task TryEnableCompressionAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        if (_compression.CompressAfterMinutes <= 0)
        {
            logger.LogInformation("TimescaleDB compression is disabled (CompressAfterMinutes = {Value}).", _compression.CompressAfterMinutes);
            return;
        }

        try
        {
            await ExecuteNonQueryAsync(connection, BuildEnableCompressionSql(), cancellationToken);
            await ExecuteNonQueryAsync(connection, BuildCompressionPolicySql(_compression.CompressAfterMinutes), cancellationToken);
        }
        catch (PostgresException exception)
        {
            logger.LogWarning(
                exception,
                "TimescaleDB compression could not be enabled for database '{Database}'. Storage will continue without compression.",
                connection.Database);
        }
    }

    private async Task<bool> TryEnableTimescaleAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        try
        {
            await ExecuteNonQueryAsync(connection, "CREATE EXTENSION IF NOT EXISTS timescaledb;", cancellationToken);
            return true;
        }
        catch (PostgresException exception) when (
            exception.SqlState is PostgresErrorCodes.UndefinedFile or PostgresErrorCodes.FeatureNotSupported)
        {
            logger.LogWarning(
                "TimescaleDB extension is not installed for database '{Database}'. Continuing with plain PostgreSQL tables.",
                connection.Database);
            return false;
        }
        catch (Exception exception) when (exception.Message.Contains("timescaledb", StringComparison.OrdinalIgnoreCase))
        {
            logger.LogWarning(
                exception,
                "TimescaleDB extension could not be enabled for database '{Database}'. Continuing with plain PostgreSQL tables.",
                connection.Database);
            return false;
        }
    }

    private TimeSpan GetRawHistoryWindow()
    {
        var configuredMinutes = _retention.RawSecondsWindowMinutes;
        return TimeSpan.FromMinutes(configuredMinutes > 0 ? configuredMinutes : 10);
    }

    private static Dictionary<string, double> BuildNumericMeasurements(
        DevicePollResult sample,
        DeviceDefinition definition)
    {
        var values = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);

        foreach (var parameter in sample.Snapshot.Parameters)
        {
            if (parameter.NumericValue.HasValue)
            {
                values[parameter.Key] = decimal.ToDouble(parameter.NumericValue.Value);
            }
        }

        AddSnapshotValue(values, FindEntityKeyByRole(definition, "total-voltage") ?? "total_voltage", sample.Snapshot.TotalVoltageVolts);
        AddSnapshotValue(values, FindEntityKeyByRole(definition, "current") ?? "current", sample.Snapshot.CurrentAmps);
        AddSnapshotValue(values, ResolvePowerSensorName(definition), sample.Snapshot.PowerWatts);
        AddSnapshotValue(values, FindEntityKeyByRole(definition, "state-of-charge") ?? "state_of_charge", sample.Snapshot.StateOfChargePercent);
        AddSnapshotValue(values, "min_cell_voltage", sample.Snapshot.MinCellVoltageVolts);
        AddSnapshotValue(values, "max_cell_voltage", sample.Snapshot.MaxCellVoltageVolts);
        AddSnapshotValue(values, "avg_cell_voltage", sample.Snapshot.AverageCellVoltageVolts);
        AddSnapshotValue(values, "delta_cell_voltage", sample.Snapshot.DeltaCellVoltageVolts);
        AddSnapshotValue(values, ResolveMosTemperatureSensorName(definition), sample.Snapshot.MosTemperatureCelsius);
        AddSnapshotValue(values, ResolveBatteryTemperatureSensorName(definition), sample.Snapshot.BatteryTemperatureCelsius);

        var cellEntityKey = FindCellArrayEntityKey(definition) ?? "cell_voltage";
        foreach (var cell in sample.Snapshot.Cells)
        {
            values[BuildCellSensorName(cellEntityKey, cell.Index)] = decimal.ToDouble(cell.VoltageVolts);
        }

        return values;
    }

    private static void AddSnapshotValue(IDictionary<string, double> values, string? sensorName, decimal? value)
    {
        if (!string.IsNullOrWhiteSpace(sensorName) && value.HasValue)
        {
            values[sensorName] = decimal.ToDouble(value.Value);
        }
    }

    private static string ResolvePowerSensorName(DeviceDefinition definition)
        => FindEntityKeyByRole(definition, "power")
           ?? definition.ComputedEntities.FirstOrDefault(entity =>
               string.Equals(entity.Id, "computed_power", StringComparison.OrdinalIgnoreCase))?.Id
           ?? "computed_power";

    private static string? ResolveMosTemperatureSensorName(DeviceDefinition definition)
        => definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Id, "mos_temperature", StringComparison.OrdinalIgnoreCase))?.Id
           ?? FindFirstTemperatureEntityKey(definition)
           ?? "mos_temperature";

    private static string? ResolveBatteryTemperatureSensorName(DeviceDefinition definition)
        => definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Id, "battery_temp_1", StringComparison.OrdinalIgnoreCase))?.Id
           ?? definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Id, "battery_temp_2", StringComparison.OrdinalIgnoreCase))?.Id
           ?? FindBatteryTemperatureEntityKey(definition)
           ?? "battery_temp_1";

    private static ResolvedHistorySensors ResolveHistorySensors(DeviceDefinition definition) => new(
        FindEntityKeyByRole(definition, "total-voltage") ?? "total_voltage",
        FindEntityKeyByRole(definition, "current") ?? "current",
        ResolvePowerSensorName(definition),
        FindEntityKeyByRole(definition, "state-of-charge") ?? "state_of_charge",
        "min_cell_voltage",
        "max_cell_voltage",
        "delta_cell_voltage",
        ResolveMosTemperatureSensorName(definition),
        ResolveBatteryTemperatureSensorName(definition));

    private static TimeSpan GetBucketSize(string resolution) => resolution switch
    {
        "1s" => TimeSpan.FromSeconds(1),
        "1m" => TimeSpan.FromMinutes(1),
        "5m" => TimeSpan.FromMinutes(5),
        "1h" => TimeSpan.FromHours(1),
        _ => TimeSpan.FromMinutes(5)
    };

    private static string? FindEntityKeyByRole(DeviceDefinition definition, string role)
        => definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Role, role, StringComparison.OrdinalIgnoreCase))?.Id
           ?? definition.ComputedEntities.FirstOrDefault(entity =>
               string.Equals(entity.Role, role, StringComparison.OrdinalIgnoreCase))?.Id;

    private static string? FindCellArrayEntityKey(DeviceDefinition definition)
        => definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Role, "cell-voltages", StringComparison.OrdinalIgnoreCase))?.Id
           ?? definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Type, "cell_array", StringComparison.OrdinalIgnoreCase))?.Id;

    private static string? FindFirstTemperatureEntityKey(DeviceDefinition definition)
        => definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Role, "temperature", StringComparison.OrdinalIgnoreCase))?.Id;

    private static string? FindBatteryTemperatureEntityKey(DeviceDefinition definition)
        => definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Role, "temperature", StringComparison.OrdinalIgnoreCase) &&
               !string.Equals(entity.Id, "mos_temperature", StringComparison.OrdinalIgnoreCase))?.Id;

    private static string BuildCellSensorName(string cellEntityKey, int cellIndex)
        => $"{cellEntityKey}:{cellIndex}";

    private static string FormatBytes(long bytes)
    {
        string[] suffixes = ["B", "KB", "MB", "GB", "TB"];
        double value = bytes;
        var suffixIndex = 0;

        while (value >= 1024 && suffixIndex < suffixes.Length - 1)
        {
            value /= 1024;
            suffixIndex++;
        }

        var digits = value >= 100 || suffixIndex == 0 ? 0 : 1;
        return $"{value.ToString($"F{digits}", CultureInfo.InvariantCulture)} {suffixes[suffixIndex]}";
    }

    private sealed record BufferedSnapshot(
        DateTimeOffset Timestamp,
        IReadOnlyDictionary<string, double> Measurements);

    private readonly record struct AggregateKey(
        string DeviceId,
        DateTimeOffset Time,
        string SensorName);

    private sealed class AggregateAccumulator
    {
        private double _sum;
        private int _count;

        public bool HasValue => _count > 0;

        public double Average => _count == 0 ? 0 : _sum / _count;

        public void Add(double value)
        {
            _sum += value;
            _count++;
        }
    }

    private sealed class NumericAccumulator
    {
        private double _sum;
        private int _count;

        public double? Value => _count == 0 ? null : _sum / _count;

        public void Add(double value)
        {
            _sum += value;
            _count++;
        }
    }

    private sealed class HistoryPointAccumulator
    {
        private readonly NumericAccumulator _totalVoltage = new();
        private readonly NumericAccumulator _current = new();
        private readonly NumericAccumulator _power = new();
        private readonly NumericAccumulator _soc = new();
        private readonly NumericAccumulator _minCell = new();
        private readonly NumericAccumulator _maxCell = new();
        private readonly NumericAccumulator _deltaCell = new();
        private readonly NumericAccumulator _mosTemp = new();
        private readonly NumericAccumulator _batteryTemp = new();

        public void Add(IReadOnlyDictionary<string, double> measurements, ResolvedHistorySensors sensors)
        {
            TryAdd(measurements, sensors.TotalVoltage, _totalVoltage);
            TryAdd(measurements, sensors.Current, _current);
            TryAdd(measurements, sensors.Power, _power);
            TryAdd(measurements, sensors.StateOfCharge, _soc);
            TryAdd(measurements, sensors.MinCellVoltage, _minCell);
            TryAdd(measurements, sensors.MaxCellVoltage, _maxCell);
            TryAdd(measurements, sensors.DeltaCellVoltage, _deltaCell);
            TryAdd(measurements, sensors.MosTemperature, _mosTemp);
            TryAdd(measurements, sensors.BatteryTemperature, _batteryTemp);
        }

        public void Add(string sensorName, double value, ResolvedHistorySensors sensors)
        {
            if (Matches(sensorName, sensors.TotalVoltage))
            {
                _totalVoltage.Add(value);
            }
            else if (Matches(sensorName, sensors.Current))
            {
                _current.Add(value);
            }
            else if (Matches(sensorName, sensors.Power))
            {
                _power.Add(value);
            }
            else if (Matches(sensorName, sensors.StateOfCharge))
            {
                _soc.Add(value);
            }
            else if (Matches(sensorName, sensors.MinCellVoltage))
            {
                _minCell.Add(value);
            }
            else if (Matches(sensorName, sensors.MaxCellVoltage))
            {
                _maxCell.Add(value);
            }
            else if (Matches(sensorName, sensors.DeltaCellVoltage))
            {
                _deltaCell.Add(value);
            }
            else if (Matches(sensorName, sensors.MosTemperature))
            {
                _mosTemp.Add(value);
            }
            else if (Matches(sensorName, sensors.BatteryTemperature))
            {
                _batteryTemp.Add(value);
            }
        }

        public HistoryDataPoint ToHistoryDataPoint(DateTimeOffset timestamp) => new(
            timestamp,
            _totalVoltage.Value,
            _current.Value,
            _power.Value,
            _soc.Value,
            _minCell.Value,
            _maxCell.Value,
            _deltaCell.Value,
            _mosTemp.Value,
            _batteryTemp.Value);

        private static bool Matches(string sensorName, string? expected)
            => !string.IsNullOrWhiteSpace(expected) &&
               string.Equals(sensorName, expected, StringComparison.OrdinalIgnoreCase);

        private static void TryAdd(
            IReadOnlyDictionary<string, double> measurements,
            string? sensorName,
            NumericAccumulator accumulator)
        {
            if (!string.IsNullOrWhiteSpace(sensorName) && measurements.TryGetValue(sensorName, out var value))
            {
                accumulator.Add(value);
            }
        }
    }

    private sealed record MeasurementValueRow(
        DateTimeOffset Time,
        string DeviceId,
        string SensorName,
        double Value);

    private readonly record struct ResolvedHistorySensors(
        string? TotalVoltage,
        string? Current,
        string? Power,
        string? StateOfCharge,
        string? MinCellVoltage,
        string? MaxCellVoltage,
        string? DeltaCellVoltage,
        string? MosTemperature,
        string? BatteryTemperature)
    {
        public IEnumerable<string?> AsEnumerable()
        {
            yield return TotalVoltage;
            yield return Current;
            yield return Power;
            yield return StateOfCharge;
            yield return MinCellVoltage;
            yield return MaxCellVoltage;
            yield return DeltaCellVoltage;
            yield return MosTemperature;
            yield return BatteryTemperature;
        }
    }
}
