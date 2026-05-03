using System.Text.Json;
using FluxMonitor.Backend.Controllers;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DevicesControllerStreamTests
{
    [Fact]
    public void FilterEnabledDeviceStates_RemovesDisabledDevices()
    {
        var devices = DevicesController.FilterEnabledDeviceStates([
            new DeviceRuntimeState
            {
                DeviceId = "enabled-device",
                DisplayName = "Enabled Device",
                DefinitionId = "jk-inverter-bms",
                Enabled = true,
                IsMaster = false,
                PollIntervalMilliseconds = 1000
            },
            new DeviceRuntimeState
            {
                DeviceId = "disabled-device",
                DisplayName = "Disabled Device",
                DefinitionId = "jk-inverter-bms",
                Enabled = false,
                IsMaster = false,
                PollIntervalMilliseconds = 1000
            }
        ]);

        Assert.Collection(
            devices,
            device => Assert.Equal("enabled-device", device.DeviceId));
    }

    [Fact]
    public void FilterEnabledDeviceConfigurations_RemovesDisabledDevices()
    {
        var devices = DevicesController.FilterEnabledDeviceConfigurations([
            new DeviceConfiguration
            {
                DeviceId = "enabled-device",
                DisplayName = "Enabled Device",
                DefinitionId = "jk-inverter-bms",
                Enabled = true
            },
            new DeviceConfiguration
            {
                DeviceId = "disabled-device",
                DisplayName = "Disabled Device",
                DefinitionId = "jk-inverter-bms",
                Enabled = false
            }
        ]);

        Assert.Collection(
            devices,
            device => Assert.Equal("enabled-device", device.DeviceId));
    }

    [Fact]
    public void SerializeCurrentDevicesStream_UsesWebJsonNaming()
    {
        var payload = DevicesController.SerializeCurrentDevicesStream([
            new DeviceRuntimeState
            {
                DeviceId = "device-1",
                DisplayName = "Battery 1",
                DefinitionId = "jk-inverter-bms",
                Enabled = true,
                IsMaster = true,
                PollIntervalMilliseconds = 1000,
                LatestTelemetry = new DeviceTelemetrySnapshot
                {
                    CollectedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
                    TotalVoltageVolts = 52.4m,
                    Cells = [],
                    ActiveWarnings = []
                }
            }
        ]);

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;

        Assert.True(root.TryGetProperty("devices", out var devices));
        Assert.False(root.TryGetProperty("Devices", out _));
        Assert.Equal("device-1", devices[0].GetProperty("deviceId").GetString());
        Assert.Equal(1000, devices[0].GetProperty("pollIntervalMilliseconds").GetInt32());
        Assert.Equal(52.4m, devices[0].GetProperty("latestTelemetry").GetProperty("totalVoltageVolts").GetDecimal());
    }
}
