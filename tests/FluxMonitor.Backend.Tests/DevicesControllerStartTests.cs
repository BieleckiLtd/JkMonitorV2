using FluxMonitor.Backend.Controllers;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DevicesControllerStartTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("NotStarted", false)]
    [InlineData("Started", false)]
    [InlineData("Succeeded", true)]
    [InlineData("Failed", true)]
    [InlineData("PersistFailed", true)]
    public void IsTerminalStartOutcome_ReturnsExpectedValue(string? outcome, bool expected)
    {
        var actual = DevicesController.IsTerminalStartOutcome(outcome);

        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("Failed", false)]
    [InlineData("Succeeded", true)]
    public void IsSuccessfulStartOutcome_ReturnsExpectedValue(string? outcome, bool expected)
    {
        var actual = DevicesController.IsSuccessfulStartOutcome(outcome);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void GetStartOutcomeError_UsesFallbackWhenFailureHasNoMessage()
    {
        var error = DevicesController.GetStartOutcomeError("Failed", null);

        Assert.Equal("The first poll did not complete successfully.", error);
    }

    [Fact]
    public void BuildStartOutcomeMessage_ReturnsSuccessMessageForSucceededPoll()
    {
        var message = DevicesController.BuildStartOutcomeMessage("Succeeded", null);

        Assert.Equal("Device started and responding.", message);
    }

    [Fact]
    public void BuildStartOutcomeMessage_UsesFailureFallbackWhenErrorMissing()
    {
        var message = DevicesController.BuildStartOutcomeMessage("Failed", null);

        Assert.Equal("Device started but first poll failed: The first poll did not complete successfully.", message);
    }

    [Fact]
    public void BuildStartTimeoutMessage_UsesLastObservedFailure()
    {
        var message = DevicesController.BuildStartTimeoutMessage("Failed", "org.bluez.Error.Failed: le-connection-abort-by-local");

        Assert.Equal(
            "Device started, but no successful poll completed within 8 seconds. Last error: org.bluez.Error.Failed: le-connection-abort-by-local",
            message);
    }
}
