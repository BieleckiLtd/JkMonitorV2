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

    [Theory]
    [InlineData("1s", "5m", "1s")]
    [InlineData("1m", "5m", "1m")]
    [InlineData("5m", "5m", "5m")]
    [InlineData("1h", "5m", "5m")]
    [InlineData("5m", "1m", "1m")]
    public void NormalizeHistoryResolution_ReturnsExpectedResolution(string requested, string persisted, string expected)
    {
        var actual = DevicesController.NormalizeHistoryResolution(requested, persisted);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void GetDefaultHistoryFrom_UsesOneHourWindow_ForMinuteResolution()
    {
        var to = new DateTimeOffset(2026, 4, 12, 14, 30, 45, TimeSpan.Zero);

        var actual = DevicesController.GetDefaultHistoryFrom("1m", to);

        Assert.Equal(new DateTimeOffset(2026, 4, 12, 13, 30, 45, TimeSpan.Zero), actual);
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
            "Device started, but no successful poll completed within 8 seconds. Last error: Bluetooth connection was interrupted. Check that Bluetooth is on, the device is awake, and within range, then try again.",
            message);
    }

    [Fact]
    public void GetStartOutcomeError_UsesBluetoothUnavailableHint_ForOpaqueBlueZFailure()
    {
        var error = DevicesController.GetStartOutcomeError("Failed", "org.bluez.Error.Failed: Failed");

        Assert.Equal(
            "Bluetooth is unavailable. It may be turned off or blocked by rfkill. Open System > Bluetooth, turn it on, then try again.",
            error);
    }
}
