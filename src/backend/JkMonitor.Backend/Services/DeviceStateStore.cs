using System.Collections.Concurrent;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public sealed class DeviceStateStore
{
    private readonly ConcurrentDictionary<string, DeviceRuntimeState> _states = new(StringComparer.OrdinalIgnoreCase);
    private readonly MonitorConfiguration _configuration;
    private readonly DateTimeOffset _startedAt = DateTimeOffset.UtcNow;
    private readonly HostSystemMonitoringService _hostSystemMonitoringService;
    private readonly IBuildMetadataProvider _buildMetadataProvider;

    public DeviceStateStore(
        IOptions<MonitorConfiguration> configuration,
        DeviceDefinitionLoader definitionLoader,
        HostSystemMonitoringService hostSystemMonitoringService,
        IBuildMetadataProvider buildMetadataProvider)
    {
        _configuration = configuration.Value;
        _hostSystemMonitoringService = hostSystemMonitoringService;
        _buildMetadataProvider = buildMetadataProvider;

        foreach (var device in _configuration.Devices)
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

        var profileLookup = _configuration.DeviceProfiles.ToDictionary(p => p.ProfileId, StringComparer.OrdinalIgnoreCase);
        if (profileLookup.TryGetValue(device.ProfileId, out var profile))
        {
            protocolHandler = profile.ProtocolHandler;
        }

        if (!string.IsNullOrEmpty(device.DefinitionId) &&
            definitionLoader.TryGet(device.DefinitionId, out var definition) && definition is not null)
        {
            protocolHandler = definition.Connection.Protocol.Type;
        }

        _states[device.DeviceId] = new DeviceRuntimeState
        {
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            ProfileId = device.ProfileId,
            DefinitionId = device.DefinitionId,
            ProtocolHandler = protocolHandler,
            Enabled = device.Enabled,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            DisplayPrecision = device.DisplayPrecision,
            LastOutcome = "NotStarted"
        };
    }

    /// <summary>
    /// Remove a device from the runtime state store.
    /// Called by the <see cref="DeviceOrchestrator"/> when a device is removed live.
    /// </summary>
    public void UnregisterDevice(string deviceId)
    {
        _states.TryRemove(deviceId, out _);
    }

    public DeviceRuntimeState? GetDeviceState(string deviceId)
    {
        return _states.TryGetValue(deviceId, out var state) ? state : null;
    }

    public MonitorRuntimeStatus GetStatus(string environmentName)
    {
        var devices = _states.Values
            .OrderByDescending(device => device.IsMaster)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return new MonitorRuntimeStatus
        {
            ServiceName = "JkMonitor.Backend",
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
            ProfileId = device.ProfileId,
            Enabled = device.Enabled,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            DisplayPrecision = device.DisplayPrecision,
            LastPollStartedAt = startedAt,
            LastPollCompletedAt = completedAt,
            LastOutcome = outcome,
            LastError = lastError,
            LastPersistedAt = lastPersistedAt,
            LatestTelemetry = latestTelemetry
        };
    }
}
