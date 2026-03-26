using System.Text.Json;
using System.Text.Json.Serialization;
using Dapper;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class NotificationConfigStore(
    IOptions<MonitorConfiguration> configuration,
    IHostEnvironment environment,
    ILogger<NotificationConfigStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _legacyFilePath = Path.Combine(environment.ContentRootPath, "notifications.json");
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _cacheLock = new();
    private NotificationConfig _config = new();
    private volatile bool _initialized;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized)
        {
            return;
        }

        if (!HasDatabase)
        {
            logger.LogWarning("No database connection string configured — notification storage is disabled.");
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
            await ImportLegacyConfigIfNeededAsync(connection, cancellationToken);

            var loadedConfig = await LoadConfigAsync(connection, cancellationToken);
            lock (_cacheLock)
            {
                _config = loadedConfig;
            }

            _initialized = true;
            logger.LogInformation(
                "Loaded notification config from PostgreSQL ({ChannelCount} channels, {RuleCount} rules).",
                loadedConfig.Channels.Count,
                loadedConfig.Rules.Count);
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public NotificationConfig GetConfig()
    {
        EnsureInitialized();

        lock (_cacheLock)
        {
            return CloneConfig(_config);
        }
    }

    public IReadOnlyList<NotificationChannelConfig> GetChannels()
    {
        EnsureInitialized();

        lock (_cacheLock)
        {
            return [.. _config.Channels.Select(CloneChannel)];
        }
    }

    public IReadOnlyList<NotificationRuleConfig> GetRules()
    {
        EnsureInitialized();

        lock (_cacheLock)
        {
            return [.. _config.Rules.Select(CloneRule)];
        }
    }

    public NotificationChannelConfig? GetChannel(string id)
    {
        EnsureInitialized();

        lock (_cacheLock)
        {
            var channel = _config.Channels.Find(c => string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
            return channel is null ? null : CloneChannel(channel);
        }
    }

    public async Task SaveChannelsAsync(IReadOnlyList<NotificationChannelConfig> channels, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(channels);

        await InitializeAsync(cancellationToken);

        var clonedChannels = channels.Select(CloneChannel).ToList();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await PersistChannelsAsync(connection, transaction, clonedChannels, cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        lock (_cacheLock)
        {
            _config.Channels = clonedChannels;
        }

        logger.LogInformation("Saved {ChannelCount} notification channels to PostgreSQL.", clonedChannels.Count);
    }

    public async Task SaveRulesAsync(IReadOnlyList<NotificationRuleConfig> rules, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rules);

        await InitializeAsync(cancellationToken);

        var clonedRules = rules.Select(CloneRule).ToList();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await PersistRulesAsync(connection, transaction, clonedRules, cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        lock (_cacheLock)
        {
            _config.Rules = clonedRules;
        }

        logger.LogInformation("Saved {RuleCount} notification rules to PostgreSQL.", clonedRules.Count);
    }

    internal static NotificationConfig? LoadLegacyConfigFromFile(string filePath)
    {
        if (!File.Exists(filePath))
        {
            return null;
        }

        var json = File.ReadAllText(filePath);
        if (string.IsNullOrWhiteSpace(json))
        {
            return null;
        }

        return JsonSerializer.Deserialize<NotificationConfig>(json, JsonOptions);
    }

    private void EnsureInitialized()
    {
        if (_initialized)
        {
            return;
        }

        InitializeAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    private async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        await connection.ExecuteAsync(@"
CREATE TABLE IF NOT EXISTS notification_channels (
    id text PRIMARY KEY,
    type text NOT NULL,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_rules (
    id text PRIMARY KEY,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    device_id text NOT NULL,
    entity_id text NOT NULL,
    expression text NOT NULL,
    channel_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    message_template text NOT NULL,
    severity text NOT NULL DEFAULT 'info',
    cooldown_minutes integer NOT NULL DEFAULT 15,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_notification_rules_device_id
    ON notification_rules (device_id);
");

        await connection.ExecuteAsync(@"
DO $$ BEGIN
  ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
  ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
END $$;
");
    }

    private async Task ImportLegacyConfigIfNeededAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        if (!File.Exists(_legacyFilePath))
        {
            return;
        }

        if (await HasStoredConfigAsync(connection, cancellationToken))
        {
            return;
        }

        NotificationConfig? legacyConfig;
        try
        {
            legacyConfig = LoadLegacyConfigFromFile(_legacyFilePath);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to read legacy notification config from {Path}.", _legacyFilePath);
            return;
        }

        if (legacyConfig is null || (legacyConfig.Channels.Count == 0 && legacyConfig.Rules.Count == 0))
        {
            return;
        }

        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await PersistChannelsAsync(connection, transaction, legacyConfig.Channels.Select(CloneChannel).ToList(), cancellationToken);
        await PersistRulesAsync(connection, transaction, legacyConfig.Rules.Select(CloneRule).ToList(), cancellationToken);
        await transaction.CommitAsync(cancellationToken);

        ArchiveLegacyFile();
        logger.LogInformation(
            "Imported legacy notification config from {Path} into PostgreSQL ({ChannelCount} channels, {RuleCount} rules).",
            _legacyFilePath,
            legacyConfig.Channels.Count,
            legacyConfig.Rules.Count);
    }

    private void ArchiveLegacyFile()
    {
        try
        {
            var archivedPath = _legacyFilePath + ".migrated";
            File.Move(_legacyFilePath, archivedPath, overwrite: true);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to archive legacy notification config at {Path} after PostgreSQL import.", _legacyFilePath);
        }
    }

    private static async Task<bool> HasStoredConfigAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        var result = await connection.ExecuteScalarAsync<bool>(@"
SELECT EXISTS (SELECT 1 FROM notification_channels)
    OR EXISTS (SELECT 1 FROM notification_rules);
");
        return result;
    }

    private static async Task<NotificationConfig> LoadConfigAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        var channels = await LoadChannelsAsync(connection);
        var rules = await LoadRulesAsync(connection);

        return new NotificationConfig
        {
            Channels = channels,
            Rules = rules
        };
    }

    private static async Task<List<NotificationChannelConfig>> LoadChannelsAsync(NpgsqlConnection connection)
    {
        var rows = await connection.QueryAsync<(string id, string type, string name, bool enabled, string settings)>(@"
SELECT id, type, name, enabled, settings::text
FROM notification_channels
ORDER BY sort_order, id;
");

        return rows.Select(r => new NotificationChannelConfig
        {
            Id = r.id,
            Type = r.type,
            Name = r.name,
            Enabled = r.enabled,
            Settings = DeserializeDictionary(r.settings ?? "{}")
        }).ToList();
    }

    private static async Task<List<NotificationRuleConfig>> LoadRulesAsync(NpgsqlConnection connection)
    {
        var rows = await connection.QueryAsync<(string id, string name, bool enabled, string device_id, string entity_id, string expression, string channel_ids, string message_template, string severity, int cooldown_minutes)>(@"
SELECT id, name, enabled, device_id, entity_id, expression, channel_ids::text, message_template, severity, cooldown_minutes
FROM notification_rules
ORDER BY sort_order, id;
");

        return rows.Select(r => new NotificationRuleConfig
        {
            Id = r.id,
            Name = r.name,
            Enabled = r.enabled,
            DeviceId = r.device_id,
            EntityId = r.entity_id,
            Expression = r.expression,
            ChannelIds = DeserializeStringList(r.channel_ids ?? "[]"),
            MessageTemplate = r.message_template,
            Severity = r.severity,
            CooldownMinutes = r.cooldown_minutes
        }).ToList();
    }

    private static async Task PersistChannelsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        IReadOnlyList<NotificationChannelConfig> channels,
        CancellationToken cancellationToken)
    {
        await DeleteMissingRowsAsync(connection, transaction, "notification_channels", channels.Select(c => c.Id).ToArray());

        for (var index = 0; index < channels.Count; index++)
        {
            var channel = channels[index];
            await connection.ExecuteAsync(@"
INSERT INTO notification_channels (id, type, name, enabled, settings, sort_order, updated_at)
VALUES (@Id, @Type, @Name, @Enabled, @Settings::jsonb, @SortOrder, NOW())
ON CONFLICT (id)
DO UPDATE SET
    type = EXCLUDED.type,
    name = EXCLUDED.name,
    enabled = EXCLUDED.enabled,
    settings = EXCLUDED.settings,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();
", new
            {
                channel.Id,
                channel.Type,
                channel.Name,
                channel.Enabled,
                Settings = JsonSerializer.Serialize(channel.Settings, JsonOptions),
                SortOrder = index
            }, transaction);
        }
    }

    private static async Task PersistRulesAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        IReadOnlyList<NotificationRuleConfig> rules,
        CancellationToken cancellationToken)
    {
        await DeleteMissingRowsAsync(connection, transaction, "notification_rules", rules.Select(r => r.Id).ToArray());

        for (var index = 0; index < rules.Count; index++)
        {
            var rule = rules[index];
            await connection.ExecuteAsync(@"
INSERT INTO notification_rules (
    id, name, enabled, device_id, entity_id, expression, channel_ids,
    message_template, severity, cooldown_minutes, sort_order, updated_at)
VALUES (
    @Id, @Name, @Enabled, @DeviceId, @EntityId, @Expression, @ChannelIds::jsonb,
    @MessageTemplate, @Severity, @CooldownMinutes, @SortOrder, NOW())
ON CONFLICT (id)
DO UPDATE SET
    name = EXCLUDED.name,
    enabled = EXCLUDED.enabled,
    device_id = EXCLUDED.device_id,
    entity_id = EXCLUDED.entity_id,
    expression = EXCLUDED.expression,
    channel_ids = EXCLUDED.channel_ids,
    message_template = EXCLUDED.message_template,
    severity = EXCLUDED.severity,
    cooldown_minutes = EXCLUDED.cooldown_minutes,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();
", new
            {
                rule.Id,
                rule.Name,
                rule.Enabled,
                rule.DeviceId,
                rule.EntityId,
                rule.Expression,
                ChannelIds = JsonSerializer.Serialize(rule.ChannelIds, JsonOptions),
                rule.MessageTemplate,
                rule.Severity,
                rule.CooldownMinutes,
                SortOrder = index
            }, transaction);
        }
    }

    private static async Task DeleteMissingRowsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string tableName,
        string[] ids)
    {
        if (ids.Length == 0)
        {
            await connection.ExecuteAsync($"DELETE FROM {tableName};", transaction: transaction);
        }
        else
        {
            await connection.ExecuteAsync($"DELETE FROM {tableName} WHERE NOT (id = ANY(@Ids));", new { Ids = ids }, transaction);
        }
    }

    private static NotificationConfig CloneConfig(NotificationConfig config)
    {
        return new NotificationConfig
        {
            Channels = config.Channels.Select(CloneChannel).ToList(),
            Rules = config.Rules.Select(CloneRule).ToList()
        };
    }

    private static NotificationChannelConfig CloneChannel(NotificationChannelConfig channel)
    {
        return new NotificationChannelConfig
        {
            Id = channel.Id,
            Type = channel.Type,
            Name = channel.Name,
            Enabled = channel.Enabled,
            Settings = channel.Settings.ToDictionary(entry => entry.Key, entry => entry.Value)
        };
    }

    private static NotificationRuleConfig CloneRule(NotificationRuleConfig rule)
    {
        return new NotificationRuleConfig
        {
            Id = rule.Id,
            Name = rule.Name,
            Enabled = rule.Enabled,
            DeviceId = rule.DeviceId,
            EntityId = rule.EntityId,
            Expression = rule.Expression,
            ChannelIds = [.. rule.ChannelIds],
            MessageTemplate = rule.MessageTemplate,
            Severity = rule.Severity,
            CooldownMinutes = rule.CooldownMinutes
        };
    }

    private static Dictionary<string, object?> DeserializeDictionary(string json)
        => JsonSerializer.Deserialize<Dictionary<string, object?>>(json, JsonOptions) ?? [];

    private static List<string> DeserializeStringList(string json)
        => JsonSerializer.Deserialize<List<string>>(json, JsonOptions) ?? [];
}
