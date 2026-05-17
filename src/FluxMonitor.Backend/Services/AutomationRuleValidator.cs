using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public static class AutomationRuleValidator
{
    private static readonly HashSet<string> SupportedTriggerTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "expression",
        "date-time",
        "time-of-day",
        "weekly",
        "hourly"
    };

    public static IReadOnlyList<string> Validate(IReadOnlyList<AutomationRuleConfig> rules)
    {
        ArgumentNullException.ThrowIfNull(rules);

        var errors = new List<string>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (var index = 0; index < rules.Count; index++)
        {
            var rule = rules[index];
            var label = GetRuleLabel(rule, index);

            if (string.IsNullOrWhiteSpace(rule.Id))
                errors.Add($"{label}: id is required.");
            else if (!ids.Add(rule.Id))
                errors.Add($"{label}: id must be unique.");

            if (string.IsNullOrWhiteSpace(rule.Name))
                errors.Add($"{label}: name is required.");

            if (!SupportedTriggerTypes.Contains(rule.TriggerType))
                errors.Add($"{label}: trigger type is not supported.");

            if (string.Equals(rule.TriggerType, "expression", StringComparison.OrdinalIgnoreCase)
                && string.IsNullOrWhiteSpace(rule.Expression))
                errors.Add($"{label}: expression is required.");

            if (string.Equals(rule.TriggerType, "date-time", StringComparison.OrdinalIgnoreCase)
                && rule.RunAt is null)
                errors.Add($"{label}: date/time is required.");

            if ((string.Equals(rule.TriggerType, "time-of-day", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(rule.TriggerType, "weekly", StringComparison.OrdinalIgnoreCase))
                && !TryParseTimeOfDay(rule.TimeOfDay, out _))
                errors.Add($"{label}: time of day must use HH:mm format.");

            if (string.Equals(rule.TriggerType, "weekly", StringComparison.OrdinalIgnoreCase)
                && rule.DaysOfWeek.Count == 0)
                errors.Add($"{label}: select at least one day.");

            if (string.Equals(rule.TriggerType, "weekly", StringComparison.OrdinalIgnoreCase)
                && rule.DaysOfWeek.Any(day => day < 0 || day > 6))
                errors.Add($"{label}: days must be between 0 and 6.");

            if (string.Equals(rule.TriggerType, "hourly", StringComparison.OrdinalIgnoreCase)
                && (rule.MinuteOfHour is null or < 0 or > 59))
                errors.Add($"{label}: minute of hour must be between 0 and 59.");

            if (string.IsNullOrWhiteSpace(rule.TargetDeviceId))
                errors.Add($"{label}: target device is required.");

            if (string.IsNullOrWhiteSpace(rule.TargetParameterKey))
                errors.Add($"{label}: target parameter is required.");

            if (rule.CooldownMinutes < 0)
                errors.Add($"{label}: cooldown cannot be negative.");
        }

        return errors;
    }

    internal static bool TryParseTimeOfDay(string? value, out TimeOnly time)
        => TimeOnly.TryParseExact(value, "HH:mm", out time);

    private static string GetRuleLabel(AutomationRuleConfig rule, int index)
        => string.IsNullOrWhiteSpace(rule.Name) ? $"Rule {index + 1}" : $"Rule \"{rule.Name}\"";
}
