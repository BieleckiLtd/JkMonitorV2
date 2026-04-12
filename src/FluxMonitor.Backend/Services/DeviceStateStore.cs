using System.Collections.Concurrent;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

public sealed class DeviceStateStore
{
    private readonly ConcurrentDictionary<string, DeviceRuntimeState> _states = new(StringComparer.OrdinalIgnoreCase);
    private readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;
    private readonly HostSystemMonitoringService _hostSystemMonitoringService;
    private readonly IBuildMetadataProvider _buildMetadataProvider;
    private readonly DeviceStateBroadcaster _deviceStateBroadcaster;

    public DeviceStateStore(
        DeviceConfigStore deviceConfigStore,
        DeviceDefinitionLoader definitionLoader,
        HostSystemMonitoringService hostSystemMonitoringService,
        IBuildMetadataProvider buildMetadataProvider,
        DeviceStateBroadcaster deviceStateBroadcaster)
    {
        _hostSystemMonitoringService = hostSystemMonitoringService;
        _buildMetadataProvider = buildMetadataProvider;
        _deviceStateBroadcaster = deviceStateBroadcaster;

        foreach (var device in deviceConfigStore.GetDevices())
        {
            RegisterDevice(device, definitionLoader);
        }
    }

    /// <summary>
    /// Register (or re-register) a device in the runtime state store.
    /// Called by the <see cref="DeviceOrchestrator"/> when devices are added or updated live.
    /// </summary>
    public void RegisterDevice(DeviceConfiguration device, DeviceDefinitionLoader definitionLoader)
    {
        string? protocolHandler = null;

        if (device.TryResolveDefinition(definitionLoader, out var definition) && definition is not null)
        {
            protocolHandler = definition.Connection.Protocol.Type;
        }

        _states[device.DeviceId] = new DeviceRuntimeState
        {
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            DefinitionId = device.DefinitionId,
            ProtocolHandler = protocolHandler,
            Enabled = device.Enabled,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            DisplayPrecision = device.DisplayPrecision,
            TemperatureUnit = device.TemperatureUnit,
            LastOutcome = "NotStarted"
        };

        PublishCurrentDevices();
    }

    /// <summary>
    /// Remove a device from the runtime state store.
    /// Called by the <see cref="DeviceOrchestrator"/> when a device is removed live.
    /// </summary>
    public void UnregisterDevice(string deviceId)
    {
        if (_states.TryRemove(deviceId, out _))
        {
            PublishCurrentDevices();
        }
    }

    public void UnregisterMissingDevices(IEnumerable<string> deviceIdsToKeep)
    {
        var keep = new HashSet<string>(deviceIdsToKeep, StringComparer.OrdinalIgnoreCase);
        var changed = false;

        foreach (var deviceId in _states.Keys)
        {
            if (!keep.Contains(deviceId))
            {
                changed |= _states.TryRemove(deviceId, out _);
            }
        }

        if (changed)
        {
            PublishCurrentDevices();
        }
    }

    public DeviceRuntimeState? GetDeviceState(string deviceId)
    {
        return _states.TryGetValue(deviceId, out var state) ? state : null;
    }

    public IReadOnlyList<DeviceRuntimeState> GetCurrentDevices()
    {
        return _states.Values
            .OrderByDescending(device => device.IsMaster)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public MonitorRuntimeStatus GetStatus(string environmentName)
    {
        var devices = GetCurrentDevices();

        return new MonitorRuntimeStatus
        {
            ServiceName = "FluxMonitor.Backend",
            EnvironmentName = environmentName,
            StartupMode = "Hardware",
            StartedAt = _startedAt,
            ReportedAt = DateTimeOffset.UtcNow,
            ConfiguredDeviceCount = _states.Count,
            EnabledDeviceCount = _states.Values.Count(device => device.Enabled),
            Build = _buildMetadataProvider.GetBuildInfo(),
            SystemMetrics = _hostSystemMonitoringService.GetMetrics(),
            Devices = devices
        };
    }

    public void MarkPollStarted(DeviceConfiguration device, DateTimeOffset timestamp)
    {
        _states.AddOrUpdate(
            device.DeviceId,
            _ => CreateState(device, timestamp, null, "Started"),
            (_, current) => current with
            {
                LastPollStartedAt = timestamp,
                LastOutcome = "Started",
                LastError = null
            });
    }

    public void MarkPollCompleted(
        DeviceConfiguration device,
        DateTimeOffset startedAt,
        DateTimeOffset completedAt,
        DeviceTelemetrySnapshot? latestTelemetry,
        DateTimeOffset? lastPersistedAt,
        string outcome,
        string? lastError = null)
    {
        _states.AddOrUpdate(
            device.DeviceId,
            _ => CreateState(device, startedAt, completedAt, outcome, lastError, lastPersistedAt, latestTelemetry),
            (_, current) => current with
            {
                LastPollStartedAt = startedAt,
                LastPollCompletedAt = completedAt,
                LastOutcome = outcome,
                LastError = lastError,
                LastPersistedAt = lastPersistedAt,
                LatestTelemetry = latestTelemetry
            });

        PublishCurrentDevices();
    }

    public void MarkPollFailed(DeviceConfiguration device, DateTimeOffset startedAt, Exception exception)
    {
        _states.AddOrUpdate(
            device.DeviceId,
            _ => CreateState(device, startedAt, DateTimeOffset.UtcNow, "Failed", exception.Message),
            (_, current) => current with
            {
                LastPollStartedAt = startedAt,
                LastPollCompletedAt = DateTimeOffset.UtcNow,
                LastOutcome = "Failed",
                LastError = exception.Message
            });

        PublishCurrentDevices();
    }

    private void PublishCurrentDevices()
    {
        _deviceStateBroadcaster.Publish(GetCurrentDevices());
    }

    private static DeviceRuntimeState CreateState(
        DeviceConfiguration device,
        DateTimeOffset startedAt,
        DateTimeOffset? completedAt,
        string outcome,
        string? lastError = null,
        DateTimeOffset? lastPersistedAt = null,
        DeviceTelemetrySnapshot? latestTelemetry = null)
    {
        return new DeviceRuntimeState
        {
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            DefinitionId = device.DefinitionId,
            Enabled = device.Enabled,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            DisplayPrecision = device.DisplayPrecision,
            TemperatureUnit = device.TemperatureUnit,
            LastPollStartedAt = startedAt,
            LastPollCompletedAt = completedAt,
            LastOutcome = outcome,
            LastError = lastError,
            LastPersistedAt = lastPersistedAt,
            LatestTelemetry = latestTelemetry
        };
    }
}
