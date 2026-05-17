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

            var loadedConfig = new AutomationConfig
            {
                Rules = await LoadRulesAsync(connection)
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

        var clonedRules = rules.Select(CloneRule).ToList();

        await using var connection = await OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        await PersistRulesAsync(connection, transaction, clonedRules);
        await transaction.CommitAsync(cancellationToken);

        lock (_cacheLock)
        {
            _config.Rules = clonedRules;
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
    cooldown_minutes integer NOT NULL DEFAULT 15,
    sort_order integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_automation_rules_source_device_id
    ON automation_rules (source_device_id);
");
    }

    private static async Task<List<AutomationRuleConfig>> LoadRulesAsync(NpgsqlConnection connection)
    {
        var rows = await connection.QueryAsync<AutomationRuleRow>(@"
SELECT id, name, enabled, source_device_id, expression, trigger_type, run_at, time_of_day,
       days_of_week, minute_of_hour, target_device_id, target_parameter_key, raw_value, cooldown_minutes
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
            RunAt = row.run_at,
            TimeOfDay = row.time_of_day,
            DaysOfWeek = row.days_of_week ?? [],
            MinuteOfHour = row.minute_of_hour,
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
    id, name, enabled, source_device_id, expression, trigger_type, run_at, time_of_day,
    days_of_week, minute_of_hour, target_device_id, target_parameter_key, raw_value,
    cooldown_minutes, sort_order, updated_at)
VALUES (
    @Id, @Name, @Enabled, @SourceDeviceId, @Expression, @TriggerType, @RunAt, @TimeOfDay,
    @DaysOfWeek, @MinuteOfHour, @TargetDeviceId, @TargetParameterKey, @RawValue,
    @CooldownMinutes, @SortOrder, NOW())
ON CONFLICT (id)
DO UPDATE SET
    name = EXCLUDED.name,
    enabled = EXCLUDED.enabled,
    source_device_id = EXCLUDED.source_device_id,
    expression = EXCLUDED.expression,
    trigger_type = EXCLUDED.trigger_type,
    run_at = EXCLUDED.run_at,
    time_of_day = EXCLUDED.time_of_day,
    days_of_week = EXCLUDED.days_of_week,
    minute_of_hour = EXCLUDED.minute_of_hour,
    target_device_id = EXCLUDED.target_device_id,
    target_parameter_key = EXCLUDED.target_parameter_key,
    raw_value = EXCLUDED.raw_value,
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
                rule.RunAt,
                rule.TimeOfDay,
                DaysOfWeek = rule.DaysOfWeek.ToArray(),
                rule.MinuteOfHour,
                rule.TargetDeviceId,
                rule.TargetParameterKey,
                RawValue = (long)rule.RawValue,
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
            RunAt = rule.RunAt,
            TimeOfDay = rule.TimeOfDay,
            DaysOfWeek = [.. rule.DaysOfWeek],
            MinuteOfHour = rule.MinuteOfHour,
            TargetDeviceId = rule.TargetDeviceId,
            TargetParameterKey = rule.TargetParameterKey,
            RawValue = rule.RawValue,
            CooldownMinutes = rule.CooldownMinutes
        };

    private sealed class AutomationRuleRow
    {
        public string id { get; init; } = string.Empty;
        public string name { get; init; } = string.Empty;
        public bool enabled { get; init; }
        public string source_device_id { get; init; } = string.Empty;
        public string expression { get; init; } = string.Empty;
        public string trigger_type { get; init; } = "expression";
        public DateTimeOffset? run_at { get; init; }
        public string? time_of_day { get; init; }
        public int[]? days_of_week { get; init; }
        public int? minute_of_hour { get; init; }
        public string target_device_id { get; init; } = string.Empty;
        public string target_parameter_key { get; init; } = string.Empty;
        public long raw_value { get; init; }
        public int cooldown_minutes { get; init; }
    }
}
