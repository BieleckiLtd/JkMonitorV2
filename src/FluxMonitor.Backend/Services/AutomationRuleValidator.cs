using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public static class AutomationRuleValidator
{
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

            if (string.IsNullOrWhiteSpace(rule.Expression))
                errors.Add($"{label}: expression is required.");

            var actions = NormalizeActions(rule);
            if (actions.Count == 0)
                errors.Add($"{label}: add at least one action.");

            for (var actionIndex = 0; actionIndex < actions.Count; actionIndex++)
            {
                var action = actions[actionIndex];
                var actionLabel = $"{label} action {actionIndex + 1}";
                if (string.IsNullOrWhiteSpace(action.TargetDeviceId))
                    errors.Add($"{actionLabel}: target device is required.");

                if (string.IsNullOrWhiteSpace(action.TargetParameterKey))
                    errors.Add($"{actionLabel}: target parameter is required.");
            }

            if (rule.CooldownMinutes < 0)
                errors.Add($"{label}: cooldown cannot be negative.");
        }

        return errors;
    }

    internal static bool TryParseTimeOfDay(string? value, out TimeOnly time)
        => TimeOnly.TryParseExact(value, "HH:mm", out time);

    internal static IReadOnlyList<AutomationActionConfig> NormalizeActions(AutomationRuleConfig rule)
    {
        if (rule.Actions.Count > 0)
            return rule.Actions;

        if (!string.IsNullOrWhiteSpace(rule.TargetDeviceId)
            || !string.IsNullOrWhiteSpace(rule.TargetParameterKey))
        {
            return
            [
                new AutomationActionConfig
                {
                    TargetDeviceId = rule.TargetDeviceId,
                    TargetParameterKey = rule.TargetParameterKey,
                    RawValue = rule.RawValue
                }
            ];
        }

        return [];
    }

    private static string GetRuleLabel(AutomationRuleConfig rule, int index)
        => string.IsNullOrWhiteSpace(rule.Name) ? $"Rule {index + 1}" : $"Rule \"{rule.Name}\"";
}
