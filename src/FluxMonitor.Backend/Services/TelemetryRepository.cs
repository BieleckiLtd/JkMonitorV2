using System.Globalization;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace FluxMonitor.Backend.Services;

public enum BucketValueKind
{
    Average,
    Min,
    Max,
    Last
}

public interface ITelemetryRepository
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken);

    Task ApplyDatabaseSettingsAsync(
        int rawSecondsWindowMinutes,
        int persistedBucketMinutes,
        CancellationToken cancellationToken);

    Task CompressHistoricalDataAsync(CancellationToken cancellationToken);

    Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, BucketValueKind bucketValueKind, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, BucketValueKind bucketValueKind, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken);

    Task<IReadOnlyList<SeriesHistoryDataPoint>> QuerySeriesHistoryAsync(
        string deviceId,
        IReadOnlyList<string> sensorNames,
        string resolution,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken);

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

public sealed record SeriesHistoryDataPoint(
    DateTimeOffset Timestamp,
    IReadOnlyDictionary<string, double?> Values);

public sealed class NoOpTelemetryRepository : ITelemetryRepository
{
    public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task PersistAsync(DeviceConfiguration device, DevicePollResult sample, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task ApplyDatabaseSettingsAsync(
        int rawSecondsWindowMinutes,
        int persistedBucketMinutes,
        CancellationToken cancellationToken)
        => Task.CompletedTask;

    public Task CompressHistoricalDataAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(string deviceId, string resolution, BucketValueKind bucketValueKind, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<HistoryDataPoint>>([]);

    public Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(string deviceId, int cellIndex, string resolution, BucketValueKind bucketValueKind, DateTimeOffset from, DateTimeOffset to, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<CellHistoryDataPoint>>([]);

    public Task<IReadOnlyList<SeriesHistoryDataPoint>> QuerySeriesHistoryAsync(
        string deviceId,
        IReadOnlyList<string> sensorNames,
        string resolution,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<SeriesHistoryDataPoint>>([]);

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
    IOptionsMonitor<MonitorConfiguration> configuration,
    DeviceConfigStore deviceConfigStore,
    DeviceDefinitionLoader definitionLoader,
    ILogger<TimescaleTelemetryRepository> logger) : ITelemetryRepository
{
    private readonly StorageConfiguration _storage = configuration.CurrentValue.Storage;
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _stateGate = new();
    private readonly Dictionary<string, Queue<BufferedSnapshot>> _recentSamples = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Queue<MeasurementValueRow>> _recentMinuteHistory = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<AggregateKey, AggregateAccumulator> _pendingMinuteBuckets = new();
    private readonly Dictionary<AggregateKey, AggregateAccumulator> _pendingBuckets = new();
    private TelemetryRuntimeSettings _runtimeSettings = TelemetryRuntimeSettings.FromStorage(configuration.CurrentValue.Storage);
    private volatile bool _initialized;
    private volatile bool _timescaleMetadataAvailable;

    private static readonly string[] ExportTables = ["Devices", "Measurements"];
    private static readonly int[] SupportedPersistedBucketMinutes = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];
    private const int RetentionDeleteBatchSize = 5_000;
    private const int RetentionDeleteCommandTimeoutSeconds = 120;
    private const double ShutdownFlushMinimumCompletionRatio = 0.45;
    private static readonly TimeSpan MinuteHistoryWindow = TimeSpan.FromHours(1);

    private TelemetryRuntimeSettings GetRuntimeSettings()
    {
        lock (_stateGate)
        {
            return _runtimeSettings;
        }
    }

    private int GetPersistedBucketMinutes() => GetRuntimeSettings().PersistedBucketMinutes;

    private string GetPersistedResolution() => GetPersistedResolution(GetPersistedBucketMinutes());

    private string GetPersistedBucketDescription() => $"{GetPersistedBucketMinutes()}-minute";

    private static bool IsTimescaleStorageProvider(string? provider)
        => string.Equals(provider, "TimescaleDb", StringComparison.OrdinalIgnoreCase);

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

            var useTimescale = IsTimescaleStorageProvider(_storage.Provider) &&
                await TryEnableTimescaleAsync(connection, cancellationToken);

            // A PostgreSQL FATAL error (e.g. timescaledb not preloaded) kills the
            // backend process and closes the connection.  Re-open before continuing.
            if (connection.State != System.Data.ConnectionState.Open)
            {
                await connection.OpenAsync(cancellationToken);
            }

            useTimescale = await EnsureTelemetrySchemaAsync(connection, useTimescale, cancellationToken);

            _timescaleMetadataAvailable = useTimescale;
            _initialized = true;

            logger.LogInformation(
                useTimescale
                    ? "Telemetry schema is ready with a single {PersistedBucket} Measurements hypertable, a {RawHistoryMinutes}-minute in-memory raw cache, and a {MinuteHistoryMinutes}-minute in-memory 1-minute rollup cache."
                    : "Telemetry schema is ready using plain PostgreSQL storage with a {PersistedBucket} persisted tier, a {RawHistoryMinutes}-minute in-memory raw cache, and a {MinuteHistoryMinutes}-minute in-memory 1-minute rollup cache.",
                GetPersistedBucketDescription(),
                GetRawHistoryWindow().TotalMinutes,
                MinuteHistoryWindow.TotalMinutes);
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

        List<MeasurementValueRow> rowsToPersist;

        lock (_stateGate)
        {
            var runtimeSettings = _runtimeSettings;
            var persistedBucketMinutes = runtimeSettings.PersistedBucketMinutes;
            var currentMinuteBucket = AlignToBucketBoundaryFloor(sample.Snapshot.CollectedAt, "1m");
            var persistedResolution = GetPersistedResolution(persistedBucketMinutes);
            var currentBucket = AlignToBucketBoundaryFloor(sample.Snapshot.CollectedAt, persistedResolution);

            EnqueueRecentSampleLocked(device.DeviceId, sample.Snapshot.CollectedAt, measurements);
            AccumulateMinuteBucketLocked(
                device.DeviceId,
                currentMinuteBucket,
                sample.Snapshot.CollectedAt,
                measurements);
            PromoteCompletedMinuteBucketsLocked(currentMinuteBucket);
            TrimRecentMinuteHistoryLocked(DateTimeOffset.UtcNow.Subtract(MinuteHistoryWindow));
            AccumulatePersistedBucketLocked(
                device.DeviceId,
                persistedBucketMinutes,
                currentBucket,
                sample.Snapshot.CollectedAt,
                measurements);
            rowsToPersist = DrainPendingBucketsLocked(currentBucket);
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);
    }

    public async Task ApplyDatabaseSettingsAsync(
        int rawSecondsWindowMinutes,
        int persistedBucketMinutes,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var updatedSettings = new TelemetryRuntimeSettings(
            rawSecondsWindowMinutes,
            NormalizePersistedBucketMinutes(persistedBucketMinutes));

        TelemetryRuntimeSettings previousSettings;
        List<MeasurementValueRow> rowsToPersist = [];
        lock (_stateGate)
        {
            previousSettings = _runtimeSettings;
            if (previousSettings == updatedSettings)
            {
                return;
            }

            if (previousSettings.PersistedBucketMinutes != updatedSettings.PersistedBucketMinutes)
            {
                rowsToPersist = DrainAllPendingBucketsLocked();
            }

            _runtimeSettings = updatedSettings;
            TrimRecentSamplesLocked(DateTimeOffset.UtcNow.Subtract(GetRawHistoryWindow(updatedSettings)));
            TrimRecentMinuteHistoryLocked(DateTimeOffset.UtcNow.Subtract(MinuteHistoryWindow));
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);

        logger.LogInformation(
            "Applied database settings live. RawSecondsWindowMinutes={RawSecondsWindowMinutes}, PersistedBucketMinutes={PersistedBucketMinutes}, FlushedRowsOnBucketChange={FlushedRowsOnBucketChange}.",
            updatedSettings.RawSecondsWindowMinutes,
            updatedSettings.PersistedBucketMinutes,
            rowsToPersist.Count);
    }

    public async Task<IReadOnlyList<HistoryDataPoint>> QueryHistoryAsync(
        string deviceId,
        string resolution,
        BucketValueKind bucketValueKind,
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

        if (string.Equals(resolution, "1s", StringComparison.Ordinal))
        {
            return QueryBufferedHistory(deviceId, sensors, bucketValueKind, from, to);
        }

        return ShouldUseMinuteHistoryCache(resolution)
            ? QueryBufferedMinuteHistory(deviceId, sensors, bucketValueKind, from, to)
            : await QueryPersistedHistoryAsync(deviceId, sensors, resolution, bucketValueKind, from, to, cancellationToken);
    }

    public async Task<IReadOnlyList<CellHistoryDataPoint>> QueryCellHistoryAsync(
        string deviceId,
        int cellIndex,
        string resolution,
        BucketValueKind bucketValueKind,
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

        if (string.Equals(resolution, "1s", StringComparison.Ordinal))
        {
            return QueryBufferedCellHistory(deviceId, sensorName, bucketValueKind, from, to);
        }

        return ShouldUseMinuteHistoryCache(resolution)
            ? QueryBufferedMinuteCellHistory(deviceId, sensorName, bucketValueKind, from, to)
            : await QueryPersistedCellHistoryAsync(deviceId, sensorName, resolution, bucketValueKind, from, to, cancellationToken);
    }

    public async Task<IReadOnlyList<SeriesHistoryDataPoint>> QuerySeriesHistoryAsync(
        string deviceId,
        IReadOnlyList<string> sensorNames,
        string resolution,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var sanitizedSensorNames = sensorNames
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Select(name => name.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (sanitizedSensorNames.Length == 0)
            return [];

        if (string.Equals(resolution, "1s", StringComparison.Ordinal))
        {
            return QueryBufferedSeriesHistory(deviceId, sanitizedSensorNames, bucketValueKind, from, to);
        }

        return ShouldUseMinuteHistoryCache(resolution)
            ? QueryBufferedMinuteSeriesHistory(deviceId, sanitizedSensorNames, bucketValueKind, from, to)
            : await QueryPersistedSeriesHistoryAsync(deviceId, sanitizedSensorNames, resolution, bucketValueKind, from, to, cancellationToken);
    }

    public async Task ApplyRetentionAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        List<MeasurementValueRow> rowsToPersist;
        var now = DateTimeOffset.UtcNow;
        var currentMinuteBucket = AlignToBucketBoundaryFloor(now, "1m");
        var persistedResolution = GetPersistedResolution();
        var currentBucket = AlignToBucketBoundaryFloor(now, persistedResolution);

        lock (_stateGate)
        {
            PromoteCompletedMinuteBucketsLocked(currentMinuteBucket);
            TrimRecentSamplesLocked(now.Subtract(GetRawHistoryWindow()));
            TrimRecentMinuteHistoryLocked(now.Subtract(MinuteHistoryWindow));
            rowsToPersist = DrainPendingBucketsLocked(currentBucket);
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);

        logger.LogInformation(
            "Retention sweep finished. PersistedRowsFlushed={PersistedRowsFlushed}, PersistedHistoryKeptForever=true, RawHistoryMinutes={RawHistoryMinutes}.",
            rowsToPersist.Count,
            GetRawHistoryWindow().TotalMinutes);
    }

    public async Task FlushBufferedAsync(bool includeActiveBucket, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var persistedResolution = GetPersistedResolution();
        var now = DateTimeOffset.UtcNow;
        var currentBucket = AlignToBucketBoundaryFloor(now, persistedResolution);
        var activeBucketProgress = GetBucketCompletionRatio(now, persistedResolution);
        var shouldFlushActiveBucket = includeActiveBucket &&
            ShouldFlushActiveBucket(now, persistedResolution, ShutdownFlushMinimumCompletionRatio);
        var drainBeforeExclusive = shouldFlushActiveBucket
            ? currentBucket.Add(GetBucketSize(persistedResolution))
            : currentBucket;

        List<MeasurementValueRow> rowsToPersist;
        lock (_stateGate)
        {
            rowsToPersist = DrainPendingBucketsLocked(drainBeforeExclusive);
        }

        await UpsertMeasurementsAsync(rowsToPersist, cancellationToken);

        if (rowsToPersist.Count > 0 || includeActiveBucket)
        {
            logger.LogInformation(
                "Flushed {PersistedRows} buffered telemetry rows to storage. IncludeActiveBucketRequested={IncludeActiveBucketRequested}, ActiveBucketFlushed={ActiveBucketFlushed}, ActiveBucketProgress={ActiveBucketProgress}.",
                rowsToPersist.Count,
                includeActiveBucket,
                shouldFlushActiveBucket,
                Math.Round(activeBucketProgress, 2));
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

    public async Task CompressHistoricalDataAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!_timescaleMetadataAvailable)
        {
            return;
        }

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        try
        {
            await ExecuteNonQueryAsync(connection, BuildNightlyCompressionSql(), cancellationToken);
            logger.LogInformation("Nightly TimescaleDB compression sweep completed.");
        }
        catch (PostgresException exception)
        {
            logger.LogWarning(
                exception,
                "Nightly TimescaleDB compression sweep failed for database '{Database}'.",
                connection.Database);
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
            _recentMinuteHistory.Clear();
            _pendingMinuteBuckets.Clear();
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

    internal static int NormalizePersistedBucketMinutes(int configuredMinutes)
        => SupportedPersistedBucketMinutes.Contains(configuredMinutes) ? configuredMinutes : 5;

    internal static string GetPersistedResolution(int configuredBucketMinutes)
        => $"{NormalizePersistedBucketMinutes(configuredBucketMinutes)}m";

    internal static bool TryParseBucketValueKind(string? value, out BucketValueKind bucketValueKind)
    {
        switch (value?.Trim().ToLowerInvariant())
        {
            case null:
            case "":
            case "avg":
            case "average":
                bucketValueKind = BucketValueKind.Average;
                return true;
            case "min":
                bucketValueKind = BucketValueKind.Min;
                return true;
            case "max":
                bucketValueKind = BucketValueKind.Max;
                return true;
            case "last":
                bucketValueKind = BucketValueKind.Last;
                return true;
            default:
                bucketValueKind = BucketValueKind.Average;
                return false;
        }
    }

    internal static string FormatBucketValueKind(BucketValueKind bucketValueKind) => bucketValueKind switch
    {
        BucketValueKind.Min => "min",
        BucketValueKind.Max => "max",
        BucketValueKind.Last => "last",
        _ => "avg"
    };

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

    internal static double GetBucketCompletionRatio(DateTimeOffset value, string resolution)
    {
        var bucketStart = AlignToBucketBoundaryFloor(value, resolution);
        var bucketSize = GetBucketSize(resolution);
        var elapsed = value.ToUniversalTime() - bucketStart;
        return Math.Clamp(elapsed.Ticks / (double)bucketSize.Ticks, 0d, 1d);
    }

    internal static bool ShouldFlushActiveBucket(
        DateTimeOffset value,
        string resolution,
        double minimumCompletionRatio)
        => GetBucketCompletionRatio(value, resolution) >= minimumCompletionRatio;

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
                    SELECT "BucketMinutes", "Time", "DeviceId", "SensorName"
                    FROM "Measurements"
                    WHERE "Time" < @Cutoff
                    ORDER BY "Time", "BucketMinutes", "DeviceId", "SensorName"
                    LIMIT @BatchSize
                )
                DELETE FROM "Measurements" AS target
                USING batch
                WHERE target."BucketMinutes" = batch."BucketMinutes"
                  AND target."Time" = batch."Time"
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
            timescaledb.compress_segmentby = '"BucketMinutes", "DeviceId", "SensorName"',
            timescaledb.compress_orderby = '"Time" DESC'
        );
        """;

    internal static bool SupportsImportTable(string tableName)
        => ExportTables.Contains(tableName, StringComparer.Ordinal);

    internal static string BuildRemoveCompressionPolicySql() => """
        SELECT remove_compression_policy('"Measurements"', if_exists => true);
        """;

    internal static string BuildNightlyCompressionSql() => """
        SELECT compress_chunk(chunk, if_not_compressed => TRUE)
        FROM show_chunks('"Measurements"', older_than => INTERVAL '1 day') AS chunk;
        """;

    private async Task<bool> EnsureTelemetrySchemaAsync(
        NpgsqlConnection connection,
        bool useTimescale,
        CancellationToken cancellationToken)
    {
        if (await ShouldResetMeasurementsSchemaAsync(connection, cancellationToken))
        {
            logger.LogWarning("Resetting telemetry storage to the bucket-stat Measurements(bucket_minutes, device, sensor, min, max, average, last) schema.");
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
                "BucketMinutes" INTEGER NOT NULL,
                "Time" TIMESTAMPTZ NOT NULL,
                "DeviceId" TEXT NOT NULL,
                "SensorName" TEXT NOT NULL,
                "MinValue" DOUBLE PRECISION NOT NULL,
                "MaxValue" DOUBLE PRECISION NOT NULL,
                "AverageValue" DOUBLE PRECISION NOT NULL,
                "LastValue" DOUBLE PRECISION NOT NULL,
                CONSTRAINT "PK_Measurements" PRIMARY KEY ("BucketMinutes", "Time", "DeviceId", "SensorName")
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
            CREATE INDEX IF NOT EXISTS "IX_Measurements_DeviceId_BucketMinutes_TimeDesc"
                ON "Measurements" ("DeviceId", "BucketMinutes", "Time" DESC);

            CREATE INDEX IF NOT EXISTS "IX_Measurements_DeviceId_SensorName_BucketMinutes_TimeDesc"
                ON "Measurements" ("DeviceId", "SensorName", "BucketMinutes", "Time" DESC);
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

        return !columns.TryGetValue("BucketMinutes", out var bucketMinutesType) ||
               !columns.TryGetValue("Time", out var timeType) ||
               !columns.TryGetValue("DeviceId", out var deviceIdType) ||
               !columns.TryGetValue("SensorName", out var sensorNameType) ||
               !columns.TryGetValue("MinValue", out var minValueType) ||
               !columns.TryGetValue("MaxValue", out var maxValueType) ||
               !columns.TryGetValue("AverageValue", out var averageValueType) ||
               !columns.TryGetValue("LastValue", out var lastValueType) ||
               columns.ContainsKey("Value") ||
               columns.ContainsKey("SensorId") ||
               columns.ContainsKey("ValueDouble") ||
               !string.Equals(bucketMinutesType, "integer", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(timeType, "timestamp with time zone", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(deviceIdType, "text", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(sensorNameType, "text", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(minValueType, "double precision", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(maxValueType, "double precision", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(averageValueType, "double precision", StringComparison.OrdinalIgnoreCase) ||
               !string.Equals(lastValueType, "double precision", StringComparison.OrdinalIgnoreCase);
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

    private void AccumulateMinuteBucketLocked(
        string deviceId,
        DateTimeOffset bucketStart,
        DateTimeOffset sampleTimestamp,
        IReadOnlyDictionary<string, double> measurements)
        => AccumulateBucketLocked(_pendingMinuteBuckets, deviceId, 1, bucketStart, sampleTimestamp, measurements);

    private void AccumulatePersistedBucketLocked(
        string deviceId,
        int bucketMinutes,
        DateTimeOffset bucketStart,
        DateTimeOffset sampleTimestamp,
        IReadOnlyDictionary<string, double> measurements)
        => AccumulateBucketLocked(_pendingBuckets, deviceId, bucketMinutes, bucketStart, sampleTimestamp, measurements);

    private static void AccumulateBucketLocked(
        IDictionary<AggregateKey, AggregateAccumulator> pendingBuckets,
        string deviceId,
        int bucketMinutes,
        DateTimeOffset bucketStart,
        DateTimeOffset sampleTimestamp,
        IReadOnlyDictionary<string, double> measurements)
    {
        foreach (var measurement in measurements)
        {
            var key = new AggregateKey(bucketMinutes, deviceId, bucketStart, measurement.Key);
            if (!pendingBuckets.TryGetValue(key, out var accumulator))
            {
                accumulator = new AggregateAccumulator();
                pendingBuckets[key] = accumulator;
            }

            accumulator.Add(sampleTimestamp, measurement.Value);
        }
    }

    private List<MeasurementValueRow> DrainPendingBucketsLocked(DateTimeOffset drainBeforeExclusive)
        => DrainMatchingPendingBucketsLocked(_pendingBuckets, key => key.Time < drainBeforeExclusive);

    private List<MeasurementValueRow> DrainAllPendingBucketsLocked()
        => DrainMatchingPendingBucketsLocked(_pendingBuckets, static _ => true);

    private List<MeasurementValueRow> DrainMinuteBucketsLocked(DateTimeOffset drainBeforeExclusive)
        => DrainMatchingPendingBucketsLocked(_pendingMinuteBuckets, key => key.Time < drainBeforeExclusive);

    private static List<MeasurementValueRow> DrainMatchingPendingBucketsLocked(
        IDictionary<AggregateKey, AggregateAccumulator> pendingBuckets,
        Func<AggregateKey, bool> predicate)
    {
        if (pendingBuckets.Count == 0)
        {
            return [];
        }

        var matchingKeys = pendingBuckets.Keys
            .Where(predicate)
            .OrderBy(key => key.Time)
            .ThenBy(key => key.BucketMinutes)
            .ThenBy(key => key.DeviceId, StringComparer.OrdinalIgnoreCase)
            .ThenBy(key => key.SensorName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        if (matchingKeys.Length == 0)
        {
            return [];
        }

        var rows = new List<MeasurementValueRow>(matchingKeys.Length);
        foreach (var key in matchingKeys)
        {
            if (pendingBuckets.Remove(key, out var accumulator) && accumulator.HasValue)
            {
                rows.Add(new MeasurementValueRow(
                    key.BucketMinutes,
                    key.Time,
                    key.DeviceId,
                    key.SensorName,
                    accumulator.Min,
                    accumulator.Max,
                    accumulator.Average,
                    accumulator.Last));
            }
        }

        return rows;
    }

    private void PromoteCompletedMinuteBucketsLocked(DateTimeOffset drainBeforeExclusive)
    {
        var rows = DrainMinuteBucketsLocked(drainBeforeExclusive);
        if (rows.Count == 0)
        {
            return;
        }

        var cutoff = DateTimeOffset.UtcNow.Subtract(MinuteHistoryWindow);
        foreach (var row in rows)
        {
            if (!_recentMinuteHistory.TryGetValue(row.DeviceId, out var queue))
            {
                queue = new Queue<MeasurementValueRow>();
                _recentMinuteHistory[row.DeviceId] = queue;
            }

            queue.Enqueue(row);
            TrimMinuteHistoryQueueLocked(queue, cutoff);
        }
    }

    private void TrimRecentSamplesLocked(DateTimeOffset cutoff)
    {
        foreach (var queue in _recentSamples.Values)
        {
            TrimQueueLocked(queue, cutoff);
        }
    }

    private void TrimRecentMinuteHistoryLocked(DateTimeOffset cutoff)
    {
        foreach (var queue in _recentMinuteHistory.Values)
        {
            TrimMinuteHistoryQueueLocked(queue, cutoff);
        }
    }

    private static void TrimQueueLocked(Queue<BufferedSnapshot> queue, DateTimeOffset cutoff)
    {
        while (queue.Count > 0 && queue.Peek().Timestamp < cutoff)
        {
            queue.Dequeue();
        }
    }

    private static void TrimMinuteHistoryQueueLocked(Queue<MeasurementValueRow> queue, DateTimeOffset cutoff)
    {
        while (queue.Count > 0 && queue.Peek().Time < cutoff)
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
                "BucketMinutes",
                "Time",
                "DeviceId",
                "SensorName",
                "MinValue",
                "MaxValue",
                "AverageValue",
                "LastValue"
            )
            VALUES (
                @BucketMinutes,
                @Time,
                @DeviceId,
                @SensorName,
                @MinValue,
                @MaxValue,
                @AverageValue,
                @LastValue
            )
            ON CONFLICT ("BucketMinutes", "Time", "DeviceId", "SensorName") DO UPDATE SET
                "MinValue" = EXCLUDED."MinValue",
                "MaxValue" = EXCLUDED."MaxValue",
                "AverageValue" = EXCLUDED."AverageValue",
                "LastValue" = EXCLUDED."LastValue";
            """;

        foreach (var row in rows)
        {
            var command = new NpgsqlBatchCommand(sql);
            command.Parameters.AddWithValue("BucketMinutes", row.BucketMinutes);
            command.Parameters.AddWithValue("Time", row.Time);
            command.Parameters.AddWithValue("DeviceId", row.DeviceId);
            command.Parameters.AddWithValue("SensorName", row.SensorName);
            command.Parameters.AddWithValue("MinValue", row.MinValue);
            command.Parameters.AddWithValue("MaxValue", row.MaxValue);
            command.Parameters.AddWithValue("AverageValue", row.AverageValue);
            command.Parameters.AddWithValue("LastValue", row.LastValue);
            batch.BatchCommands.Add(command);
        }

        await batch.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private IReadOnlyList<HistoryDataPoint> QueryBufferedHistory(
        string deviceId,
        ResolvedHistorySensors sensors,
        BucketValueKind bucketValueKind,
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

            accumulator.Add(sample.Timestamp, sample.Measurements, sensors);
        }

        return points
            .Select(entry => entry.Value.ToHistoryDataPoint(entry.Key, bucketValueKind))
            .ToArray();
    }

    private IReadOnlyList<HistoryDataPoint> QueryBufferedMinuteHistory(
        string deviceId,
        ResolvedHistorySensors sensors,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        List<MeasurementValueRow> rows = [];
        var sensorNames = sensors
            .AsEnumerable()
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        lock (_stateGate)
        {
            var now = DateTimeOffset.UtcNow;
            PromoteCompletedMinuteBucketsLocked(AlignToBucketBoundaryFloor(now, "1m"));
            TrimRecentMinuteHistoryLocked(now.Subtract(MinuteHistoryWindow));

            if (_recentMinuteHistory.TryGetValue(deviceId, out var queue))
            {
                rows.AddRange(queue.Where(row =>
                    sensorNames.Contains(row.SensorName) &&
                    row.Time >= from &&
                    row.Time <= to));
            }

            rows.AddRange(_pendingMinuteBuckets
                .Where(entry =>
                    string.Equals(entry.Key.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase) &&
                    sensorNames.Contains(entry.Key.SensorName) &&
                    entry.Key.Time >= from &&
                    entry.Key.Time <= to &&
                    entry.Value.HasValue)
                .OrderBy(entry => entry.Key.Time)
                .ThenBy(entry => entry.Key.SensorName, StringComparer.OrdinalIgnoreCase)
                .Select(entry => new MeasurementValueRow(
                    entry.Key.BucketMinutes,
                    entry.Key.Time,
                    entry.Key.DeviceId,
                    entry.Key.SensorName,
                    entry.Value.Min,
                    entry.Value.Max,
                    entry.Value.Average,
                    entry.Value.Last)));
        }

        if (rows.Count == 0)
        {
            return [];
        }

        var points = new SortedDictionary<DateTimeOffset, HistoryPointAccumulator>();
        foreach (var row in rows.OrderBy(row => row.Time).ThenBy(row => row.SensorName, StringComparer.OrdinalIgnoreCase))
        {
            if (!points.TryGetValue(row.Time, out var accumulator))
            {
                accumulator = new HistoryPointAccumulator();
                points[row.Time] = accumulator;
            }

            accumulator.Add(row.SensorName, row.GetValue(bucketValueKind), sensors);
        }

        return points
            .Select(entry => entry.Value.ToHistoryDataPoint(entry.Key, bucketValueKind))
            .ToArray();
    }

    private async Task<IReadOnlyList<HistoryDataPoint>> QueryPersistedHistoryAsync(
        string deviceId,
        ResolvedHistorySensors sensors,
        string resolution,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        var bucketMinutes = GetBucketMinutes(resolution);
        var effectiveFrom = AlignToBucketBoundaryFloor(from, resolution);
        var sensorNames = sensors
            .AsEnumerable()
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var rows = await LoadPersistedMeasurementRowsAsync(deviceId, bucketMinutes, sensorNames, effectiveFrom, to, cancellationToken);
        rows.AddRange(GetPendingMeasurementRows(deviceId, bucketMinutes, sensorNames, effectiveFrom, to));

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

            accumulator.Add(row.SensorName, row.GetValue(bucketValueKind), sensors);
        }

        return points
            .Select(entry => entry.Value.ToHistoryDataPoint(entry.Key, bucketValueKind))
            .ToArray();
    }

