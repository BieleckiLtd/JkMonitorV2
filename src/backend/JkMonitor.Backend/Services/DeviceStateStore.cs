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
        HostSystemMonitoringService hostSystemMonitoringService,
        IBuildMetadataProvider buildMetadataProvider)
    {
        _configuration = configuration.Value;
        _hostSystemMonitoringService = hostSystemMonitoringService;
        _buildMetadataProvider = buildMetadataProvider;

        foreach (var device in _configuration.Devices)
        {
            _states[device.DeviceId] = new DeviceRuntimeState
            {
                DeviceId = device.DeviceId,
                DisplayName = device.DisplayName,
                Protocol = device.Protocol,
                Enabled = device.Enabled,
                IsMaster = device.IsMaster,
                PollIntervalMilliseconds = device.PollIntervalMilliseconds,
                LastOutcome = "NotStarted"
            };
        }
    }

    public MonitorRuntimeStatus GetStatus(string environmentName)
    {
        var devices = _states.Values
            .OrderByDescending(device => device.IsMaster)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        var startupMode = string.Equals(_configuration.SerialBus.PortName, "SIMULATED", StringComparison.OrdinalIgnoreCase)
            ? "Simulator"
            : "Hardware";

        return new MonitorRuntimeStatus
        {
            ServiceName = "JkMonitor.Backend",
            EnvironmentName = environmentName,
            StartupMode = startupMode,
            StartedAt = _startedAt,
            ReportedAt = DateTimeOffset.UtcNow,
            ConfiguredDeviceCount = _configuration.Devices.Count,
            EnabledDeviceCount = _configuration.Devices.Count(device => device.Enabled),
            Build = _buildMetadataProvider.GetBuildInfo(),
            SystemMetrics = _hostSystemMonitoringService.GetMetrics(),
            Devices = devices
        };
    }

    public void MarkPollStarted(BmsDeviceConfiguration device, DateTimeOffset timestamp)
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
        BmsDeviceConfiguration device,
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

    public void MarkPollFailed(BmsDeviceConfiguration device, DateTimeOffset startedAt, Exception exception)
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
        BmsDeviceConfiguration device,
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
            Protocol = device.Protocol,
            Enabled = device.Enabled,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            LastPollStartedAt = startedAt,
            LastPollCompletedAt = completedAt,
            LastOutcome = outcome,
            LastError = lastError,
            LastPersistedAt = lastPersistedAt,
            LatestTelemetry = latestTelemetry
        };
    }
}
