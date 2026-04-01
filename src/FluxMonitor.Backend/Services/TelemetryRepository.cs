using System.Collections.Concurrent;
using System.Text.Json;
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

    Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken);

    Task ExportAsync(Stream destination, CancellationToken cancellationToken);

    Task ImportAsync(Stream source, CancellationToken cancellationToken);
}

public sealed record TableSizeInfo(string TableName, long SizeBytes, string SizeFormatted, long RowCount);

public sealed record DatabaseSizeInfo(long TotalSizeBytes, string TotalSizeFormatted, IReadOnlyList<TableSizeInfo> Tables);

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
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly ConcurrentDictionary<string, string> _sensorCatalogHashes = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, IReadOnlyDictionary<SensorKey, PersistedSensor>> _sensorCatalogCache = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _sensorCatalogLocks = new(StringComparer.OrdinalIgnoreCase);
    private volatile bool _initialized;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static readonly string[] ExportTables = ["Devices", "DeviceSensors", "Measurements"];
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
            var useTimescale = await TryEnableTimescaleAsync(connection, cancellationToken);

            await ExecuteNonQueryAsync(connection, """
                CREATE TABLE IF NOT EXISTS "DeviceSensors" (
                    "SensorId" INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                    "DeviceId" INTEGER NOT NULL REFERENCES "Devices" ("DeviceId") ON DELETE CASCADE,
                    "EntityKey" TEXT NOT NULL,
                    "ArrayIndex" INTEGER NOT NULL DEFAULT 0,
                    "SensorName" TEXT NOT NULL,
                    "Category" TEXT NOT NULL,
                    "DataType" TEXT NOT NULL,
                    "Unit" TEXT NULL,
                    "Writable" BOOLEAN NOT NULL DEFAULT FALSE,
                    "SortOrder" INTEGER NOT NULL DEFAULT 0,
                    "MetadataJson" JSONB NULL,
                    "CreatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    "UpdatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    CONSTRAINT "UX_DeviceSensors_DeviceId_EntityKey_ArrayIndex" UNIQUE ("DeviceId", "EntityKey", "ArrayIndex")
                );

                CREATE INDEX IF NOT EXISTS "IX_DeviceSensors_DeviceId_SortOrder"
                    ON "DeviceSensors" ("DeviceId", "SortOrder", "SensorId");
                """, cancellationToken);

            await ExecuteNonQueryAsync(connection, """
                CREATE TABLE IF NOT EXISTS "Measurements" (
                    "Time" TIMESTAMPTZ NOT NULL,
                    "DeviceId" INTEGER NOT NULL REFERENCES "Devices" ("DeviceId") ON DELETE CASCADE,
                    "SensorId" INTEGER NOT NULL REFERENCES "DeviceSensors" ("SensorId") ON DELETE CASCADE,
                    "ValueDouble" DOUBLE PRECISION NULL,
                    "ValueBigInt" BIGINT NULL,
                    "ValueBool" BOOLEAN NULL,
                    "ValueText" TEXT NULL,
                    CONSTRAINT "PK_Measurements" PRIMARY KEY ("Time", "SensorId"),
                    CONSTRAINT "CK_Measurements_OneValue" CHECK (
                        (CASE WHEN "ValueDouble" IS NULL THEN 0 ELSE 1 END) +
                        (CASE WHEN "ValueBigInt" IS NULL THEN 0 ELSE 1 END) +
                        (CASE WHEN "ValueBool" IS NULL THEN 0 ELSE 1 END) +
                        (CASE WHEN "ValueText" IS NULL THEN 0 ELSE 1 END) = 1
                    )
                );
                """, cancellationToken);

            if (useTimescale)
            {
                useTimescale = await TryConvertMeasurementsToHypertableAsync(connection, cancellationToken);
            }

            await ExecuteNonQueryAsync(connection, """
                CREATE INDEX IF NOT EXISTS "IX_Measurements_DeviceId_TimeDesc"
                    ON "Measurements" ("DeviceId", "Time" DESC);

                CREATE INDEX IF NOT EXISTS "IX_Measurements_SensorId_TimeDesc"
                    ON "Measurements" ("SensorId", "Time" DESC);
                """, cancellationToken);

            _initialized = true;
            logger.LogInformation(
                useTimescale
                    ? "Telemetry schema is ready with TimescaleDB hypertables enabled."
                    : "Telemetry schema is ready using plain PostgreSQL tables.");
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

        var persistedDeviceId = deviceConfigStore.GetPersistedDeviceId(device.DeviceId);
        var definition = device.ResolveDefinition(definitionLoader);
        var sensorCatalog = await EnsureSensorCatalogAsync(device, persistedDeviceId, definition, cancellationToken);
        var measurements = BuildMeasurementRows(sample, definition, persistedDeviceId, sensorCatalog);

        if (measurements.Count == 0)
        {
            return;
        }

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var batch = new NpgsqlBatch(connection, transaction);

        const string insertSql = """
            INSERT INTO "Measurements" (
                "Time",
                "DeviceId",
                "SensorId",
                "ValueDouble",
                "ValueBigInt",
                "ValueBool",
                "ValueText"
            )
            VALUES (
                @Time,
                @DeviceId,
                @SensorId,
                @ValueDouble,
                @ValueBigInt,
                @ValueBool,
                @ValueText
            )
            ON CONFLICT ("Time", "SensorId") DO UPDATE SET
                "DeviceId" = EXCLUDED."DeviceId",
                "ValueDouble" = EXCLUDED."ValueDouble",
                "ValueBigInt" = EXCLUDED."ValueBigInt",
                "ValueBool" = EXCLUDED."ValueBool",
                "ValueText" = EXCLUDED."ValueText";
            """;

        foreach (var measurement in measurements)
        {
            var command = new NpgsqlBatchCommand(insertSql);
            command.Parameters.AddWithValue("Time", measurement.Time);
            command.Parameters.AddWithValue("DeviceId", measurement.DeviceId);
            command.Parameters.AddWithValue("SensorId", measurement.SensorId);
            command.Parameters.Add(new NpgsqlParameter("ValueDouble", NpgsqlDbType.Double)
            {
                Value = measurement.ValueDouble.HasValue ? measurement.ValueDouble.Value : DBNull.Value
            });
            command.Parameters.Add(new NpgsqlParameter("ValueBigInt", NpgsqlDbType.Bigint)
            {
                Value = measurement.ValueBigInt.HasValue ? measurement.ValueBigInt.Value : DBNull.Value
            });
            command.Parameters.Add(new NpgsqlParameter("ValueBool", NpgsqlDbType.Boolean)
            {
                Value = measurement.ValueBool.HasValue ? measurement.ValueBool.Value : DBNull.Value
            });
            command.Parameters.Add(new NpgsqlParameter("ValueText", NpgsqlDbType.Text)
            {
                Value = measurement.ValueText ?? (object)DBNull.Value
            });
            batch.BatchCommands.Add(command);
        }

        await batch.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
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
        if (device is null || !deviceConfigStore.TryGetPersistedDeviceId(deviceId, out var persistedDeviceId))
        {
            return [];
        }

        var definition = device.ResolveDefinition(definitionLoader);
        var sensorCatalog = await EnsureSensorCatalogAsync(device, persistedDeviceId, definition, cancellationToken);

        var totalVoltageSensorId = TryGetSensorId(sensorCatalog, FindEntityKeyByRole(definition, "total-voltage"), 0);
        var currentSensorId = TryGetSensorId(sensorCatalog, FindEntityKeyByRole(definition, "current"), 0);
        var powerSensorId = TryGetSensorId(sensorCatalog, FindEntityKeyByRole(definition, "power") ?? "power", 0);
        var socSensorId = TryGetSensorId(sensorCatalog, FindEntityKeyByRole(definition, "state-of-charge"), 0);
        var minCellSensorId = TryGetSensorId(sensorCatalog, "min_cell_voltage", 0);
        var maxCellSensorId = TryGetSensorId(sensorCatalog, "max_cell_voltage", 0);
        var deltaCellSensorId = TryGetSensorId(sensorCatalog, "delta_cell_voltage", 0);
        var mosTempSensorId = TryGetSensorId(sensorCatalog, "mos_temperature", 0) ?? TryGetSensorId(sensorCatalog, FindFirstTemperatureEntityKey(definition), 0);
        var batteryTempSensorId = TryGetSensorId(sensorCatalog, "battery_temp_1", 0) ?? TryGetSensorId(sensorCatalog, FindBatteryTemperatureEntityKey(definition), 0);

        var sensorIds = new[]
        {
            totalVoltageSensorId,
            currentSensorId,
            powerSensorId,
            socSensorId,
            minCellSensorId,
            maxCellSensorId,
            deltaCellSensorId,
            mosTempSensorId,
            batteryTempSensorId
        }
        .Where(id => id.HasValue)
        .Select(id => id!.Value)
        .Distinct()
        .ToArray();

        if (sensorIds.Length == 0)
        {
            return [];
        }

        var bucketExpression = GetBucketExpression(resolution);
        var points = new List<HistoryDataPoint>();

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        await using var command = connection.CreateCommand();
        command.CommandText = $"""
            WITH filtered AS (
                SELECT
                    {bucketExpression} AS bucket,
                    "SensorId",
                    COALESCE(
                        "ValueDouble",
                        "ValueBigInt"::double precision,
                        CASE WHEN "ValueBool" IS NULL THEN NULL ELSE CASE WHEN "ValueBool" THEN 1.0 ELSE 0.0 END END
                    ) AS metric
                FROM "Measurements"
                WHERE "DeviceId" = @DeviceId
                  AND "Time" >= @From
                  AND "Time" <= @To
                  AND "SensorId" = ANY(@SensorIds)
            )
            SELECT
                bucket,
                AVG(CASE WHEN "SensorId" = @TotalVoltageSensorId THEN metric END),
                AVG(CASE WHEN "SensorId" = @CurrentSensorId THEN metric END),
                AVG(CASE WHEN "SensorId" = @PowerSensorId THEN metric END),
                AVG(CASE WHEN "SensorId" = @SocSensorId THEN metric END),
                MIN(CASE WHEN "SensorId" = @MinCellSensorId THEN metric END),
                MAX(CASE WHEN "SensorId" = @MaxCellSensorId THEN metric END),
                AVG(CASE WHEN "SensorId" = @DeltaCellSensorId THEN metric END),
                AVG(CASE WHEN "SensorId" = @MosTempSensorId THEN metric END),
                AVG(CASE WHEN "SensorId" = @BatteryTempSensorId THEN metric END)
            FROM filtered
            GROUP BY bucket
            ORDER BY bucket
            LIMIT 2000;
            """;

        command.Parameters.AddWithValue("DeviceId", persistedDeviceId);
        command.Parameters.AddWithValue("From", from);
        command.Parameters.AddWithValue("To", to);
        command.Parameters.Add(new NpgsqlParameter<int[]>("SensorIds", sensorIds)
        {
            NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Integer
        });
        command.Parameters.AddWithValue("TotalVoltageSensorId", totalVoltageSensorId ?? 0);
        command.Parameters.AddWithValue("CurrentSensorId", currentSensorId ?? 0);
        command.Parameters.AddWithValue("PowerSensorId", powerSensorId ?? 0);
        command.Parameters.AddWithValue("SocSensorId", socSensorId ?? 0);
        command.Parameters.AddWithValue("MinCellSensorId", minCellSensorId ?? 0);
        command.Parameters.AddWithValue("MaxCellSensorId", maxCellSensorId ?? 0);
        command.Parameters.AddWithValue("DeltaCellSensorId", deltaCellSensorId ?? 0);
        command.Parameters.AddWithValue("MosTempSensorId", mosTempSensorId ?? 0);
        command.Parameters.AddWithValue("BatteryTempSensorId", batteryTempSensorId ?? 0);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            points.Add(new HistoryDataPoint(
                reader.GetFieldValue<DateTimeOffset>(0),
                reader.IsDBNull(1) ? null : reader.GetDouble(1),
                reader.IsDBNull(2) ? null : reader.GetDouble(2),
                reader.IsDBNull(3) ? null : reader.GetDouble(3),
                reader.IsDBNull(4) ? null : reader.GetDouble(4),
                reader.IsDBNull(5) ? null : reader.GetDouble(5),
                reader.IsDBNull(6) ? null : reader.GetDouble(6),
                reader.IsDBNull(7) ? null : reader.GetDouble(7),
                reader.IsDBNull(8) ? null : reader.GetDouble(8),
                reader.IsDBNull(9) ? null : reader.GetDouble(9)));
        }

        return points;
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
        if (device is null || !deviceConfigStore.TryGetPersistedDeviceId(deviceId, out var persistedDeviceId))
        {
            return [];
        }

        var definition = device.ResolveDefinition(definitionLoader);
        var sensorCatalog = await EnsureSensorCatalogAsync(device, persistedDeviceId, definition, cancellationToken);
        var cellEntityKey = FindCellArrayEntityKey(definition);

        if (cellEntityKey is null || !sensorCatalog.TryGetValue(new SensorKey(cellEntityKey, cellIndex), out var sensor))
        {
            return [];
        }

        var bucketExpression = GetBucketExpression(resolution);
        var points = new List<CellHistoryDataPoint>();

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        await using var command = connection.CreateCommand();
        command.CommandText = $"""
            SELECT
                {bucketExpression} AS bucket,
                AVG(COALESCE("ValueDouble", "ValueBigInt"::double precision))
            FROM "Measurements"
            WHERE "DeviceId" = @DeviceId
              AND "SensorId" = @SensorId
              AND "Time" >= @From
              AND "Time" <= @To
            GROUP BY bucket
            ORDER BY bucket
            LIMIT 2000;
            """;
        command.Parameters.AddWithValue("DeviceId", persistedDeviceId);
        command.Parameters.AddWithValue("SensorId", sensor.SensorId);
        command.Parameters.AddWithValue("From", from);
        command.Parameters.AddWithValue("To", to);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            points.Add(new CellHistoryDataPoint(
                reader.GetFieldValue<DateTimeOffset>(0),
                reader.IsDBNull(1) ? null : reader.GetDouble(1)));
        }

        return points;
    }

    public async Task ApplyRetentionAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var rawCutoff = now.Subtract(TimeSpan.FromMinutes(Math.Max(_retention.RawSecondsWindowMinutes, 0)));
        var oneMinuteCutoff = now.Subtract(TimeSpan.FromHours(Math.Max(_retention.OneMinuteWindowHours, 0)));
        DateTimeOffset? fiveMinuteCutoff = _retention.FiveMinuteWindowDays > 0
            ? now.Subtract(TimeSpan.FromDays(_retention.FiveMinuteWindowDays))
            : null;

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        if (_retention.OneMinuteWindowHours > 0 && rawCutoff > oneMinuteCutoff)
        {
            await RollupMeasurementsAsync(connection, oneMinuteCutoff, rawCutoff, "1m", cancellationToken);
        }

        if (fiveMinuteCutoff is not null && oneMinuteCutoff > fiveMinuteCutoff.Value)
        {
            await RollupMeasurementsAsync(connection, fiveMinuteCutoff.Value, oneMinuteCutoff, "5m", cancellationToken);
            await DeleteOlderThanAsync(
                connection,
                "Measurements",
                "Time",
                fiveMinuteCutoff.Value,
                cancellationToken);
        }

        logger.LogDebug("Retention sweep completed.");
    }

    public async Task<DatabaseSizeInfo> GetDatabaseSizeAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        await using var connection = new NpgsqlConnection(_storage.ConnectionString);
        await connection.OpenAsync(cancellationToken);

        long totalBytes = 0;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = "SELECT pg_database_size(current_database());";
            var result = await command.ExecuteScalarAsync(cancellationToken);
            totalBytes = result is long value ? value : 0;
        }

        var tables = new List<TableSizeInfo>();
        foreach (var tableName in ExportTables)
        {
            long tableBytes = await GetTableSizeBytesAsync(connection, tableName, cancellationToken);
            long rowCount = 0;

            await using (var countCommand = connection.CreateCommand())
            {
                countCommand.CommandText = $"""SELECT COUNT(*) FROM "{tableName}";""";
                var result = await countCommand.ExecuteScalarAsync(cancellationToken);
                rowCount = result is long value ? value : 0;
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

        var writer = new StreamWriter(destination, leaveOpen: true);
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
                TRUNCATE TABLE "Measurements", "DeviceSensors", "Devices" RESTART IDENTITY CASCADE;
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
                    if (!ExportTables.Contains(currentTable, StringComparer.Ordinal))
                    {
                        throw new InvalidOperationException($"Unsupported table '{currentTable}' in import.");
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

        _sensorCatalogHashes.Clear();
        _sensorCatalogCache.Clear();
    }

    private async Task<IReadOnlyDictionary<SensorKey, PersistedSensor>> EnsureSensorCatalogAsync(
        DeviceConfiguration device,
        int persistedDeviceId,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        if (_sensorCatalogCache.TryGetValue(device.DeviceId, out var cachedCatalog) &&
            _sensorCatalogHashes.TryGetValue(device.DeviceId, out var cachedHash) &&
            string.Equals(cachedHash, device.DefinitionHash, StringComparison.Ordinal))
        {
            return cachedCatalog;
        }

        var catalogLock = _sensorCatalogLocks.GetOrAdd(device.DeviceId, _ => new SemaphoreSlim(1, 1));
        await catalogLock.WaitAsync(cancellationToken);
        try
        {
            if (_sensorCatalogCache.TryGetValue(device.DeviceId, out cachedCatalog) &&
                _sensorCatalogHashes.TryGetValue(device.DeviceId, out cachedHash) &&
                string.Equals(cachedHash, device.DefinitionHash, StringComparison.Ordinal))
            {
                return cachedCatalog;
            }

            var desiredSensors = BuildSensorDefinitions(definition);

            await using var connection = new NpgsqlConnection(_storage.ConnectionString);
            await connection.OpenAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

            var existingSensors = (await LoadPersistedSensorsAsync(connection, transaction, persistedDeviceId, cancellationToken))
                .ToDictionary(sensor => sensor.Key, sensor => sensor, SensorKeyComparer.Instance);

            foreach (var sensor in desiredSensors)
            {
                await UpsertSensorAsync(connection, transaction, persistedDeviceId, sensor, cancellationToken);
            }

            var removedSensorIds = existingSensors
                .Where(existing => !desiredSensors.Any(desired => desired.Key.Equals(existing.Key)))
                .Select(existing => existing.Value.SensorId)
                .ToArray();

            if (removedSensorIds.Length > 0)
            {
                await using var deleteCommand = connection.CreateCommand();
                deleteCommand.Transaction = transaction;
                deleteCommand.CommandText = """
                    DELETE FROM "DeviceSensors"
                    WHERE "SensorId" = ANY(@SensorIds);
                    """;
                deleteCommand.Parameters.Add(new NpgsqlParameter<int[]>("SensorIds", removedSensorIds)
                {
                    NpgsqlDbType = NpgsqlDbType.Array | NpgsqlDbType.Integer
                });
                await deleteCommand.ExecuteNonQueryAsync(cancellationToken);
            }

            await transaction.CommitAsync(cancellationToken);

            var refreshedCatalog = (await LoadPersistedSensorsAsync(connection, null, persistedDeviceId, cancellationToken))
                .ToDictionary(sensor => sensor.Key, sensor => sensor, SensorKeyComparer.Instance);

            _sensorCatalogHashes[device.DeviceId] = device.DefinitionHash;
            _sensorCatalogCache[device.DeviceId] = refreshedCatalog;

            return refreshedCatalog;
        }
        finally
        {
            catalogLock.Release();
        }
    }

    private static async Task<IReadOnlyList<PersistedSensor>> LoadPersistedSensorsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction? transaction,
        int persistedDeviceId,
        CancellationToken cancellationToken)
    {
        var sensors = new List<PersistedSensor>();
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            SELECT
                "SensorId",
                "EntityKey",
                "ArrayIndex",
                "DataType"
            FROM "DeviceSensors"
            WHERE "DeviceId" = @DeviceId;
            """;
        command.Parameters.AddWithValue("DeviceId", persistedDeviceId);

        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            var key = new SensorKey(reader.GetString(1), reader.GetInt32(2));
            sensors.Add(new PersistedSensor(
                reader.GetInt32(0),
                key,
                ParseDataType(reader.GetString(3))));
        }

        return sensors;
    }

    private static async Task UpsertSensorAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        int persistedDeviceId,
        SensorDefinition sensor,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO "DeviceSensors" (
                "DeviceId",
                "EntityKey",
                "ArrayIndex",
                "SensorName",
                "Category",
                "DataType",
                "Unit",
                "Writable",
                "SortOrder",
                "MetadataJson",
                "UpdatedAt"
            )
            VALUES (
                @DeviceId,
                @EntityKey,
                @ArrayIndex,
                @SensorName,
                @Category,
                @DataType,
                @Unit,
                @Writable,
                @SortOrder,
                @MetadataJson,
                NOW()
            )
            ON CONFLICT ("DeviceId", "EntityKey", "ArrayIndex") DO UPDATE SET
                "SensorName" = EXCLUDED."SensorName",
                "Category" = EXCLUDED."Category",
                "DataType" = EXCLUDED."DataType",
                "Unit" = EXCLUDED."Unit",
                "Writable" = EXCLUDED."Writable",
                "SortOrder" = EXCLUDED."SortOrder",
                "MetadataJson" = EXCLUDED."MetadataJson",
                "UpdatedAt" = NOW();
            """;

        command.Parameters.AddWithValue("DeviceId", persistedDeviceId);
        command.Parameters.AddWithValue("EntityKey", sensor.Key.EntityKey);
        command.Parameters.AddWithValue("ArrayIndex", sensor.Key.ArrayIndex);
        command.Parameters.AddWithValue("SensorName", sensor.SensorName);
        command.Parameters.AddWithValue("Category", sensor.Category);
        command.Parameters.AddWithValue("DataType", ToDatabaseValue(sensor.DataType));
        command.Parameters.Add(new NpgsqlParameter("Unit", NpgsqlDbType.Text)
        {
            Value = sensor.Unit ?? (object)DBNull.Value
        });
        command.Parameters.AddWithValue("Writable", sensor.Writable);
        command.Parameters.AddWithValue("SortOrder", sensor.SortOrder);
        command.Parameters.Add(new NpgsqlParameter("MetadataJson", NpgsqlDbType.Jsonb)
        {
            Value = sensor.MetadataJson ?? (object)DBNull.Value
        });
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static List<SensorDefinition> BuildSensorDefinitions(DeviceDefinition definition)
    {
        var sensors = new List<SensorDefinition>();
        var sortOrder = 0;

        foreach (var entity in definition.Entities)
        {
            if (string.Equals(entity.Type, "cell_array", StringComparison.OrdinalIgnoreCase))
            {
                var maxElements = entity.Source.MaxElements > 0 ? entity.Source.MaxElements : 32;
                for (var index = 1; index <= maxElements; index++)
                {
                    sensors.Add(new SensorDefinition(
                        new SensorKey(entity.Id, index),
                        $"Cell {index}",
                        entity.Category,
                        MeasurementDataType.Double,
                        entity.Source.Unit,
                        entity.Writable,
                        sortOrder++,
                        BuildSensorMetadataJson(entity.Type, entity.Role)));
                }

                continue;
            }

            sensors.Add(new SensorDefinition(
                new SensorKey(entity.Id, 0),
                entity.Name,
                entity.Category,
                ResolveEntityDataType(entity),
                entity.Source.Unit,
                entity.Writable,
                sortOrder++,
                BuildSensorMetadataJson(entity.Type, entity.Role)));
        }

        foreach (var computed in definition.ComputedEntities)
        {
            sensors.Add(new SensorDefinition(
                new SensorKey(computed.Id, 0),
                computed.Name,
                computed.Category,
                ResolveComputedDataType(computed),
                computed.Unit,
                false,
                sortOrder++,
                BuildSensorMetadataJson(computed.Type, computed.Role)));
        }

        return sensors;
    }

    private static string? BuildSensorMetadataJson(string type, string? role)
        => JsonSerializer.Serialize(new { Type = type, Role = role }, JsonOptions);

    private static MeasurementDataType ResolveEntityDataType(EntityDefinition entity)
    {
        if (string.Equals(entity.Type, "binary_sensor", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(entity.Type, "switch", StringComparison.OrdinalIgnoreCase))
        {
            return MeasurementDataType.Bool;
        }

        if (string.Equals(entity.Type, "text", StringComparison.OrdinalIgnoreCase))
        {
            return MeasurementDataType.Text;
        }

        var isIntegralSource =
            entity.Source.Scale == 1 &&
            (entity.Display?.Precision is null or 0) &&
            (entity.Source.DataType.StartsWith("int", StringComparison.OrdinalIgnoreCase) ||
             entity.Source.DataType.StartsWith("uint", StringComparison.OrdinalIgnoreCase));

        return isIntegralSource
            ? MeasurementDataType.BigInt
            : MeasurementDataType.Double;
    }

    private static MeasurementDataType ResolveComputedDataType(ComputedEntityDefinition entity)
        => string.Equals(entity.Type, "binary_sensor", StringComparison.OrdinalIgnoreCase)
            ? MeasurementDataType.Bool
            : MeasurementDataType.Double;

    private static List<MeasurementRow> BuildMeasurementRows(
        DevicePollResult sample,
        DeviceDefinition definition,
        int persistedDeviceId,
        IReadOnlyDictionary<SensorKey, PersistedSensor> sensorCatalog)
    {
        var rows = new Dictionary<int, MeasurementRow>();

        foreach (var parameter in sample.Snapshot.Parameters)
        {
            if (!sensorCatalog.TryGetValue(new SensorKey(parameter.Key, 0), out var sensor))
            {
                continue;
            }

            MeasurementRow? row = sensor.DataType switch
            {
                MeasurementDataType.Bool when parameter.BooleanValue.HasValue
                    => new MeasurementRow(sample.Snapshot.CollectedAt, persistedDeviceId, sensor.SensorId, null, null, parameter.BooleanValue.Value, null),
                MeasurementDataType.Text when !string.IsNullOrWhiteSpace(parameter.StringValue)
                    => new MeasurementRow(sample.Snapshot.CollectedAt, persistedDeviceId, sensor.SensorId, null, null, null, parameter.StringValue),
                MeasurementDataType.BigInt when parameter.RawValue.HasValue
                    => new MeasurementRow(sample.Snapshot.CollectedAt, persistedDeviceId, sensor.SensorId, null, parameter.RawValue.Value, null, null),
                MeasurementDataType.BigInt when parameter.NumericValue.HasValue && decimal.Truncate(parameter.NumericValue.Value) == parameter.NumericValue.Value
                    => new MeasurementRow(sample.Snapshot.CollectedAt, persistedDeviceId, sensor.SensorId, null, decimal.ToInt64(parameter.NumericValue.Value), null, null),
                MeasurementDataType.Double when parameter.NumericValue.HasValue
                    => new MeasurementRow(sample.Snapshot.CollectedAt, persistedDeviceId, sensor.SensorId, decimal.ToDouble(parameter.NumericValue.Value), null, null, null),
                MeasurementDataType.BigInt when parameter.NumericValue.HasValue
                    => new MeasurementRow(sample.Snapshot.CollectedAt, persistedDeviceId, sensor.SensorId, decimal.ToDouble(parameter.NumericValue.Value), null, null, null),
                _ => null
            };

            if (row is not null)
            {
                rows[sensor.SensorId] = row;
            }
        }

        var cellEntityKey = FindCellArrayEntityKey(definition);
        if (cellEntityKey is not null)
        {
            foreach (var cell in sample.Snapshot.Cells)
            {
                if (!sensorCatalog.TryGetValue(new SensorKey(cellEntityKey, cell.Index), out var sensor))
                {
                    continue;
                }

                rows[sensor.SensorId] = new MeasurementRow(
                    sample.Snapshot.CollectedAt,
                    persistedDeviceId,
                    sensor.SensorId,
                    decimal.ToDouble(cell.VoltageVolts),
                    null,
                    null,
                    null);
            }
        }

        return rows.Values.ToList();
    }

    private static string GetBucketExpression(string resolution) => resolution switch
    {
        "1s" => "\"Time\"",
        "1m" => "date_trunc('minute', \"Time\")",
        "5m" => "to_timestamp(floor(extract(epoch from \"Time\") / 300) * 300)",
        "1h" => "date_trunc('hour', \"Time\")",
        _ => "to_timestamp(floor(extract(epoch from \"Time\") / 300) * 300)"
    };

    private async Task DeleteOlderThanAsync(
        NpgsqlConnection connection,
        string table,
        string column,
        DateTimeOffset cutoff,
        CancellationToken cancellationToken)
    {
        var totalDeleted = 0;
        var batches = 0;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            await using var command = connection.CreateCommand();
            command.CommandTimeout = RetentionDeleteCommandTimeoutSeconds;
            command.CommandText = $"""
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

    private async Task RollupMeasurementsAsync(
        NpgsqlConnection connection,
        DateTimeOffset fromInclusive,
        DateTimeOffset toExclusive,
        string resolution,
        CancellationToken cancellationToken)
    {
        if (fromInclusive >= toExclusive)
        {
            return;
        }

        await using var command = connection.CreateCommand();
        command.CommandTimeout = RetentionDeleteCommandTimeoutSeconds;
        command.CommandText = $"""
            WITH deleted AS (
                DELETE FROM "Measurements"
                WHERE "Time" >= @From
                  AND "Time" < @To
                RETURNING
                    "Time",
                    "DeviceId",
                    "SensorId",
                    "ValueDouble",
                    "ValueBigInt",
                    "ValueBool",
                    "ValueText"
            ),
            bucketed AS (
                SELECT
                    {GetBucketExpression(resolution)} AS bucket,
                    deleted.*
                FROM deleted
            ),
            rolled AS (
                SELECT DISTINCT ON (bucket, "SensorId")
                    bucket AS "Time",
                    "DeviceId",
                    "SensorId",
                    "ValueDouble",
                    "ValueBigInt",
                    "ValueBool",
                    "ValueText"
                FROM bucketed
                ORDER BY bucket, "SensorId", "Time" DESC
            )
            INSERT INTO "Measurements" (
                "Time",
                "DeviceId",
                "SensorId",
                "ValueDouble",
                "ValueBigInt",
                "ValueBool",
                "ValueText"
            )
            SELECT
                "Time",
                "DeviceId",
                "SensorId",
                "ValueDouble",
                "ValueBigInt",
                "ValueBool",
                "ValueText"
            FROM rolled;
            """;
        command.Parameters.AddWithValue("From", fromInclusive);
        command.Parameters.AddWithValue("To", toExclusive);

        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<long> GetTableSizeBytesAsync(
        NpgsqlConnection connection,
        string tableName,
        CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT CASE
                WHEN to_regclass('timescaledb_information.chunks') IS NULL THEN pg_total_relation_size(format('%I.%I', current_schema(), @TableName)::regclass)
                ELSE pg_total_relation_size(format('%I.%I', current_schema(), @TableName)::regclass) + COALESCE(
                    (
                        SELECT SUM(pg_total_relation_size(format('%I.%I', chunk_schema, chunk_name)::regclass))
                        FROM timescaledb_information.chunks
                        WHERE hypertable_schema = current_schema()
                          AND hypertable_name = @TableName
                    ),
                    0
                )
            END;
            """;
        command.Parameters.AddWithValue("TableName", tableName);

        var result = await command.ExecuteScalarAsync(cancellationToken);
        return result is long value ? value : 0;
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
        catch (Exception exception) when (
            exception.Message.Contains("timescaledb", StringComparison.OrdinalIgnoreCase))
        {
            logger.LogWarning(
                exception,
                "TimescaleDB extension could not be enabled for database '{Database}'. Continuing with plain PostgreSQL tables.",
                connection.Database);
            return false;
        }
    }

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
        return $"{value.ToString($"F{digits}")} {suffixes[suffixIndex]}";
    }

    private static int? TryGetSensorId(
        IReadOnlyDictionary<SensorKey, PersistedSensor> sensorCatalog,
        string? entityKey,
        int arrayIndex)
    {
        if (string.IsNullOrWhiteSpace(entityKey))
        {
            return null;
        }

        return sensorCatalog.TryGetValue(new SensorKey(entityKey, arrayIndex), out var sensor)
            ? sensor.SensorId
            : null;
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
               string.Equals(entity.Id, "battery_temp_1", StringComparison.OrdinalIgnoreCase))?.Id
           ?? definition.Entities.FirstOrDefault(entity =>
               string.Equals(entity.Role, "temperature", StringComparison.OrdinalIgnoreCase) &&
               !string.Equals(entity.Id, "mos_temperature", StringComparison.OrdinalIgnoreCase))?.Id;

    private static MeasurementDataType ParseDataType(string value) => value.ToLowerInvariant() switch
    {
        "bigint" => MeasurementDataType.BigInt,
        "bool" => MeasurementDataType.Bool,
        "text" => MeasurementDataType.Text,
        _ => MeasurementDataType.Double
    };

    private static string ToDatabaseValue(MeasurementDataType dataType) => dataType switch
    {
        MeasurementDataType.BigInt => "bigint",
        MeasurementDataType.Bool => "bool",
        MeasurementDataType.Text => "text",
        _ => "double"
    };

    private readonly record struct SensorKey(string EntityKey, int ArrayIndex);

    private sealed class SensorKeyComparer : IEqualityComparer<SensorKey>
    {
        public static SensorKeyComparer Instance { get; } = new();

        public bool Equals(SensorKey x, SensorKey y)
            => string.Equals(x.EntityKey, y.EntityKey, StringComparison.OrdinalIgnoreCase)
               && x.ArrayIndex == y.ArrayIndex;

        public int GetHashCode(SensorKey obj)
            => HashCode.Combine(StringComparer.OrdinalIgnoreCase.GetHashCode(obj.EntityKey), obj.ArrayIndex);
    }

    private sealed record SensorDefinition(
        SensorKey Key,
        string SensorName,
        string Category,
        MeasurementDataType DataType,
        string? Unit,
        bool Writable,
        int SortOrder,
        string? MetadataJson);

    private sealed record PersistedSensor(
        int SensorId,
        SensorKey Key,
        MeasurementDataType DataType);

    private sealed record MeasurementRow(
        DateTimeOffset Time,
        int DeviceId,
        int SensorId,
        double? ValueDouble,
        long? ValueBigInt,
        bool? ValueBool,
        string? ValueText);

    private enum MeasurementDataType
    {
        Double,
        BigInt,
        Bool,
        Text
    }
}
