using System.Text.Json;
using FluxMonitor.Backend.Controllers;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class HealthControllerStreamTests
{
    [Fact]
    public void SerializeRuntimeStatusStream_UsesWebJsonNaming()
    {
        var payload = HealthController.SerializeRuntimeStatusStream(new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = "Production",
            StartupMode = "Hardware",
            StartedAt = DateTimeOffset.Parse("2026-04-10T10:00:00Z"),
            ReportedAt = DateTimeOffset.Parse("2026-04-10T10:00:00.500Z"),
            SystemMetrics = new SystemRuntimeMetrics
            {
                CpuUtilizationPercent = 21.5
            },
            Devices =
            [
                new DeviceRuntimeState
                {
                    DeviceId = "device-1",
                    DisplayName = "Battery 1",
                    DefinitionId = "jk-inverter-bms",
                    Enabled = true,
                    IsMaster = true,
                    PollIntervalMilliseconds = 1000
                }
            ]
        });

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;

        Assert.True(root.TryGetProperty("status", out var status));
        Assert.Equal("Production", status.GetProperty("environmentName").GetString());
        Assert.Equal(21.5, status.GetProperty("systemMetrics").GetProperty("cpuUtilizationPercent").GetDouble());
        Assert.Equal("device-1", status.GetProperty("devices")[0].GetProperty("deviceId").GetString());
    }
}
