using Dapper;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public interface ISoftwareUpdateStore
{
    Task InitializeAsync(CancellationToken cancellationToken);

    Task<SoftwareUpdateState> GetStateAsync(CancellationToken cancellationToken);

    Task SavePreferredChannelAsync(string preferredChannel, CancellationToken cancellationToken);

    Task RecordInstalledReleaseAsync(InstalledSoftwareUpdate installedRelease, CancellationToken cancellationToken);

    Task SyncCurrentBuildAsync(CancellationToken cancellationToken);
}

public sealed record class SoftwareUpdateState
{
    public bool StorageAvailable { get; init; }

    public string PreferredChannel { get; init; } = SoftwareUpdateChannels.Dev;

    public InstalledSoftwareUpdate Installed { get; init; } = new();
}

public sealed record class InstalledSoftwareUpdate
{
    public string? Channel { get; init; }

    public string? ReleaseTag { get; init; }

    public string? SourceRevision { get; init; }

    public string? WorkflowRunNumber { get; init; }

    public string? WorkflowRunAttempt { get; init; }

    public string? BuiltAt { get; init; }

    public DateTimeOffset? PublishedAt { get; init; }

    public string? Checksum { get; init; }
}

public sealed class SoftwareUpdateStore : PostgresStore, ISoftwareUpdateStore
{
    private readonly IBuildMetadataProvider _buildMetadataProvider;
    private readonly string _contentRoot;
    private readonly ILogger<SoftwareUpdateStore> _logger;
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _cacheLock = new();
    private SoftwareUpdateState _state = new();
    private volatile bool _initialized;

