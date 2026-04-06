using System.Reflection;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DeviceOrchestratorTests
{
    [Fact]
    public async Task ApplyConfigurationAsync_RemovesDisabledDevicesMissingFromStateStore()
    {
        var store = CreateStateStore(
            [
                new DeviceConfiguration
                {
                    DeviceId = "device-1",
                    DisplayName = "Removed Device",
                    DefinitionId = "jk-inverter-bms",
                    Enabled = false
                }
            ]);

        var orchestrator = CreateOrchestrator(store, new TestPollingClient());

        await orchestrator.ApplyConfigurationAsync(
            [
                new DeviceConfiguration
                {
                    DeviceId = "device-2",
                    DisplayName = "Current Device",
                    DefinitionId = "jk-inverter-bms",
                    Enabled = false
                }
            ],
            TestContext.Current.CancellationToken);

        var status = store.GetStatus("Test");

        Assert.Collection(
            status.Devices,
            device => Assert.Equal("device-2", device.DeviceId));
    }

    [Fact]
    public async Task RunDeviceLoopAsync_SurvivesPollTriggerWakeups()
    {
        var pollingClient = new TestPollingClient();
        var store = CreateStateStore([]);
        var orchestrator = CreateOrchestrator(store, pollingClient, out var pollTrigger);
        var device = new DeviceConfiguration
        {
            DeviceId = "device-2",
            DisplayName = "Loop Device",
            DefinitionId = "jk-inverter-bms",
            PollIntervalMilliseconds = 60000,
            Enabled = true
        };

        using var cts = new CancellationTokenSource();
        var loopTask = InvokeRunDeviceLoopAsync(orchestrator, device, cts.Token);

        await pollingClient.WaitForPollCountAsync(1);

        pollTrigger.Signal();

        await pollingClient.WaitForPollCountAsync(2);

        cts.Cancel();

        await loopTask;
        Assert.Equal(2, pollingClient.PollCount);
    }

    private static DeviceOrchestrator CreateOrchestrator(
        DeviceStateStore stateStore,
        IDevicePollingClient pollingClient,
        out PollTrigger pollTrigger)
    {
        var definitionLoader = CreateDefinitionLoader();
        pollTrigger = new PollTrigger();
        var configStore = new NotificationConfigStore(
            Options.Create(CreateDefaultConfiguration()),
            new TestHostEnvironment(),
            NullLogger<NotificationConfigStore>.Instance);
        var dispatcher = new NotificationDispatcher(
            configStore,
            [],
            NullLogger<NotificationDispatcher>.Instance);
        var evaluator = new NotificationEvaluator(
            configStore,
            dispatcher,
            NullLogger<NotificationEvaluator>.Instance);

        return new DeviceOrchestrator(
            pollingClient,
            new NoOpTelemetryRepository(),
            stateStore,
            definitionLoader,
            pollTrigger,
            new CellVoltageSmoothingFilter(),
            evaluator,
            NullLogger<DeviceOrchestrator>.Instance);
    }

    private static DeviceOrchestrator CreateOrchestrator(DeviceStateStore stateStore, IDevicePollingClient pollingClient)
    {
        return CreateOrchestrator(stateStore, pollingClient, out _);
    }

    private static Task InvokeRunDeviceLoopAsync(DeviceOrchestrator orchestrator, DeviceConfiguration device, CancellationToken cancellationToken)
    {
        var method = typeof(DeviceOrchestrator).GetMethod("RunDeviceLoopAsync", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);

        var task = method!.Invoke(orchestrator, [device, cancellationToken]) as Task;
        Assert.NotNull(task);

        return task!;
    }

    private static DeviceStateStore CreateStateStore(IReadOnlyList<DeviceConfiguration> devices)
    {
        var hostSystemMonitoringService = new HostSystemMonitoringService(
            NullLogger<HostSystemMonitoringService>.Instance,
            new TestHostEnvironment());

        var definitionLoader = CreateDefinitionLoader();
        var deviceConfigStore = new DeviceConfigStore(
            Options.Create(CreateDefaultConfiguration()),
            NullLogger<DeviceConfigStore>.Instance,
            definitionLoader);

        SeedDeviceConfigStore(deviceConfigStore, devices);

        return new DeviceStateStore(
            deviceConfigStore,
            definitionLoader,
            hostSystemMonitoringService,
            new FakeBuildMetadataProvider(new BuildRuntimeInfo()));
    }

    private static DeviceDefinitionLoader CreateDefinitionLoader()
    {
        return new DeviceDefinitionLoader(
            "devices",
            Directory.GetCurrentDirectory(),
            new StubHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);
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

    private sealed class TestPollingClient : IDevicePollingClient
    {
        private readonly TaskCompletionSource _firstPoll = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _secondPoll = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _pollCount;

        public int PollCount => Volatile.Read(ref _pollCount);

        public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
        {
            var pollCount = Interlocked.Increment(ref _pollCount);
            if (pollCount == 1)
            {
                _firstPoll.TrySetResult();
            }
            else if (pollCount == 2)
            {
                _secondPoll.TrySetResult();
            }

            return Task.FromResult(new DevicePollResult(
                new DeviceTelemetrySnapshot
                {
                    CollectedAt = DateTimeOffset.UtcNow,
                    Cells = [],
                    ActiveWarnings = []
                },
                new Dictionary<string, string>(),
                string.Empty));
        }

        public Task WaitForPollCountAsync(int pollCount)
        {
            return pollCount switch
            {
                1 => _firstPoll.Task.WaitAsync(TimeSpan.FromSeconds(2)),
                2 => _secondPoll.Task.WaitAsync(TimeSpan.FromSeconds(2)),
                _ => Task.CompletedTask
            };
        }
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