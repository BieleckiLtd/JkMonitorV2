using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class AutomationRuleValidatorTests
{
    [Fact]
    public void Validate_ReturnsError_WhenExpressionTriggerHasNoExpression()
    {
        var errors = AutomationRuleValidator.Validate(
        [
            new AutomationRuleConfig
            {
                Id = "automation-1",
                Name = "Charge when low",
                SourceDeviceId = "battery-1",
                TriggerType = "expression",
                Expression = "",
                TargetDeviceId = "inverter-1",
                TargetParameterKey = "charging_enabled"
            }
        ]);

        Assert.Contains("expression is required.", errors.Single());
    }

    [Fact]
    public void Validate_ReturnsNoErrors_ForWeeklyRule()
    {
        var errors = AutomationRuleValidator.Validate(
        [
            new AutomationRuleConfig
            {
                Id = "automation-1",
                Name = "Enable output",
                TriggerType = "weekly",
                TimeOfDay = "07:30",
                DaysOfWeek = [1, 2, 3, 4, 5],
                TargetDeviceId = "inverter-1",
                TargetParameterKey = "output_enabled",
                RawValue = 1
            }
        ]);

        Assert.Empty(errors);
    }
}