    public SoftwareUpdateStore(
        IOptions<MonitorConfiguration> configuration,
        IBuildMetadataProvider buildMetadataProvider,
        IHostEnvironment environment,
        ILogger<SoftwareUpdateStore> logger)
        : base(configuration.Value.Storage.ConnectionString)
    {
        _buildMetadataProvider = buildMetadataProvider;
        _contentRoot = environment.ContentRootPath;
        _logger = logger;
    }

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized)
        {
            return;
        }

        var localChecksum = ReadLocalChecksum();
        if (!HasDatabase)
        {
            lock (_cacheLock)
            {
                _state = CreateDefaultState(storageAvailable: false, _buildMetadataProvider.GetBuildInfo(), localChecksum);
            }

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

            var loadedState = await LoadStateAsync(connection, cancellationToken);
            if (loadedState is null)
            {
                loadedState = CreateDefaultState(storageAvailable: true, _buildMetadataProvider.GetBuildInfo(), localChecksum);
                await PersistStateAsync(connection, loadedState, cancellationToken);
            }

            lock (_cacheLock)
            {
                _state = loadedState with { StorageAvailable = true };
            }

            _initialized = true;
            _logger.LogInformation(
                "Software update state loaded from PostgreSQL. PreferredChannel={PreferredChannel}, InstalledReleaseTag={InstalledReleaseTag}.",
                loadedState.PreferredChannel,
                loadedState.Installed.ReleaseTag ?? "<none>");
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<SoftwareUpdateState> GetStateAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        lock (_cacheLock)
        {
            return Clone(_state);
        }
    }

    public async Task SavePreferredChannelAsync(string preferredChannel, CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Update channel cannot be saved until PostgreSQL storage is configured.");
        }

        var normalizedChannel = SoftwareUpdateChannels.NormalizeSelection(preferredChannel);
        SoftwareUpdateState nextState;

        lock (_cacheLock)
        {
            nextState = Clone(_state) with
            {
                StorageAvailable = true,
                PreferredChannel = normalizedChannel
            };
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await PersistStateAsync(connection, nextState, cancellationToken);

        lock (_cacheLock)
        {
            _state = nextState;
        }
    }

    public async Task RecordInstalledReleaseAsync(InstalledSoftwareUpdate installedRelease, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(installedRelease);

        await InitializeAsync(cancellationToken);

        var normalizedRelease = installedRelease with
        {
            Channel = NormalizeStoredChannel(installedRelease.Channel)
        };

        SoftwareUpdateState nextState;
        lock (_cacheLock)
        {
            nextState = Clone(_state) with
            {
                StorageAvailable = HasDatabase,
                Installed = MergeInstalledRelease(_state.Installed, normalizedRelease)
            };
        }

        if (!HasDatabase)
        {
            lock (_cacheLock)
            {
                _state = nextState;
            }

            return;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await PersistStateAsync(connection, nextState, cancellationToken);

        lock (_cacheLock)
        {
            _state = nextState;
        }
    }

    public async Task SyncCurrentBuildAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        var buildInfo = _buildMetadataProvider.GetBuildInfo();
        var localChecksum = ReadLocalChecksum();

        SoftwareUpdateState nextState;
        lock (_cacheLock)
        {
            nextState = BuildSynchronizedState(_state, buildInfo, localChecksum, HasDatabase);
        }

        if (!HasDatabase)
        {
            lock (_cacheLock)
            {
                _state = nextState;
            }

            return;
        }

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await PersistStateAsync(connection, nextState, cancellationToken);

        lock (_cacheLock)
        {
            _state = nextState;
        }
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS software_update_state (
                id boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
                preferred_channel text NOT NULL DEFAULT 'dev',
                installed_channel text NULL,
                installed_release_tag text NULL,
                installed_source_revision text NULL,
                installed_workflow_run_number text NULL,
                installed_workflow_run_attempt text NULL,
                installed_built_at text NULL,
                installed_published_at timestamptz NULL,
                installed_checksum text NULL,
                updated_at timestamptz NOT NULL DEFAULT NOW()
            );
            """;

        await connection.ExecuteAsync(new CommandDefinition(sql, cancellationToken: cancellationToken));
    }

    private static async Task<SoftwareUpdateState?> LoadStateAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                preferred_channel AS "PreferredChannel",
                installed_channel AS "InstalledChannel",
                installed_release_tag AS "InstalledReleaseTag",
                installed_source_revision AS "InstalledSourceRevision",
                installed_workflow_run_number AS "InstalledWorkflowRunNumber",
                installed_workflow_run_attempt AS "InstalledWorkflowRunAttempt",
                installed_built_at AS "InstalledBuiltAt",
                installed_published_at AS "InstalledPublishedAt",
                installed_checksum AS "InstalledChecksum"
            FROM software_update_state
            WHERE id = TRUE;
            """;

        var row = await connection.QuerySingleOrDefaultAsync<SoftwareUpdateStateRow>(
            new CommandDefinition(sql, cancellationToken: cancellationToken));
        if (row is null)
        {
            return null;
        }

        return new SoftwareUpdateState
        {
            StorageAvailable = true,
            PreferredChannel = NormalizePreferredChannel(row.PreferredChannel, row.InstalledChannel),
            Installed = new InstalledSoftwareUpdate
            {
                Channel = NormalizeStoredChannel(row.InstalledChannel),
                ReleaseTag = NormalizeString(row.InstalledReleaseTag),
                SourceRevision = NormalizeString(row.InstalledSourceRevision),
                WorkflowRunNumber = NormalizeString(row.InstalledWorkflowRunNumber),
                WorkflowRunAttempt = NormalizeString(row.InstalledWorkflowRunAttempt),
                BuiltAt = NormalizeString(row.InstalledBuiltAt),
                PublishedAt = row.InstalledPublishedAt,
                Checksum = NormalizeString(row.InstalledChecksum)
            }
        };
    }

    private static async Task PersistStateAsync(
        NpgsqlConnection connection,
        SoftwareUpdateState state,
        CancellationToken cancellationToken)
    {
        const string sql = """
            INSERT INTO software_update_state (
                id,
                preferred_channel,
                installed_channel,
                installed_release_tag,
                installed_source_revision,
                installed_workflow_run_number,
                installed_workflow_run_attempt,
                installed_built_at,
                installed_published_at,
                installed_checksum,
                updated_at
            )
            VALUES (
                TRUE,
                @PreferredChannel,
                @InstalledChannel,
                @InstalledReleaseTag,
                @InstalledSourceRevision,
                @InstalledWorkflowRunNumber,
                @InstalledWorkflowRunAttempt,
                @InstalledBuiltAt,
                @InstalledPublishedAt,
                @InstalledChecksum,
                NOW()
            )
            ON CONFLICT (id) DO UPDATE
            SET
                preferred_channel = EXCLUDED.preferred_channel,
                installed_channel = EXCLUDED.installed_channel,
                installed_release_tag = EXCLUDED.installed_release_tag,
                installed_source_revision = EXCLUDED.installed_source_revision,
                installed_workflow_run_number = EXCLUDED.installed_workflow_run_number,
                installed_workflow_run_attempt = EXCLUDED.installed_workflow_run_attempt,
                installed_built_at = EXCLUDED.installed_built_at,
                installed_published_at = EXCLUDED.installed_published_at,
                installed_checksum = EXCLUDED.installed_checksum,
                updated_at = NOW();
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new
            {
                state.PreferredChannel,
                InstalledChannel = NormalizeStoredChannel(state.Installed.Channel),
                InstalledReleaseTag = NormalizeString(state.Installed.ReleaseTag),
                InstalledSourceRevision = NormalizeString(state.Installed.SourceRevision),
                InstalledWorkflowRunNumber = NormalizeString(state.Installed.WorkflowRunNumber),
                InstalledWorkflowRunAttempt = NormalizeString(state.Installed.WorkflowRunAttempt),
                InstalledBuiltAt = NormalizeString(state.Installed.BuiltAt),
                InstalledPublishedAt = state.Installed.PublishedAt,
                InstalledChecksum = NormalizeString(state.Installed.Checksum)
            },
            cancellationToken: cancellationToken));
    }

    private SoftwareUpdateState CreateDefaultState(bool storageAvailable, BuildRuntimeInfo buildInfo, string? localChecksum)
    {
        var releaseTag = NormalizeString(buildInfo.ReleaseTag);
        var currentChannel = NormalizeStoredChannel(releaseTag) ?? SoftwareUpdateChannels.Dev;

        return new SoftwareUpdateState
        {
            StorageAvailable = storageAvailable,
            PreferredChannel = currentChannel,
            Installed = new InstalledSoftwareUpdate
            {
                Channel = currentChannel,
                ReleaseTag = releaseTag,
                SourceRevision = NormalizeString(buildInfo.SourceRevisionId),
                WorkflowRunNumber = NormalizeString(buildInfo.WorkflowRunNumber),
                WorkflowRunAttempt = NormalizeString(buildInfo.WorkflowRunAttempt),
                BuiltAt = NormalizeString(buildInfo.BuiltAt),
                PublishedAt = ParseTimestamp(buildInfo.BuiltAt),
                Checksum = NormalizeString(localChecksum)
            }
        };
    }

    private static SoftwareUpdateState BuildSynchronizedState(
        SoftwareUpdateState currentState,
        BuildRuntimeInfo buildInfo,
        string? localChecksum,
        bool storageAvailable)
    {
        if (!HasMeaningfulBuildMetadata(buildInfo) && string.IsNullOrWhiteSpace(localChecksum))
        {
            return currentState with { StorageAvailable = storageAvailable };
        }

        var currentInstalled = currentState.Installed;
        var releaseTag = NormalizeString(buildInfo.ReleaseTag) ?? currentInstalled.ReleaseTag;
        var channel = NormalizeStoredChannel(releaseTag)
            ?? NormalizeStoredChannel(currentInstalled.Channel)
            ?? currentState.PreferredChannel;
        var publishedAt = ResolvePublishedAt(currentInstalled, buildInfo, releaseTag, channel, localChecksum);

        return new SoftwareUpdateState
        {
            StorageAvailable = storageAvailable,
            PreferredChannel = NormalizePreferredChannel(currentState.PreferredChannel, channel),
            Installed = new InstalledSoftwareUpdate
            {
                Channel = channel,
                ReleaseTag = releaseTag,
                SourceRevision = NormalizeString(buildInfo.SourceRevisionId) ?? currentInstalled.SourceRevision,
                WorkflowRunNumber = NormalizeString(buildInfo.WorkflowRunNumber) ?? currentInstalled.WorkflowRunNumber,
                WorkflowRunAttempt = NormalizeString(buildInfo.WorkflowRunAttempt) ?? currentInstalled.WorkflowRunAttempt,
                BuiltAt = NormalizeString(buildInfo.BuiltAt) ?? currentInstalled.BuiltAt,
                PublishedAt = publishedAt,
                Checksum = NormalizeString(localChecksum) ?? currentInstalled.Checksum
            }
        };
    }

    private static InstalledSoftwareUpdate MergeInstalledRelease(
        InstalledSoftwareUpdate currentInstalled,
        InstalledSoftwareUpdate incomingInstalled)
    {
        return new InstalledSoftwareUpdate
        {
            Channel = NormalizeStoredChannel(incomingInstalled.Channel) ?? NormalizeStoredChannel(currentInstalled.Channel),
            ReleaseTag = NormalizeString(incomingInstalled.ReleaseTag) ?? currentInstalled.ReleaseTag,
            SourceRevision = NormalizeString(incomingInstalled.SourceRevision) ?? currentInstalled.SourceRevision,
            WorkflowRunNumber = NormalizeString(incomingInstalled.WorkflowRunNumber) ?? currentInstalled.WorkflowRunNumber,
            WorkflowRunAttempt = NormalizeString(incomingInstalled.WorkflowRunAttempt) ?? currentInstalled.WorkflowRunAttempt,
            BuiltAt = NormalizeString(incomingInstalled.BuiltAt) ?? currentInstalled.BuiltAt,
            PublishedAt = incomingInstalled.PublishedAt ?? currentInstalled.PublishedAt,
            Checksum = NormalizeString(incomingInstalled.Checksum) ?? currentInstalled.Checksum
        };
    }

    private static DateTimeOffset? ResolvePublishedAt(
        InstalledSoftwareUpdate currentInstalled,
        BuildRuntimeInfo buildInfo,
        string? releaseTag,
        string channel,
        string? localChecksum)
    {
        var releaseMatchesStored =
            !string.IsNullOrWhiteSpace(releaseTag)
            && string.Equals(currentInstalled.ReleaseTag, releaseTag, StringComparison.OrdinalIgnoreCase)
            && string.Equals(NormalizeStoredChannel(currentInstalled.Channel), channel, StringComparison.OrdinalIgnoreCase);
        var checksumMatchesStored =
            !string.IsNullOrWhiteSpace(localChecksum)
            && !string.IsNullOrWhiteSpace(currentInstalled.Checksum)
            && string.Equals(currentInstalled.Checksum, localChecksum, StringComparison.OrdinalIgnoreCase);
        var buildMatchesStored =
            string.Equals(currentInstalled.SourceRevision, NormalizeString(buildInfo.SourceRevisionId), StringComparison.OrdinalIgnoreCase)
            && string.Equals(currentInstalled.WorkflowRunNumber, NormalizeString(buildInfo.WorkflowRunNumber), StringComparison.OrdinalIgnoreCase)
            && string.Equals(currentInstalled.WorkflowRunAttempt, NormalizeString(buildInfo.WorkflowRunAttempt), StringComparison.OrdinalIgnoreCase);

        if (currentInstalled.PublishedAt is not null && releaseMatchesStored && (checksumMatchesStored || buildMatchesStored))
        {
            return currentInstalled.PublishedAt;
        }

        return ParseTimestamp(buildInfo.BuiltAt) ?? currentInstalled.PublishedAt;
    }

    private string? ReadLocalChecksum()
    {
        var installRoot = Directory.GetParent(_contentRoot)?.FullName ?? _contentRoot;
        var releaseInfoPath = Path.Combine(installRoot, "release-info.env");
        if (!File.Exists(releaseInfoPath))
        {
            return null;
        }

        foreach (var line in File.ReadLines(releaseInfoPath))
        {
            const string prefix = "FLUXMONITOR_RELEASE_SHA256=";
            if (!line.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return NormalizeString(line[prefix.Length..].Trim().Trim('"', '\''));
        }

        return null;
    }

    private static SoftwareUpdateState Clone(SoftwareUpdateState state)
    {
        return new SoftwareUpdateState
        {
            StorageAvailable = state.StorageAvailable,
            PreferredChannel = state.PreferredChannel,
            Installed = state.Installed with { }
        };
    }

    private static string NormalizePreferredChannel(string? preferredChannel, string? fallbackChannel)
    {
        var normalizedPreferredChannel = NormalizeString(preferredChannel);
        if (normalizedPreferredChannel is not null)
        {
            return SoftwareUpdateChannels.NormalizeSelection(normalizedPreferredChannel);
        }

        var normalizedFallbackChannel = NormalizeStoredChannel(fallbackChannel);
        return normalizedFallbackChannel ?? SoftwareUpdateChannels.Dev;
    }

    private static string? NormalizeStoredChannel(string? channel)
    {
        var normalized = NormalizeString(channel);
        return normalized is null
            ? null
            : SoftwareUpdateChannels.FromReleaseTag(normalized);
    }

    private static string? NormalizeString(string? value)
    {
        var normalized = value?.Trim();
        return string.IsNullOrWhiteSpace(normalized) ? null : normalized;
    }

    private static DateTimeOffset? ParseTimestamp(string? value)
    {
        return DateTimeOffset.TryParse(value, out var parsed)
            ? parsed
            : null;
    }

    private static bool HasMeaningfulBuildMetadata(BuildRuntimeInfo buildInfo)
    {
        return !string.IsNullOrWhiteSpace(buildInfo.ReleaseTag)
            || !string.IsNullOrWhiteSpace(buildInfo.SourceRevisionId)
            || !string.IsNullOrWhiteSpace(buildInfo.WorkflowRunNumber)
            || !string.IsNullOrWhiteSpace(buildInfo.WorkflowRunAttempt)
            || !string.IsNullOrWhiteSpace(buildInfo.BuiltAt);
    }

    private sealed class SoftwareUpdateStateRow
    {
        public string? PreferredChannel { get; init; }

        public string? InstalledChannel { get; init; }

        public string? InstalledReleaseTag { get; init; }

        public string? InstalledSourceRevision { get; init; }

        public string? InstalledWorkflowRunNumber { get; init; }

        public string? InstalledWorkflowRunAttempt { get; init; }

        public string? InstalledBuiltAt { get; init; }

        public DateTimeOffset? InstalledPublishedAt { get; init; }

        public string? InstalledChecksum { get; init; }
    }
}
