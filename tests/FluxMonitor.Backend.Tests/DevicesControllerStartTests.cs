using FluxMonitor.Backend.Controllers;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DevicesControllerStartTests
{
    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("NotStarted", false)]
    [InlineData("Started", false)]
    [InlineData("Listening", true)]
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
    [InlineData("Listening", true)]
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
    public void BuildStartOutcomeMessage_ReturnsListeningMessageForPassiveBleDevices()
    {
        var message = DevicesController.BuildStartOutcomeMessage("Listening", null);

        Assert.Equal("Device started and listening for broadcast updates.", message);
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
            "Bluetooth operation failed. Check System > Bluetooth and the device connection, then try again.",
            error);
    }

    [Fact]
    public void GetProtectedWriteBlockReason_BlocksAnenjiOutputSettingWritesWhenLoadIsActive()
    {
        var latestTelemetry = new DeviceTelemetrySnapshot
        {
            CollectedAt = DateTimeOffset.UtcNow,
            Cells = [],
            ActiveWarnings = [],
            Parameters =
            [
                new DeviceParameter
                {
                    Key = "output_active_power",
                    DisplayName = "Load Power",
                    Category = "Output",
                    NumericValue = 540,
                    SortOrder = 0
                }
            ]
        };

        var reason = DevicesController.GetProtectedWriteBlockReason(
            CreateDefinitionWithOutputWriteGuards(),
            "output_voltage_setting",
            latestTelemetry);

        Assert.Equal("Turn inverter output off before changing output voltage or frequency.", reason);
    }

    [Fact]
    public void GetProtectedWriteBlockReason_AllowsAnenjiOutputSettingWritesWhenLoadIsInactive()
    {
        var latestTelemetry = new DeviceTelemetrySnapshot
        {
            CollectedAt = DateTimeOffset.UtcNow,
            Cells = [],
            ActiveWarnings = [],
            Parameters =
            [
                new DeviceParameter
                {
                    Key = "output_active_power",
                    DisplayName = "Load Power",
                    Category = "Output",
                    NumericValue = 0,
                    SortOrder = 0
                },
                new DeviceParameter
                {
                    Key = "load_percent",
                    DisplayName = "Load",
                    Category = "Output",
                    NumericValue = 0,
                    SortOrder = 1
                }
            ]
        };

        var reason = DevicesController.GetProtectedWriteBlockReason(
            CreateDefinitionWithOutputWriteGuards(),
            "output_frequency_setting",
            latestTelemetry);

        Assert.Null(reason);
    }

    private static DeviceDefinition CreateDefinitionWithOutputWriteGuards() => new()
    {
        Version = "test",
        Device = new DeviceMetadata { Id = "test-inverter", Name = "Test Inverter" },
        Connection = new ConnectionDefinition
        {
            Transport = new TransportDefinition { Type = "serial" },
            Protocol = new ProtocolDefinition { Type = "test" }
        },
        DataSources = [],
        PollGroups = new Dictionary<string, PollGroupDefinition>(),
        Entities =
        [
            new EntityDefinition
            {
                Id = "output_voltage_setting",
                Type = "select",
                Name = "Output voltage",
                Category = "Output",
                Source = new EntitySourceDefinition { Bank = "settings", ByteOffset = 0 },
                Writable = true,
                Write = new EntityWriteDefinition
                {
                    Address = 606,
                    Guard = CreateOutputInactiveGuard()
                }
            },
            new EntityDefinition
            {
                Id = "output_frequency_setting",
                Type = "select",
                Name = "Output frequency",
                Category = "Output",
                Source = new EntitySourceDefinition { Bank = "settings", ByteOffset = 2 },
                Writable = true,
                Write = new EntityWriteDefinition
                {
                    Address = 607,
                    Guard = CreateOutputInactiveGuard()
                }
            }
        ]
    };

    private static EntityWriteGuardDefinition CreateOutputInactiveGuard() => new()
    {
        AnyNonZero = ["output_active_power", "load_percent", "output_current"],
        Message = "Turn inverter output off before changing output voltage or frequency."
    };
}
