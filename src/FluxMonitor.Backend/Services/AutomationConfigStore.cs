using System.Text.Json;
using Dapper;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class AutomationConfigStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<AutomationConfigStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _cacheLock = new();
    private AutomationConfig _config = new();
    private volatile bool _initialized;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized)
            return;

        if (!HasDatabase)
        {
            logger.LogError("PostgreSQL storage is not configured. Automation configuration is unavailable until setup is completed.");
            _initialized = true;
            return;
        }

        await _initializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_initialized)
                return;

            await using var connection = await OpenConnectionAsync(cancellationToken);
            await EnsureSchemaAsync(connection);

            var loadedRules = await LoadRulesAsync(connection);
            var normalizedRules = NormalizeRuleIds(loadedRules, out var normalizedIdCount);

            if (normalizedIdCount > 0)
            {
                await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
                await PersistRulesAsync(connection, transaction, normalizedRules);
                await transaction.CommitAsync(cancellationToken);
                logger.LogInformation("Normalized {RuleCount} automation rule ids to GUIDs while loading configuration.", normalizedIdCount);
            }

            var loadedConfig = new AutomationConfig
            {
                Rules = normalizedRules
            };

            lock (_cacheLock)
            {
                _config = loadedConfig;
            }

            _initialized = true;
            logger.LogInformation("Loaded automation config from PostgreSQL ({RuleCount} rules).", loadedConfig.Rules.Count);
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public AutomationConfig GetConfig()
    {
        EnsureInitialized();

        lock (_cacheLock)
        {
            return new AutomationConfig
            {
                Rules = _config.Rules.Select(CloneRule).ToList()
            };
        }
    }

    public IReadOnlyList<AutomationRuleConfig> GetRules()
    {
        EnsureInitialized();

        lock (_cacheLock)
        {
            return [.. _config.Rules.Select(CloneRule)];
        }
    }

    public async Task SaveRulesAsync(IReadOnlyList<AutomationRuleConfig> rules, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(rules);

        await InitializeAsync(cancellationToken);
        if (!HasDatabase)
            throw new InvalidOperationException("Automation rules cannot be saved until PostgreSQL storage is configured.");

        var clonedRules = NormalizeRuleIds(rules.Select(CloneRule).ToList(), out var normalizedIdCount);

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await PersistRulesAsync(connection, transaction, clonedRules);
        await transaction.CommitAsync(cancellationToken);

        lock (_cacheLock)
        {
            _config.Rules = clonedRules;
        }

        if (normalizedIdCount > 0)
        {
            logger.LogInformation("Normalized {RuleCount} automation rule ids to GUIDs while saving configuration.", normalizedIdCount);
        }

        logger.LogInformation("Saved {RuleCount} automation rules to PostgreSQL.", clonedRules.Count);
    }

    private void EnsureInitialized()
    {
        if (_initialized)
            return;

        InitializeAsync(CancellationToken.None).GetAwaiter().GetResult();
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection)
    {
        await connection.ExecuteAsync(@"
CREATE TABLE IF NOT EXISTS automation_rules (
    id text PRIMARY KEY,
    name text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    source_device_id text NOT NULL DEFAULT '',
    expression text NOT NULL DEFAULT '',
    trigger_type text NOT NULL DEFAULT 'expression',
    run_at timestamptz NULL,
    time_of_day text NULL,
    days_of_week integer[] NOT NULL DEFAULT '{}',
    minute_of_hour integer NULL,
    target_device_id text NOT NULL,
    target_parameter_key text NOT NULL,
    raw_value bigint NOT NULL DEFAULT 0,
    actions jsonb NOT NULL DEFAULT '[]'::jsonb,
    cooldown_minutes integer NOT NULL DEFAULT 15,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_automation_rules_source_device_id
    ON automation_rules (source_device_id);
DO $$ BEGIN
  ALTER TABLE automation_rules ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb;
END $$;
");
    }

    private static async Task<List<AutomationRuleConfig>> LoadRulesAsync(NpgsqlConnection connection)
    {
        var rows = await connection.QueryAsync<AutomationRuleRow>(@"
SELECT id, name, enabled, source_device_id, expression, trigger_type,
       target_device_id, target_parameter_key, raw_value, actions::text AS actions, cooldown_minutes
FROM automation_rules
ORDER BY sort_order, id;
");

        return rows.Select(row => new AutomationRuleConfig
        {
            Id = row.id,
            Name = row.name,
            Enabled = row.enabled,
            SourceDeviceId = row.source_device_id,
            Expression = row.expression,
            TriggerType = row.trigger_type,
            Actions = LoadActions(row.actions, row.target_device_id, row.target_parameter_key, row.raw_value),
            TargetDeviceId = row.target_device_id,
            TargetParameterKey = row.target_parameter_key,
            RawValue = Convert.ToUInt32(row.raw_value),
            CooldownMinutes = row.cooldown_minutes
        }).ToList();
    }

    private static async Task PersistRulesAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        IReadOnlyList<AutomationRuleConfig> rules)
    {
        if (rules.Count == 0)
        {
            await connection.ExecuteAsync("DELETE FROM automation_rules;", transaction: transaction);
            return;
        }

        await connection.ExecuteAsync(
            "DELETE FROM automation_rules WHERE NOT (id = ANY(@Ids));",
            new { Ids = rules.Select(rule => rule.Id).ToArray() },
            transaction);

        for (var index = 0; index < rules.Count; index++)
        {
            var rule = rules[index];
            await connection.ExecuteAsync(@"
INSERT INTO automation_rules (
    id, name, enabled, source_device_id, expression, trigger_type,
    target_device_id, target_parameter_key, raw_value, actions,
    cooldown_minutes, sort_order, updated_at)
VALUES (
    @Id, @Name, @Enabled, @SourceDeviceId, @Expression, @TriggerType,
    @TargetDeviceId, @TargetParameterKey, @RawValue, CAST(@Actions AS jsonb),
    @CooldownMinutes, @SortOrder, NOW())
ON CONFLICT (id)
DO UPDATE SET
    name = EXCLUDED.name,
    enabled = EXCLUDED.enabled,
    source_device_id = EXCLUDED.source_device_id,
    expression = EXCLUDED.expression,
    trigger_type = EXCLUDED.trigger_type,
    target_device_id = EXCLUDED.target_device_id,
    target_parameter_key = EXCLUDED.target_parameter_key,
    raw_value = EXCLUDED.raw_value,
    actions = EXCLUDED.actions,
    cooldown_minutes = EXCLUDED.cooldown_minutes,
    sort_order = EXCLUDED.sort_order,
    updated_at = NOW();
", new
            {
                rule.Id,
                rule.Name,
                rule.Enabled,
                rule.SourceDeviceId,
                rule.Expression,
                rule.TriggerType,
                rule.TargetDeviceId,
                rule.TargetParameterKey,
                RawValue = (long)rule.RawValue,
                Actions = JsonSerializer.Serialize(AutomationRuleValidator.NormalizeActions(rule), JsonOptions),
                rule.CooldownMinutes,
                SortOrder = index
            }, transaction);
        }
    }

    private static AutomationRuleConfig CloneRule(AutomationRuleConfig rule)
        => new()
        {
            Id = rule.Id,
            Name = rule.Name,
            Enabled = rule.Enabled,
            SourceDeviceId = rule.SourceDeviceId,
            Expression = rule.Expression,
            TriggerType = rule.TriggerType,
            Actions = [.. AutomationRuleValidator.NormalizeActions(rule).Select(CloneAction)],
            TargetDeviceId = rule.TargetDeviceId,
            TargetParameterKey = rule.TargetParameterKey,
            RawValue = rule.RawValue,
            CooldownMinutes = rule.CooldownMinutes
        };

    internal static List<AutomationRuleConfig> NormalizeRuleIds(
        IReadOnlyList<AutomationRuleConfig> rules,
        out int normalizedIdCount)
    {
        normalizedIdCount = 0;

        var usedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var normalizedRules = new List<AutomationRuleConfig>(rules.Count);

        foreach (var rule in rules)
        {
            var normalizedId = NormalizeRuleId(rule.Id, usedIds);
            if (!string.Equals(rule.Id, normalizedId, StringComparison.Ordinal))
            {
                normalizedIdCount++;
            }

            normalizedRules.Add(string.Equals(rule.Id, normalizedId, StringComparison.Ordinal)
                ? CloneRule(rule)
                : CloneRule(rule, normalizedId));
        }

        return normalizedRules;
    }

    private static AutomationRuleConfig CloneRule(AutomationRuleConfig rule, string id)
        => new()
        {
            Id = id,
            Name = rule.Name,
            Enabled = rule.Enabled,
            SourceDeviceId = rule.SourceDeviceId,
            Expression = rule.Expression,
            TriggerType = rule.TriggerType,
            Actions = [.. AutomationRuleValidator.NormalizeActions(rule).Select(CloneAction)],
            TargetDeviceId = rule.TargetDeviceId,
            TargetParameterKey = rule.TargetParameterKey,
            RawValue = rule.RawValue,
            CooldownMinutes = rule.CooldownMinutes
        };

    private static AutomationActionConfig CloneAction(AutomationActionConfig action)
        => new()
        {
            TargetDeviceId = action.TargetDeviceId,
            TargetParameterKey = action.TargetParameterKey,
            RawValue = action.RawValue
        };

    private static string NormalizeRuleId(string? id, HashSet<string> usedIds)
    {
        var candidate = id?.Trim();
        if (Guid.TryParse(candidate, out var guid))
        {
            var normalizedGuid = guid.ToString();
            if (usedIds.Add(normalizedGuid))
            {
                return normalizedGuid;
            }
        }

        string generatedGuid;
        do
        {
            generatedGuid = Guid.NewGuid().ToString();
        }
        while (!usedIds.Add(generatedGuid));

        return generatedGuid;
    }

    private static IReadOnlyList<AutomationActionConfig> LoadActions(
        string? json,
        string targetDeviceId,
        string targetParameterKey,
        long rawValue)
    {
        var actions = string.IsNullOrWhiteSpace(json)
            ? []
            : JsonSerializer.Deserialize<List<AutomationActionConfig>>(json, JsonOptions) ?? [];

        if (actions.Count > 0)
            return actions;

        if (string.IsNullOrWhiteSpace(targetDeviceId) && string.IsNullOrWhiteSpace(targetParameterKey))
            return [];

        return
        [
            new AutomationActionConfig
            {
                TargetDeviceId = targetDeviceId,
                TargetParameterKey = targetParameterKey,
                RawValue = Convert.ToUInt32(rawValue)
            }
        ];
    }

    private sealed class AutomationRuleRow
    {
        public string id { get; init; } = string.Empty;
        public string name { get; init; } = string.Empty;
        public bool enabled { get; init; }
        public string source_device_id { get; init; } = string.Empty;
        public string expression { get; init; } = string.Empty;
        public string trigger_type { get; init; } = "expression";
        public string target_device_id { get; init; } = string.Empty;
        public string target_parameter_key { get; init; } = string.Empty;
        public long raw_value { get; init; }
        public string actions { get; init; } = "[]";
        public int cooldown_minutes { get; init; }
    }
}
