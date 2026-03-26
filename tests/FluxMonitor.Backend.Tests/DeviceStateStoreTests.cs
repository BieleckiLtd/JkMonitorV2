using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace FluxMonitor.Backend.Tests;

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
    public void GetStatus_ReportsHardwareMode()
    {
        var store = CreateStore(
            new BuildRuntimeInfo(),
            new MonitorConfiguration
            {
                Storage = new StorageConfiguration
                {
                    Provider = "None",
                    ConnectionString = string.Empty,
                    Retention = new RetentionConfiguration()
                },
                ApiSecurity = new ApiSecurityConfiguration
                {
                    TunnelProvider = "None"
                },
                Devices =
                [
                    new DeviceConfiguration
                    {
                        DeviceId = "device-01",
                        DisplayName = "Device 01",
                        DefinitionId = "jk-inverter-bms"
                    }
                ]
            });

        var status = store.GetStatus("Production");

        Assert.Equal("Hardware", status.StartupMode);
    }

    private static DeviceStateStore CreateStore(BuildRuntimeInfo buildInfo, MonitorConfiguration? configuration = null)
    {
        var hostSystemMonitoringService = new HostSystemMonitoringService(
            NullLogger<HostSystemMonitoringService>.Instance,
            new TestHostEnvironment());

        var definitionLoader = new DeviceDefinitionLoader(
            "devices",
            NullLogger<DeviceDefinitionLoader>.Instance);

        var config = configuration ?? CreateDefaultConfiguration();
        var deviceConfigStore = new DeviceConfigStore(
            Options.Create(config),
            NullLogger<DeviceConfigStore>.Instance);
        // Manually initialize synchronously for tests (no DB, uses seed devices)
        deviceConfigStore.InitializeAsync(CancellationToken.None).GetAwaiter().GetResult();

        return new DeviceStateStore(
            deviceConfigStore,
            definitionLoader,
            hostSystemMonitoringService,
            new FakeBuildMetadataProvider(buildInfo));
    }

    private static MonitorConfiguration CreateDefaultConfiguration()
    {
        return new MonitorConfiguration
        {
            Storage = new StorageConfiguration
            {
                Provider = "None",
                ConnectionString = string.Empty,
                Retention = new RetentionConfiguration()
            },
            ApiSecurity = new ApiSecurityConfiguration
            {
                TunnelProvider = "None"
            },
            Devices =
            [
                new DeviceConfiguration
                {
                    DeviceId = "device-01",
                    DisplayName = "Device 01",
                    DefinitionId = "jk-inverter-bms"
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
        public string ApplicationName { get; set; } = "FluxMonitor.Backend.Tests";
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