    private IReadOnlyList<CellHistoryDataPoint> QueryBufferedCellHistory(
        string deviceId,
        string sensorName,
        BucketValueKind bucketValueKind,
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

            accumulator.Add(sample.Timestamp, value);
        }

        return points
            .Select(entry => new CellHistoryDataPoint(entry.Key, entry.Value.GetValue(bucketValueKind)))
            .ToArray();
    }

    private IReadOnlyList<CellHistoryDataPoint> QueryBufferedMinuteCellHistory(
        string deviceId,
        string sensorName,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        List<MeasurementValueRow> rows = [];

        lock (_stateGate)
        {
            var now = DateTimeOffset.UtcNow;
            PromoteCompletedMinuteBucketsLocked(AlignToBucketBoundaryFloor(now, "1m"));
            TrimRecentMinuteHistoryLocked(now.Subtract(MinuteHistoryWindow));

            if (_recentMinuteHistory.TryGetValue(deviceId, out var queue))
            {
                rows.AddRange(queue.Where(row =>
                    string.Equals(row.SensorName, sensorName, StringComparison.OrdinalIgnoreCase) &&
                    row.Time >= from &&
                    row.Time <= to));
            }

            rows.AddRange(_pendingMinuteBuckets
                .Where(entry =>
                    string.Equals(entry.Key.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(entry.Key.SensorName, sensorName, StringComparison.OrdinalIgnoreCase) &&
                    entry.Key.Time >= from &&
                    entry.Key.Time <= to &&
                    entry.Value.HasValue)
                .OrderBy(entry => entry.Key.Time)
                .Select(entry => new MeasurementValueRow(
                    entry.Key.BucketMinutes,
                    entry.Key.Time,
                    entry.Key.DeviceId,
                    entry.Key.SensorName,
                    entry.Value.Min,
                    entry.Value.Max,
                    entry.Value.Average,
                    entry.Value.Last)));
        }

        return rows
            .OrderBy(row => row.Time)
            .Select(row => new CellHistoryDataPoint(row.Time, row.GetValue(bucketValueKind)))
            .ToArray();
    }

    private async Task<IReadOnlyList<CellHistoryDataPoint>> QueryPersistedCellHistoryAsync(
        string deviceId,
        string sensorName,
        string resolution,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        var bucketMinutes = GetBucketMinutes(resolution);
        var effectiveFrom = AlignToBucketBoundaryFloor(from, resolution);
        var rows = await LoadPersistedMeasurementRowsAsync(deviceId, bucketMinutes, [sensorName], effectiveFrom, to, cancellationToken);
        rows.AddRange(GetPendingMeasurementRows(deviceId, bucketMinutes, [sensorName], effectiveFrom, to));

        return rows
            .OrderBy(row => row.Time)
            .Select(row => new CellHistoryDataPoint(row.Time, row.GetValue(bucketValueKind)))
            .ToArray();
    }

    private IReadOnlyList<SeriesHistoryDataPoint> QueryBufferedSeriesHistory(
        string deviceId,
        IReadOnlyCollection<string> sensorNames,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        List<BufferedSnapshot> samples;

        lock (_stateGate)
        {
            if (!_recentSamples.TryGetValue(deviceId, out var queue))
                return [];

            samples = queue
                .Where(sample => sample.Timestamp >= from && sample.Timestamp <= to)
                .ToList();
        }

        if (samples.Count == 0)
            return [];

        var points = new SortedDictionary<DateTimeOffset, SeriesPointAccumulator>();
        foreach (var sample in samples)
        {
            var secondBucket = AlignToBucketBoundaryFloor(sample.Timestamp, "1s");
            if (!points.TryGetValue(secondBucket, out var accumulator))
            {
                accumulator = new SeriesPointAccumulator();
                points[secondBucket] = accumulator;
            }

            foreach (var sensorName in sensorNames)
            {
                if (sample.Measurements.TryGetValue(sensorName, out var value))
                    accumulator.Add(sensorName, sample.Timestamp, value);
            }
        }

        return points
            .Select(entry => entry.Value.ToSeriesHistoryDataPoint(entry.Key, bucketValueKind))
            .ToArray();
    }

    private IReadOnlyList<SeriesHistoryDataPoint> QueryBufferedMinuteSeriesHistory(
        string deviceId,
        IReadOnlyCollection<string> sensorNames,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        List<MeasurementValueRow> rows = [];
        var sensorNameSet = sensorNames.ToHashSet(StringComparer.OrdinalIgnoreCase);

        lock (_stateGate)
        {
            var now = DateTimeOffset.UtcNow;
            PromoteCompletedMinuteBucketsLocked(AlignToBucketBoundaryFloor(now, "1m"));
            TrimRecentMinuteHistoryLocked(now.Subtract(MinuteHistoryWindow));

            if (_recentMinuteHistory.TryGetValue(deviceId, out var queue))
            {
                rows.AddRange(queue.Where(row =>
                    sensorNameSet.Contains(row.SensorName) &&
                    row.Time >= from &&
                    row.Time <= to));
            }

            rows.AddRange(_pendingMinuteBuckets
                .Where(entry =>
                    string.Equals(entry.Key.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase) &&
                    sensorNameSet.Contains(entry.Key.SensorName) &&
                    entry.Key.Time >= from &&
                    entry.Key.Time <= to &&
                    entry.Value.HasValue)
                .OrderBy(entry => entry.Key.Time)
                .ThenBy(entry => entry.Key.SensorName, StringComparer.OrdinalIgnoreCase)
                .Select(entry => new MeasurementValueRow(
                    entry.Key.BucketMinutes,
                    entry.Key.Time,
                    entry.Key.DeviceId,
                    entry.Key.SensorName,
                    entry.Value.Min,
                    entry.Value.Max,
                    entry.Value.Average,
                    entry.Value.Last)));
        }

        if (rows.Count == 0)
            return [];

        var points = new SortedDictionary<DateTimeOffset, SeriesPointAccumulator>();
        foreach (var row in rows.OrderBy(row => row.Time).ThenBy(row => row.SensorName, StringComparer.OrdinalIgnoreCase))
        {
            if (!points.TryGetValue(row.Time, out var accumulator))
            {
                accumulator = new SeriesPointAccumulator();
                points[row.Time] = accumulator;
            }

            accumulator.Add(row.SensorName, row.Time, row.GetValue(bucketValueKind));
        }

        return points
            .Select(entry => entry.Value.ToSeriesHistoryDataPoint(entry.Key, bucketValueKind))
            .ToArray();
    }

    private async Task<IReadOnlyList<SeriesHistoryDataPoint>> QueryPersistedSeriesHistoryAsync(
        string deviceId,
        IReadOnlyList<string> sensorNames,
        string resolution,
        BucketValueKind bucketValueKind,
        DateTimeOffset from,
        DateTimeOffset to,
        CancellationToken cancellationToken)
    {
        var bucketMinutes = GetBucketMinutes(resolution);
        var effectiveFrom = AlignToBucketBoundaryFloor(from, resolution);
        var rows = await LoadPersistedMeasurementRowsAsync(deviceId, bucketMinutes, sensorNames, effectiveFrom, to, cancellationToken);
        rows.AddRange(GetPendingMeasurementRows(deviceId, bucketMinutes, sensorNames, effectiveFrom, to));

        if (rows.Count == 0)
            return [];

        var points = new SortedDictionary<DateTimeOffset, SeriesPointAccumulator>();
        foreach (var row in rows.OrderBy(row => row.Time).ThenBy(row => row.SensorName, StringComparer.OrdinalIgnoreCase))
        {
            if (!points.TryGetValue(row.Time, out var accumulator))
            {
                accumulator = new SeriesPointAccumulator();
                points[row.Time] = accumulator;
            }

            accumulator.Add(row.SensorName, row.Time, row.GetValue(bucketValueKind));
        }

        return points
            .Select(entry => entry.Value.ToSeriesHistoryDataPoint(entry.Key, bucketValueKind))
            .ToArray();
    }

    private async Task<List<MeasurementValueRow>> LoadPersistedMeasurementRowsAsync(
        string deviceId,
        int bucketMinutes,
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
            SELECT "BucketMinutes", "Time", "SensorName", "MinValue", "MaxValue", "AverageValue", "LastValue"
            FROM "Measurements"
            WHERE "DeviceId" = @DeviceId
              AND "BucketMinutes" = @BucketMinutes
              AND "Time" >= @From
              AND "Time" <= @To
              AND "SensorName" = ANY(@SensorNames)
            ORDER BY "Time", "SensorName";
            """;
        command.Parameters.AddWithValue("DeviceId", deviceId);
        command.Parameters.AddWithValue("BucketMinutes", bucketMinutes);
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
                reader.GetInt32(0),
                reader.GetFieldValue<DateTimeOffset>(1),
                deviceId,
                reader.GetString(2),
                reader.GetDouble(3),
                reader.GetDouble(4),
                reader.GetDouble(5),
                reader.GetDouble(6)));
        }

        return rows;
    }

    private List<MeasurementValueRow> GetPendingMeasurementRows(
        string deviceId,
        int bucketMinutes,
        IReadOnlyList<string> sensorNames,
        DateTimeOffset from,
        DateTimeOffset to)
    {
        lock (_stateGate)
        {
            var nameSet = sensorNames.ToHashSet(StringComparer.OrdinalIgnoreCase);
            return _pendingBuckets
                .Where(entry =>
                    entry.Key.BucketMinutes == bucketMinutes &&
                    string.Equals(entry.Key.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase) &&
                    nameSet.Contains(entry.Key.SensorName) &&
                    entry.Key.Time >= from &&
                    entry.Key.Time <= to &&
                    entry.Value.HasValue)
                .OrderBy(entry => entry.Key.Time)
                .ThenBy(entry => entry.Key.SensorName, StringComparer.OrdinalIgnoreCase)
                .Select(entry => new MeasurementValueRow(
                    entry.Key.BucketMinutes,
                    entry.Key.Time,
                    entry.Key.DeviceId,
                    entry.Key.SensorName,
                    entry.Value.Min,
                    entry.Value.Max,
                    entry.Value.Average,
                    entry.Value.Last))
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
                """SELECT create_hypertable('"Measurements"', by_range('Time', INTERVAL '1 day'), if_not_exists => TRUE);""",
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
        try
        {
            await ExecuteNonQueryAsync(connection, BuildEnableCompressionSql(), cancellationToken);
            await ExecuteNonQueryAsync(connection, BuildRemoveCompressionPolicySql(), cancellationToken);
            logger.LogInformation("TimescaleDB compression is enabled with nightly midnight sweeps.");
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
        => GetRawHistoryWindow(GetRuntimeSettings());

    private static TimeSpan GetRawHistoryWindow(TelemetryRuntimeSettings settings)
    {
        var configuredMinutes = settings.RawSecondsWindowMinutes;
        return TimeSpan.FromMinutes(configuredMinutes > 0 ? configuredMinutes : 10);
    }

    private static Dictionary<string, double> BuildNumericMeasurements(
        DevicePollResult sample,
        DeviceDefinition definition)
    {
        var values = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var timeSeriesEntities = ResolveTimeSeriesEntities(definition);

        foreach (var parameter in sample.Snapshot.Parameters)
        {
            if (parameter.NumericValue.HasValue && ShouldStoreTimeSeriesEntity(timeSeriesEntities, parameter.Key))
            {
                values[parameter.Key] = decimal.ToDouble(parameter.NumericValue.Value);
            }
        }

        AddSnapshotValue(values, FindEntityKeyByRole(definition, "total-voltage") ?? "total_voltage", sample.Snapshot.TotalVoltageVolts, timeSeriesEntities);
        AddSnapshotValue(values, FindEntityKeyByRole(definition, "current") ?? "current", sample.Snapshot.CurrentAmps, timeSeriesEntities);
        AddSnapshotValue(values, ResolvePowerSensorName(definition), sample.Snapshot.PowerWatts, timeSeriesEntities);
        AddSnapshotValue(values, FindEntityKeyByRole(definition, "state-of-charge") ?? "state_of_charge", sample.Snapshot.StateOfChargePercent, timeSeriesEntities);
        AddSnapshotValue(values, "min_cell_voltage", sample.Snapshot.MinCellVoltageVolts, timeSeriesEntities);
        AddSnapshotValue(values, "max_cell_voltage", sample.Snapshot.MaxCellVoltageVolts, timeSeriesEntities);
        AddSnapshotValue(values, "avg_cell_voltage", sample.Snapshot.AverageCellVoltageVolts, timeSeriesEntities);
        AddSnapshotValue(values, "delta_cell_voltage", sample.Snapshot.DeltaCellVoltageVolts, timeSeriesEntities);
        AddSnapshotValue(values, ResolveMosTemperatureSensorName(definition), sample.Snapshot.MosTemperatureCelsius, timeSeriesEntities);
        AddSnapshotValue(values, ResolveBatteryTemperatureSensorName(definition), sample.Snapshot.BatteryTemperatureCelsius, timeSeriesEntities);

        var cellEntityKey = FindCellArrayEntityKey(definition) ?? "cell_voltage";
        foreach (var cell in sample.Snapshot.Cells)
        {
            values[BuildCellSensorName(cellEntityKey, cell.Index)] = decimal.ToDouble(cell.VoltageVolts);
        }

        return values;
    }

    private static void AddSnapshotValue(
        IDictionary<string, double> values,
        string? sensorName,
        decimal? value,
        ISet<string>? timeSeriesEntities)
    {
        if (!string.IsNullOrWhiteSpace(sensorName) &&
            value.HasValue &&
            ShouldStoreTimeSeriesEntity(timeSeriesEntities, sensorName))
        {
            values[sensorName] = decimal.ToDouble(value.Value);
        }
    }

    private static ISet<string>? ResolveTimeSeriesEntities(DeviceDefinition definition)
    {
        var timeSeries = definition.Storage?.TimeSeries;
        if (timeSeries is not { Count: > 0 })
        {
            return null;
        }

        return timeSeries
            .Select(mapping => mapping.Entity)
            .Where(entity => !string.IsNullOrWhiteSpace(entity))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    private static bool ShouldStoreTimeSeriesEntity(ISet<string>? timeSeriesEntities, string sensorName)
        => timeSeriesEntities is null || timeSeriesEntities.Contains(sensorName);

    private static string ResolvePowerSensorName(DeviceDefinition definition)
        => FindEntityKeyByRole(definition, "power")
           ?? definition.ComputedEntities.FirstOrDefault(entity =>
               string.Equals(entity.Id, "computed_power", StringComparison.OrdinalIgnoreCase))?.Id
           ?? "computed_power";

    private bool ShouldUseMinuteHistoryCache(string resolution)
        => string.Equals(resolution, "1m", StringComparison.Ordinal) &&
           GetPersistedBucketMinutes() != 1;

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

    private static TimeSpan GetBucketSize(string resolution)
    {
        if (string.Equals(resolution, "1s", StringComparison.Ordinal))
        {
            return TimeSpan.FromSeconds(1);
        }

        if (string.IsNullOrWhiteSpace(resolution))
        {
            return TimeSpan.FromMinutes(5);
        }

        if (resolution.EndsWith("m", StringComparison.Ordinal) &&
            int.TryParse(resolution[..^1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var minutes) &&
            minutes > 0)
        {
            return TimeSpan.FromMinutes(minutes);
        }

        if (resolution.EndsWith("h", StringComparison.Ordinal) &&
            int.TryParse(resolution[..^1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var hours) &&
            hours > 0)
        {
            return TimeSpan.FromHours(hours);
        }

        return TimeSpan.FromMinutes(5);
    }

    private static int GetBucketMinutes(string resolution)
    {
        if (string.IsNullOrWhiteSpace(resolution))
        {
            return 5;
        }

        if (resolution.EndsWith("m", StringComparison.Ordinal) &&
            int.TryParse(resolution[..^1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var minutes) &&
            minutes > 0)
        {
            return NormalizePersistedBucketMinutes(minutes);
        }

        if (resolution.EndsWith("h", StringComparison.Ordinal) &&
            int.TryParse(resolution[..^1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var hours) &&
            hours > 0)
        {
            return NormalizePersistedBucketMinutes(hours * 60);
        }

        return 5;
    }

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
        int BucketMinutes,
        string DeviceId,
        DateTimeOffset Time,
        string SensorName);

    private sealed class AggregateAccumulator
    {
        private double _min = double.MaxValue;
        private double _max = double.MinValue;
        private double _sum;
        private int _count;
        private double _last;
        private DateTimeOffset? _lastTimestamp;

        public bool HasValue => _count > 0;

        public double Min => _count == 0 ? 0 : _min;

        public double Max => _count == 0 ? 0 : _max;

        public double Average => _count == 0 ? 0 : _sum / _count;

        public double Last => _count == 0 ? 0 : _last;

        public void Add(DateTimeOffset timestamp, double value)
        {
            if (_count == 0)
            {
                _min = value;
                _max = value;
                _last = value;
                _lastTimestamp = timestamp.ToUniversalTime();
            }
            else
            {
                _min = Math.Min(_min, value);
                _max = Math.Max(_max, value);

                var utcTimestamp = timestamp.ToUniversalTime();
                if (!_lastTimestamp.HasValue || utcTimestamp >= _lastTimestamp.Value)
                {
                    _last = value;
                    _lastTimestamp = utcTimestamp;
                }
            }

            _sum += value;
            _count++;
        }
    }

    private sealed class NumericAccumulator
    {
        private double _min = double.MaxValue;
        private double _max = double.MinValue;
        private double _sum;
        private int _count;
        private double _last;
        private DateTimeOffset? _lastTimestamp;

        public double? GetValue(BucketValueKind bucketValueKind)
        {
            if (_count == 0)
            {
                return null;
            }

            return bucketValueKind switch
            {
                BucketValueKind.Min => _min,
                BucketValueKind.Max => _max,
                BucketValueKind.Last => _last,
                _ => _sum / _count
            };
        }

        public void Add(double value)
        {
            AddCore(value);
            _last = value;
        }

        public void Add(DateTimeOffset timestamp, double value)
        {
            AddCore(value);

            var utcTimestamp = timestamp.ToUniversalTime();
            if (!_lastTimestamp.HasValue || utcTimestamp >= _lastTimestamp.Value)
            {
                _last = value;
                _lastTimestamp = utcTimestamp;
            }
        }

        private void AddCore(double value)
        {
            if (_count == 0)
            {
                _min = value;
                _max = value;
            }
            else
            {
                _min = Math.Min(_min, value);
                _max = Math.Max(_max, value);
            }

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

        public void Add(DateTimeOffset timestamp, IReadOnlyDictionary<string, double> measurements, ResolvedHistorySensors sensors)
        {
            TryAdd(measurements, sensors.TotalVoltage, _totalVoltage, timestamp);
            TryAdd(measurements, sensors.Current, _current, timestamp);
            TryAdd(measurements, sensors.Power, _power, timestamp);
            TryAdd(measurements, sensors.StateOfCharge, _soc, timestamp);
            TryAdd(measurements, sensors.MinCellVoltage, _minCell, timestamp);
            TryAdd(measurements, sensors.MaxCellVoltage, _maxCell, timestamp);
            TryAdd(measurements, sensors.DeltaCellVoltage, _deltaCell, timestamp);
            TryAdd(measurements, sensors.MosTemperature, _mosTemp, timestamp);
            TryAdd(measurements, sensors.BatteryTemperature, _batteryTemp, timestamp);
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

        public HistoryDataPoint ToHistoryDataPoint(DateTimeOffset timestamp, BucketValueKind bucketValueKind) => new(
            timestamp,
            _totalVoltage.GetValue(bucketValueKind),
            _current.GetValue(bucketValueKind),
            _power.GetValue(bucketValueKind),
            _soc.GetValue(bucketValueKind),
            _minCell.GetValue(bucketValueKind),
            _maxCell.GetValue(bucketValueKind),
            _deltaCell.GetValue(bucketValueKind),
            _mosTemp.GetValue(bucketValueKind),
            _batteryTemp.GetValue(bucketValueKind));

        private static bool Matches(string sensorName, string? expected)
            => !string.IsNullOrWhiteSpace(expected) &&
               string.Equals(sensorName, expected, StringComparison.OrdinalIgnoreCase);

        private static void TryAdd(
            IReadOnlyDictionary<string, double> measurements,
            string? sensorName,
            NumericAccumulator accumulator,
            DateTimeOffset timestamp)
        {
            if (!string.IsNullOrWhiteSpace(sensorName) && measurements.TryGetValue(sensorName, out var value))
            {
                accumulator.Add(timestamp, value);
            }
        }
    }

    private sealed class SeriesPointAccumulator
    {
        private readonly Dictionary<string, NumericAccumulator> _accumulators = new(StringComparer.OrdinalIgnoreCase);

        public void Add(string sensorName, DateTimeOffset timestamp, double value)
        {
            if (!_accumulators.TryGetValue(sensorName, out var accumulator))
            {
                accumulator = new NumericAccumulator();
                _accumulators[sensorName] = accumulator;
            }

            accumulator.Add(timestamp, value);
        }

        public SeriesHistoryDataPoint ToSeriesHistoryDataPoint(DateTimeOffset timestamp, BucketValueKind bucketValueKind)
        {
            var values = _accumulators.ToDictionary(
                entry => entry.Key,
                entry => entry.Value.GetValue(bucketValueKind),
                StringComparer.OrdinalIgnoreCase);

            return new SeriesHistoryDataPoint(timestamp, values);
        }
    }

    private sealed record MeasurementValueRow(
        int BucketMinutes,
        DateTimeOffset Time,
        string DeviceId,
        string SensorName,
        double MinValue,
        double MaxValue,
        double AverageValue,
        double LastValue)
    {
        public double GetValue(BucketValueKind bucketValueKind) => bucketValueKind switch
        {
            BucketValueKind.Min => MinValue,
            BucketValueKind.Max => MaxValue,
            BucketValueKind.Last => LastValue,
            _ => AverageValue
        };
    }

    private sealed record TelemetryRuntimeSettings(
        int RawSecondsWindowMinutes,
        int PersistedBucketMinutes)
    {
        public static TelemetryRuntimeSettings FromStorage(StorageConfiguration storage)
            => new(
                storage.Retention.RawSecondsWindowMinutes,
                NormalizePersistedBucketMinutes(storage.Retention.PersistedBucketMinutes));
    }

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
