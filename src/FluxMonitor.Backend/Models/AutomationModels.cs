namespace FluxMonitor.Backend.Models;

public sealed class AutomationConfig
{
    public List<AutomationRuleConfig> Rules { get; set; } = [];
}

public sealed class AutomationRuleConfig
{
    public required string Id { get; init; }

    public required string Name { get; init; }

    public bool Enabled { get; init; } = true;

    public string Expression { get; init; } = string.Empty;

    public IReadOnlyList<AutomationActionConfig> Actions { get; init; } = [];

    public int CooldownMinutes { get; init; } = 15;

    public string SourceDeviceId { get; init; } = string.Empty;

    public string TriggerType { get; init; } = "expression";

    public string TargetDeviceId { get; init; } = string.Empty;

    public string TargetParameterKey { get; init; } = string.Empty;

    public uint RawValue { get; init; }
}

public sealed class AutomationActionConfig
{
    public required string TargetDeviceId { get; init; }

    public required string TargetParameterKey { get; init; }

    public uint RawValue { get; init; }
}

public sealed class SaveAutomationRulesRequest
{
    public List<AutomationRuleConfig> Rules { get; init; } = [];
}

public sealed class AutomationConfigResponse
{
    public required IReadOnlyList<AutomationRuleConfig> Rules { get; init; }
}

public sealed class AutomationLogEntry
{
    public required string RuleId { get; init; }

    public required string RuleName { get; init; }

    public required DateTimeOffset FiredAt { get; init; }

    public required bool ConditionMatched { get; init; }

    public string TriggerType { get; init; } = "expression";

    public string SourceDeviceId { get; init; } = string.Empty;

    public string TargetDeviceId { get; init; } = string.Empty;

    public string TargetParameterKey { get; init; } = string.Empty;

    public uint RawValue { get; init; }

    public required bool Success { get; init; }

    public required string Message { get; init; }

    public IReadOnlyList<AutomationActionLogEntry> ActionResults { get; init; } = [];
}

public sealed class AutomationActionLogEntry
{
    public required string TargetDeviceId { get; init; }

    public required string TargetParameterKey { get; init; }

    public required uint RawValue { get; init; }

    public required bool Success { get; init; }

    public required string Message { get; init; }
}

public sealed class TestAutomationRuleRequest
{
    public required AutomationRuleConfig Rule { get; init; }
}

public sealed class TestAutomationRuleResponse
{
    public required bool ConditionMatched { get; init; }

    public required string Message { get; init; }

    public IReadOnlyList<AutomationActionLogEntry> ActionResults { get; init; } = [];
}

public sealed record AutomationDeviceOption(
    string Id,
    string Name,
    IReadOnlyList<AutomationParameterOption> Parameters,
    IReadOnlyList<AutomationParameterOption> WritableParameters);

public sealed record AutomationParameterOption(
    string Id,
    string Name,
    string Category,
    string Unit,
    bool IsWritable,
    decimal? NumericValue,
    string? StringValue,
    bool? BooleanValue,
    long? RawValue,
    IReadOnlyList<AutomationSelectOption> Options);

public sealed record AutomationSelectOption(long Value, string Label);
