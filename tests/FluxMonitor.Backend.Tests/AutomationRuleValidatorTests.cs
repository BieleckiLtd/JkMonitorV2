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
                Expression = "",
                Actions =
                [
                    new AutomationActionConfig
                    {
                        TargetDeviceId = "inverter-1",
                        TargetParameterKey = "charging_enabled",
                        RawValue = 1
                    }
                ]
            }
        ]);

        Assert.Contains("expression is required.", errors.Single());
    }

    [Fact]
    public void Validate_ReturnsNoErrors_ForExpressionRuleWithActions()
    {
        var errors = AutomationRuleValidator.Validate(
        [
            new AutomationRuleConfig
            {
                Id = "automation-1",
                Name = "Enable output",
                Expression = "battery-1.state_of_charge < 20 && time.day_of_week <= 5",
                Actions =
                [
                    new AutomationActionConfig
                    {
                        TargetDeviceId = "inverter-1",
                        TargetParameterKey = "output_enabled",
                        RawValue = 1
                    }
                ]
            }
        ]);

        Assert.Empty(errors);
    }

    [Fact]
    public void ValidateActionsOnly_AllowsBlankExpression()
    {
        var errors = AutomationRuleValidator.ValidateActionsOnly(new AutomationRuleConfig
        {
            Id = "automation-1",
            Name = "Test action",
            Expression = "",
            Actions =
            [
                new AutomationActionConfig
                {
                    TargetDeviceId = "inverter-1",
                    TargetParameterKey = "output_enabled",
                    RawValue = 1
                }
            ]
        });

        Assert.Empty(errors);
    }
}
