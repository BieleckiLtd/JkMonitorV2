using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public static class NotificationRuleValidator
{
    public static IReadOnlyList<string> Validate(IReadOnlyList<NotificationRuleConfig> rules)
    {
        ArgumentNullException.ThrowIfNull(rules);

        var errors = new List<string>();

        for (var index = 0; index < rules.Count; index++)
        {
            var rule = rules[index];
            var label = GetRuleLabel(rule, index);

            if (string.IsNullOrWhiteSpace(rule.Id))
            {
                errors.Add($"{label}: id is required.");
            }

            if (string.IsNullOrWhiteSpace(rule.Name))
            {
                errors.Add($"{label}: name is required.");
            }

            if (string.IsNullOrWhiteSpace(rule.DeviceId))
            {
                errors.Add($"{label}: device is required.");
            }

            if (string.IsNullOrWhiteSpace(rule.EntityId))
            {
                errors.Add($"{label}: entity is required.");
            }

            if (string.IsNullOrWhiteSpace(rule.Expression))
            {
                errors.Add($"{label}: expression is required.");
            }

            if (rule.CooldownMinutes < 0)
            {
                errors.Add($"{label}: cooldown must be 0 or greater.");
            }
        }

        return errors;
    }

    private static string GetRuleLabel(NotificationRuleConfig rule, int index)
    {
        var number = index + 1;
        return string.IsNullOrWhiteSpace(rule.Name)
            ? $"Rule {number}"
            : $"Rule {number} ('{rule.Name.Trim()}')";
    }
}
