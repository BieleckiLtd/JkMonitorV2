using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class NotificationRuleValidatorTests
{
    [Fact]
    public void Validate_ReturnsError_WhenEntityIsMissing()
    {
        var errors = NotificationRuleValidator.Validate(
        [
            new NotificationRuleConfig
            {
                Id = "rule-1",
                Name = "Battery full",
                DeviceId = "device-1",
                EntityId = "",
                Expression = "value == 100",
                ChannelIds = ["ntfy-main"]
            }
        ]);

        Assert.Contains("entity is required.", errors.Single());
    }

    [Fact]
    public void Validate_ReturnsNoErrors_ForCompleteRule()
    {
        var errors = NotificationRuleValidator.Validate(
        [
            new NotificationRuleConfig
            {
                Id = "rule-1",
                Name = "Battery full",
                DeviceId = "device-1",
                EntityId = "state_of_charge",
                Expression = "value == 100",
                ChannelIds = ["ntfy-main"]
            }
        ]);

        Assert.Empty(errors);
    }
}
