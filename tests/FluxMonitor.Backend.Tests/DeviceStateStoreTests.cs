using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using System.Net.Http;
using System.Reflection;
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
            CreateDefaultConfiguration(),
            [
                new DeviceConfiguration
                {
                    DeviceId = "device-01",
                    DisplayName = "Device 01",
                    DefinitionId = "jk-inverter-bms"
                }
            ]);

        var status = store.GetStatus("Production");

        Assert.Equal("Hardware", status.StartupMode);
    }

    [Fact]
    public void UnregisterMissingDevices_RemovesOnlyMissingEntries()
    {
        var store = CreateStore(
            new BuildRuntimeInfo(),
            CreateDefaultConfiguration(),
            [
                new DeviceConfiguration
                {
                    DeviceId = "device-1",
                    DisplayName = "Device 1",
                    DefinitionId = "jk-inverter-bms"
                },
                new DeviceConfiguration
                {
                    DeviceId = "device-2",
                    DisplayName = "Device 2",
                    DefinitionId = "jk-inverter-bms"
                }
            ]);

        store.UnregisterMissingDevices(["device-2"]);

        var status = store.GetStatus("Production");

        Assert.Collection(
            status.Devices,
            device => Assert.Equal("device-2", device.DeviceId));
    }

    private static DeviceStateStore CreateStore(
        BuildRuntimeInfo buildInfo,
        MonitorConfiguration? configuration = null,
        IReadOnlyList<DeviceConfiguration>? devices = null)
    {
        var hostSystemMonitoringService = new HostSystemMonitoringService(
            NullLogger<HostSystemMonitoringService>.Instance,
            new TestHostEnvironment());

        var definitionLoader = new DeviceDefinitionLoader(
            "devices",
            Directory.GetCurrentDirectory(),
            new StubHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);

        var config = configuration ?? CreateDefaultConfiguration();
        var deviceConfigStore = new DeviceConfigStore(
            Options.Create(config),
            NullLogger<DeviceConfigStore>.Instance,
            definitionLoader);
        SeedDeviceConfigStore(deviceConfigStore, devices ?? []);

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
            }
        };
    }

    private static void SeedDeviceConfigStore(DeviceConfigStore store, IReadOnlyList<DeviceConfiguration> devices)
    {
        typeof(DeviceConfigStore)
            .GetField("_devices", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(store, devices);

        typeof(DeviceConfigStore)
            .GetField("_persistedDeviceIds", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(
                store,
                devices
                    .Select((device, index) => new { device.DeviceId, PersistedDeviceId = index + 1 })
                    .ToDictionary(entry => entry.DeviceId, entry => entry.PersistedDeviceId, StringComparer.OrdinalIgnoreCase));

        typeof(DeviceConfigStore)
            .GetField("_initialized", BindingFlags.Instance | BindingFlags.NonPublic)!
            .SetValue(store, true);
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

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
