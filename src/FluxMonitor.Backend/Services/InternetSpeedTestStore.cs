using Dapper;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public interface IInternetSpeedTestStore
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task<StoredInternetSpeedTestRun?> GetLatestResultAsync(CancellationToken cancellationToken);

    Task SaveResultAsync(
        InternetSpeedTestResult result,
        DateTimeOffset? startedAt,
        DateTimeOffset? completedAt,
        CancellationToken cancellationToken);
}

public sealed record class StoredInternetSpeedTestRun
{
    public DateTimeOffset? StartedAt { get; init; }

    public DateTimeOffset? CompletedAt { get; init; }

    public required InternetSpeedTestResult Result { get; init; }
}

public sealed class InternetSpeedTestStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<InternetSpeedTestStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString), IInternetSpeedTestStore
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
            logger.LogInformation("Internet speed test storage is ready.");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<StoredInternetSpeedTestRun?> GetLatestResultAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);
        if (!HasDatabase)
        {
            return null;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            SELECT
                started_at AS "StartedAt",
                completed_at AS "CompletedAt",
                tested_at AS "TestedAt",
                download_bits_per_second AS "DownloadBitsPerSecond",
                upload_bits_per_second AS "UploadBitsPerSecond",
                ping_milliseconds AS "PingMilliseconds",
                bytes_received AS "BytesReceived",
                bytes_sent AS "BytesSent",
                share_url AS "ShareUrl",
                server_id AS "ServerId",
                server_sponsor AS "ServerSponsor",
                server_name AS "ServerName",
                server_country AS "ServerCountry",
                server_distance_kilometers AS "ServerDistanceKilometers",
                server_latency_milliseconds AS "ServerLatencyMilliseconds",
                client_ip_address AS "ClientIpAddress",
                client_internet_service_provider AS "ClientInternetServiceProvider",
                client_country AS "ClientCountry"
            FROM internet_speed_tests
            ORDER BY tested_at DESC, id DESC
            LIMIT 1;
            """;

        var row = await connection.QuerySingleOrDefaultAsync<StoredInternetSpeedTestRow>(
            new CommandDefinition(sql, cancellationToken: cancellationToken));

        return row is null
            ? null
            : new StoredInternetSpeedTestRun
            {
                StartedAt = row.StartedAt,
                CompletedAt = row.CompletedAt,
                Result = new InternetSpeedTestResult
                {
                    DownloadBitsPerSecond = row.DownloadBitsPerSecond,
                    UploadBitsPerSecond = row.UploadBitsPerSecond,
                    PingMilliseconds = row.PingMilliseconds,
                    BytesReceived = row.BytesReceived,
                    BytesSent = row.BytesSent,
                    TestedAt = row.TestedAt,
                    ShareUrl = row.ShareUrl,
                    Server = new InternetSpeedTestServerSnapshot
                    {
                        Id = row.ServerId,
                        Sponsor = row.ServerSponsor,
                        Name = row.ServerName,
                        Country = row.ServerCountry,
                        DistanceKilometers = row.ServerDistanceKilometers,
                        LatencyMilliseconds = row.ServerLatencyMilliseconds
                    },
                    Client = new InternetSpeedTestClientSnapshot
                    {
                        IpAddress = row.ClientIpAddress,
                        InternetServiceProvider = row.ClientInternetServiceProvider,
                        Country = row.ClientCountry
                    }
                }
            };
    }

    public async Task SaveResultAsync(
        InternetSpeedTestResult result,
        DateTimeOffset? startedAt,
        DateTimeOffset? completedAt,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(result);

        await InitializeAsync(cancellationToken);
        if (!HasDatabase)
        {
            return;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            INSERT INTO internet_speed_tests (
                tested_at,
                started_at,
                completed_at,
                download_bits_per_second,
                upload_bits_per_second,
                ping_milliseconds,
                bytes_received,
                bytes_sent,
                share_url,
                server_id,
                server_sponsor,
                server_name,
                server_country,
                server_distance_kilometers,
                server_latency_milliseconds,
                client_ip_address,
                client_internet_service_provider,
                client_country
            )
            VALUES (
                @TestedAt,
                @StartedAt,
                @CompletedAt,
                @DownloadBitsPerSecond,
                @UploadBitsPerSecond,
                @PingMilliseconds,
                @BytesReceived,
                @BytesSent,
                @ShareUrl,
                @ServerId,
                @ServerSponsor,
                @ServerName,
                @ServerCountry,
                @ServerDistanceKilometers,
                @ServerLatencyMilliseconds,
                @ClientIpAddress,
                @ClientInternetServiceProvider,
                @ClientCountry
            );
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new
            {
                TestedAt = result.TestedAt ?? completedAt ?? DateTimeOffset.UtcNow,
                StartedAt = startedAt,
                CompletedAt = completedAt,
                result.DownloadBitsPerSecond,
                result.UploadBitsPerSecond,
                result.PingMilliseconds,
                result.BytesReceived,
                result.BytesSent,
                result.ShareUrl,
                ServerId = result.Server?.Id,
                ServerSponsor = result.Server?.Sponsor,
                ServerName = result.Server?.Name,
                ServerCountry = result.Server?.Country,
                ServerDistanceKilometers = result.Server?.DistanceKilometers,
                ServerLatencyMilliseconds = result.Server?.LatencyMilliseconds,
                ClientIpAddress = result.Client?.IpAddress,
                ClientInternetServiceProvider = result.Client?.InternetServiceProvider,
                ClientCountry = result.Client?.Country
            },
            cancellationToken: cancellationToken));
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS internet_speed_tests (
                id bigserial PRIMARY KEY,
                tested_at timestamptz NOT NULL,
                started_at timestamptz NULL,
                completed_at timestamptz NULL,
                download_bits_per_second double precision NULL,
                upload_bits_per_second double precision NULL,
                ping_milliseconds double precision NULL,
                bytes_received bigint NULL,
                bytes_sent bigint NULL,
                share_url text NULL,
                server_id text NULL,
                server_sponsor text NULL,
                server_name text NULL,
                server_country text NULL,
                server_distance_kilometers double precision NULL,
                server_latency_milliseconds double precision NULL,
                client_ip_address text NULL,
                client_internet_service_provider text NULL,
                client_country text NULL,
                created_at timestamptz NOT NULL DEFAULT NOW()
            );

            CREATE INDEX IF NOT EXISTS ix_internet_speed_tests_tested_at
                ON internet_speed_tests (tested_at DESC, id DESC);
            """;

        await connection.ExecuteAsync(new CommandDefinition(sql, cancellationToken: cancellationToken));
    }

    private sealed class StoredInternetSpeedTestRow
    {
        public DateTimeOffset? StartedAt { get; init; }

        public DateTimeOffset? CompletedAt { get; init; }

        public DateTimeOffset? TestedAt { get; init; }

        public double? DownloadBitsPerSecond { get; init; }

        public double? UploadBitsPerSecond { get; init; }

        public double? PingMilliseconds { get; init; }

        public long? BytesReceived { get; init; }

        public long? BytesSent { get; init; }

        public string? ShareUrl { get; init; }

        public string? ServerId { get; init; }

        public string? ServerSponsor { get; init; }

        public string? ServerName { get; init; }

        public string? ServerCountry { get; init; }

        public double? ServerDistanceKilometers { get; init; }

        public double? ServerLatencyMilliseconds { get; init; }

        public string? ClientIpAddress { get; init; }

        public string? ClientInternetServiceProvider { get; init; }

        public string? ClientCountry { get; init; }
    }
}
