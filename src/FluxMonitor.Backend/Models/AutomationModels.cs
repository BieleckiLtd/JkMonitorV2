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

    public string SourceDeviceId { get; init; } = string.Empty;

    public string Expression { get; init; } = string.Empty;

    public string TriggerType { get; init; } = "expression";

    public DateTimeOffset? RunAt { get; init; }

    public string? TimeOfDay { get; init; }

    public IReadOnlyList<int> DaysOfWeek { get; init; } = [];

    public int? MinuteOfHour { get; init; }

    public required string TargetDeviceId { get; init; }

    public required string TargetParameterKey { get; init; }

    public uint RawValue { get; init; }

    public int CooldownMinutes { get; init; } = 15;
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

    public required string TriggerType { get; init; }

    public required string SourceDeviceId { get; init; }

    public required string TargetDeviceId { get; init; }

    public required string TargetParameterKey { get; init; }

    public required uint RawValue { get; init; }

    public required bool Success { get; init; }

    public required string Message { get; init; }
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
    long? RawValue,
    IReadOnlyList<AutomationSelectOption> Options);

public sealed record AutomationSelectOption(long Value, string Label);
