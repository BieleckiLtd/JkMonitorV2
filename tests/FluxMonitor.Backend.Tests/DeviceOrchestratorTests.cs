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

    [Fact]
    public async Task StartDevice_UsesPassiveListener_ForBleAdvertisementDevices()
    {
        var pollingClient = new TestPollingClient();
        var passiveMonitor = new TestPassiveBleAdvertisementMonitor();
        var store = CreateStateStore([]);
        var orchestrator = CreateOrchestrator(store, pollingClient, passiveMonitor);
        var device = new DeviceConfiguration
        {
            DeviceId = "govee-thermo-hygrometer-gvh5075-7256",
            DisplayName = "Fridge",
            DefinitionId = "govee-thermo-hygrometer-ble",
            TransportPortName = "A4:C1:38:19:72:56",
            PollIntervalMilliseconds = 5000,
            Enabled = true
        };

        using var cts = new CancellationTokenSource();
        orchestrator.StartDevice(device, cts.Token);

        await passiveMonitor.WaitForStartAsync();
        var state = store.GetDeviceState(device.DeviceId);

        Assert.NotNull(state);
        Assert.Equal("Listening", state!.LastOutcome);
        Assert.Equal(0, pollingClient.PollCount);

        cts.Cancel();
        await orchestrator.StopAllAsync();
    }

    [Fact]
    public async Task ApplyConfigurationAsync_UpdatesRuntimeOrderForEnabledDevices()
    {
        var pollingClient = new TestPollingClient();
        var store = CreateStateStore([]);
        var orchestrator = CreateOrchestrator(store, pollingClient);

        var initialDevices = new[]
        {
            new DeviceConfiguration
            {
                DeviceId = "device-1",
                DisplayName = "Battery 1",
                SortOrder = 0,
                DefinitionId = "jk-inverter-bms",
                PollIntervalMilliseconds = 60000,
                Enabled = true
            },
            new DeviceConfiguration
            {
                DeviceId = "device-2",
                DisplayName = "Battery 2",
                SortOrder = 1,
                DefinitionId = "jk-inverter-bms",
                PollIntervalMilliseconds = 60000,
                Enabled = true
            }
        };

        await orchestrator.ApplyConfigurationAsync(initialDevices, TestContext.Current.CancellationToken);

        var reorderedDevices = new[]
        {
            new DeviceConfiguration
            {
                DeviceId = "device-1",
                DisplayName = "Battery 1",
                SortOrder = 1,
                DefinitionId = "jk-inverter-bms",
                PollIntervalMilliseconds = 60000,
                Enabled = true
            },
            new DeviceConfiguration
            {
                DeviceId = "device-2",
                DisplayName = "Battery 2",
                SortOrder = 0,
                DefinitionId = "jk-inverter-bms",
                PollIntervalMilliseconds = 60000,
                Enabled = true
            }
        };

        await orchestrator.ApplyConfigurationAsync(reorderedDevices, TestContext.Current.CancellationToken);

        var devices = store.GetCurrentDevices();

        Assert.Collection(
            devices,
            device => Assert.Equal("device-2", device.DeviceId),
            device => Assert.Equal("device-1", device.DeviceId));

        await orchestrator.StopAllAsync();
    }

    private static DeviceOrchestrator CreateOrchestrator(
        DeviceStateStore stateStore,
        IDevicePollingClient pollingClient,
        IPassiveBleAdvertisementMonitor? passiveMonitor,
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
            passiveMonitor ?? new NoOpPassiveBleAdvertisementMonitor(),
            new NoOpTelemetryRepository(),
            stateStore,
            definitionLoader,
            pollTrigger,
            new CellVoltageSmoothingFilter(),
            evaluator,
            NullLogger<DeviceOrchestrator>.Instance);
    }

    private static DeviceOrchestrator CreateOrchestrator(
        DeviceStateStore stateStore,
        IDevicePollingClient pollingClient,
        out PollTrigger pollTrigger)
    {
        return CreateOrchestrator(stateStore, pollingClient, passiveMonitor: null, out pollTrigger);
    }

    private static DeviceOrchestrator CreateOrchestrator(
        DeviceStateStore stateStore,
        IDevicePollingClient pollingClient,
        IPassiveBleAdvertisementMonitor passiveMonitor)
    {
        return CreateOrchestrator(stateStore, pollingClient, passiveMonitor, out _);
    }

    private static DeviceOrchestrator CreateOrchestrator(DeviceStateStore stateStore, IDevicePollingClient pollingClient)
    {
        return CreateOrchestrator(stateStore, pollingClient, passiveMonitor: null, out _);
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
            new FakeBuildMetadataProvider(new BuildRuntimeInfo()),
            new DeviceStateBroadcaster());
    }

    private static DeviceDefinitionLoader CreateDefinitionLoader()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            ResolveRepositoryRoot(),
            new StubHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        loader.LoadAll();
        return loader;
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

    private sealed class TestPassiveBleAdvertisementMonitor : IPassiveBleAdvertisementMonitor
    {
        private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task RunAsync(DeviceConfiguration device, CancellationToken cancellationToken)
        {
            _started.TrySetResult();
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }

        public Task WaitForStartAsync()
            => _started.Task.WaitAsync(TimeSpan.FromSeconds(2));
    }

    private sealed class NoOpPassiveBleAdvertisementMonitor : IPassiveBleAdvertisementMonitor
    {
        public Task RunAsync(DeviceConfiguration device, CancellationToken cancellationToken)
            => Task.Delay(Timeout.Infinite, cancellationToken);
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

    private static string ResolveRepositoryRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (Directory.Exists(Path.Combine(current.FullName, "devices")))
                return current.FullName;

            current = current.Parent;
        }

        return Directory.GetCurrentDirectory();
    }
}
