using JkMonitor.Backend.Services;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace JkMonitor.Backend.Tests;

public class DeviceStateStoreTests
{
    [Fact]
    public void GetStatus_IncludesBuildMetadata()
    {
        var store = CreateStore(new BuildRuntimeInfo
        {
            ReleaseTag = "dev-latest",
            SourceRevisionId = "abc123def456",
            InformationalVersion = "dev-latest+abc123def456",
            WorkflowRunNumber = "42",
            WorkflowRunAttempt = "1"
        });

        var status = store.GetStatus("Production");

        Assert.NotNull(status.Build);
        Assert.Equal("dev-latest", status.Build.ReleaseTag);
        Assert.Equal("abc123def456", status.Build.SourceRevisionId);
        Assert.Equal("dev-latest+abc123def456", status.Build.InformationalVersion);
        Assert.Equal("42", status.Build.WorkflowRunNumber);
        Assert.Equal("1", status.Build.WorkflowRunAttempt);
    }

    [Fact]
    public void GetStatus_UsesSimulatorMode_WhenConfiguredPortIsSimulated()
    {
        var store = CreateStore(
            new BuildRuntimeInfo(),
            new MonitorConfiguration
            {
                SerialBus = new SerialBusConfiguration
                {
                    PortName = "SIMULATED"
                },
                Storage = new StorageConfiguration
                {
                    Provider = "None",
                    ConnectionString = string.Empty,
                    Retention = new RetentionConfiguration()
                },
                Alerting = new AlertingConfiguration(),
                ApiSecurity = new ApiSecurityConfiguration
                {
                    TunnelProvider = "None"
                },
                Devices =
                [
                    new BmsDeviceConfiguration
                    {
                        DeviceId = "device-01",
                        DisplayName = "Device 01",
                        Protocol = "jk-rs485",
                        RegisterProfile = "jk-inverter-v15"
                    }
                ]
            });

        var status = store.GetStatus("Development");

        Assert.Equal("Simulator", status.StartupMode);
    }

    private static DeviceStateStore CreateStore(BuildRuntimeInfo buildInfo, MonitorConfiguration? configuration = null)
    {
        var hostSystemMonitoringService = new HostSystemMonitoringService(
            NullLogger<HostSystemMonitoringService>.Instance,
            new TestHostEnvironment());

        return new DeviceStateStore(
            Options.Create(configuration ?? CreateDefaultConfiguration()),
            hostSystemMonitoringService,
            new FakeBuildMetadataProvider(buildInfo));
    }

    private static MonitorConfiguration CreateDefaultConfiguration()
    {
        return new MonitorConfiguration
        {
            SerialBus = new SerialBusConfiguration
            {
                PortName = "/dev/ttyUSB0"
            },
            Storage = new StorageConfiguration
            {
                Provider = "None",
                ConnectionString = string.Empty,
                Retention = new RetentionConfiguration()
            },
            Alerting = new AlertingConfiguration(),
            ApiSecurity = new ApiSecurityConfiguration
            {
                TunnelProvider = "None"
            },
            Devices =
            [
                new BmsDeviceConfiguration
                {
                    DeviceId = "device-01",
                    DisplayName = "Device 01",
                    Protocol = "jk-rs485",
                    RegisterProfile = "jk-inverter-v15"
                }
            ]
        };
    }

    private sealed class FakeBuildMetadataProvider(BuildRuntimeInfo buildInfo) : IBuildMetadataProvider
    {
        public BuildRuntimeInfo GetBuildInfo() => buildInfo;
    }

    private sealed class TestHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "JkMonitor.Backend.Tests";
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
