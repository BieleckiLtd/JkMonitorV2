using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class AutomationConfigStoreIdNormalizationTests
{
    [Fact]
    public void NormalizeRuleIds_ReplacesLegacyIdsWithGuids()
    {
        var validGuid = Guid.NewGuid().ToString();
        var rules = new List<AutomationRuleConfig>
        {
            CreateRule("legacy-id"),
            CreateRule(validGuid)
        };

        var normalizedRules = AutomationConfigStore.NormalizeRuleIds(rules, out var normalizedIdCount);

        Assert.Equal(1, normalizedIdCount);
        Assert.True(Guid.TryParse(normalizedRules[0].Id, out _));
        Assert.Equal(validGuid, normalizedRules[1].Id);
    }

    [Fact]
    public void NormalizeRuleIds_ReplacesDuplicateGuidsWithUniqueValues()
    {
        var duplicateGuid = Guid.NewGuid().ToString();
        var rules = new List<AutomationRuleConfig>
        {
            CreateRule(duplicateGuid),
            CreateRule(duplicateGuid)
        };

        var normalizedRules = AutomationConfigStore.NormalizeRuleIds(rules, out var normalizedIdCount);

        Assert.Equal(1, normalizedIdCount);
        Assert.Equal(duplicateGuid, normalizedRules[0].Id);
        Assert.True(Guid.TryParse(normalizedRules[1].Id, out _));
        Assert.NotEqual(normalizedRules[0].Id, normalizedRules[1].Id);
    }

    private static AutomationRuleConfig CreateRule(string id)
        => new()
        {
            Id = id,
            Name = "Rule",
            Enabled = true,
            Expression = "time.hour == 5",
            Actions =
            [
                new AutomationActionConfig
                {
                    TargetDeviceId = "battery-a",
                    TargetParameterKey = "charging_enabled",
                    RawValue = 1
                }
            ],
            CooldownMinutes = 15
        };
}