using System.Collections.Concurrent;
using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Manages per-device polling loops at runtime. Supports adding, removing,
/// and replacing devices without restarting the application.
/// </summary>
public sealed class DeviceOrchestrator(
    IDevicePollingClient pollingClient,
    IPassiveBleAdvertisementMonitor passiveBleAdvertisementMonitor,
    ITelemetryRepository telemetryRepository,
    DeviceStateStore stateStore,
    DeviceDefinitionLoader definitionLoader,
    PollTrigger pollTrigger,
    CellVoltageSmoothingFilter smoothingFilter,
    NotificationEvaluator notificationEvaluator,
    ILogger<DeviceOrchestrator> logger,
    AutomationEvaluator? automationEvaluator = null)
{
    private readonly ConcurrentDictionary<string, DeviceHandle> _handles = new(StringComparer.OrdinalIgnoreCase);

    private bool IsTransportSupported(DeviceConfiguration device) =>
        pollingClient is PollingClientDispatcher dispatcher && dispatcher.IsTransportSupported(device);

    private string GetUnsupportedTransportMessage(DeviceConfiguration device) =>
        pollingClient is PollingClientDispatcher dispatcher
            ? dispatcher.GetUnsupportedTransportMessage(device) ?? "Transport type is not yet supported."
            : "Transport type is not yet supported.";

    private bool IsPassiveBleAdvertisementDevice(DeviceConfiguration device)
        => device.TryResolveDefinition(definitionLoader, out var definition) &&
           definition is not null &&
           string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase) &&
           string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Apply a full device configuration set. Diffs against running devices to
    /// stop removed ones, start new ones, and restart changed ones — all live.
    /// </summary>
    public async Task ApplyConfigurationAsync(IReadOnlyList<DeviceConfiguration> devices, CancellationToken cancellationToken = default)
    {
        var configuredDeviceIds = new HashSet<string>(
            devices.Select(device => device.DeviceId),
            StringComparer.OrdinalIgnoreCase);

        var desired = devices
            .Where(d => d.Enabled)
            .ToDictionary(d => d.DeviceId, StringComparer.OrdinalIgnoreCase);

        // Stop devices that are no longer in the config or are now disabled
        var toStop = _handles.Keys
            .Where(id => !desired.ContainsKey(id))
            .ToList();

        foreach (var id in toStop)
        {
            await StopDeviceAsync(id);
            stateStore.UnregisterDevice(id);
            logger.LogInformation("Removed device {DeviceId} (live).", id);
        }

        stateStore.UnregisterMissingDevices(configuredDeviceIds);

        // Also register disabled devices in the state store (so they appear in the UI)
        foreach (var device in devices.Where(d => !d.Enabled))
        {
            if (_handles.ContainsKey(device.DeviceId))
            {
                await StopDeviceAsync(device.DeviceId);
            }

            stateStore.RegisterDevice(device, definitionLoader);
        }

        // Start or restart devices
        foreach (var (id, device) in desired)
        {
            if (_handles.TryGetValue(id, out var existing))
            {
                if (DeviceConfigChanged(existing.Device, device))
                {
                    await StopDeviceAsync(id);
                    stateStore.RegisterDevice(device, definitionLoader);
                    if (IsTransportSupported(device))
                    {
                        StartDevice(device, cancellationToken);
                        logger.LogInformation("Restarted device {DeviceId} with updated configuration (live).", id);
                    }
                    else
                    {
                        logger.LogInformation("Device {DeviceId} registered but not started: {Reason}", id, GetUnsupportedTransportMessage(device));
                    }
                }
            }
            else
            {
                stateStore.RegisterDevice(device, definitionLoader);
                if (IsTransportSupported(device))
                {
                    StartDevice(device, cancellationToken);
                    logger.LogInformation("Started device {DeviceId} (live).", id);
                }
                else
                {
                    logger.LogInformation("Device {DeviceId} registered but not started: {Reason}", id, GetUnsupportedTransportMessage(device));
                }
            }
        }
    }

    /// <summary>
    /// Start a single device runtime loop.
    /// </summary>
    public void StartDevice(DeviceConfiguration device, CancellationToken applicationStopping)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(applicationStopping);
        var mode = IsPassiveBleAdvertisementDevice(device)
            ? DeviceExecutionMode.PassiveBleAdvertisement
            : DeviceExecutionMode.Polling;
        var handle = new DeviceHandle(device, cts, mode);
        if (mode is DeviceExecutionMode.PassiveBleAdvertisement)
        {
            stateStore.MarkPassiveMonitoringListening(device, DateTimeOffset.UtcNow);
            handle.Task = RunPassiveAdvertisementLoopAsync(device, cts.Token);
            logger.LogInformation(
                "Passive BLE advertisement listener created for {DeviceId}. DefinitionId={DefinitionId}, TransportTarget={TransportTarget}.",
                device.DeviceId,
                device.DefinitionId,
                string.IsNullOrWhiteSpace(device.TransportPortName) ? "<none>" : device.TransportPortName);
        }
        else
        {
            handle.Task = RunDeviceLoopAsync(device, cts.Token);
            logger.LogInformation(
                "Device polling loop created for {DeviceId}. DefinitionId={DefinitionId}, PollIntervalMs={PollIntervalMs}, TransportTarget={TransportTarget}.",
                device.DeviceId,
                device.DefinitionId,
                device.PollIntervalMilliseconds,
                string.IsNullOrWhiteSpace(device.TransportPortName) ? "<none>" : device.TransportPortName);
        }
        _handles[device.DeviceId] = handle;
    }

    /// <summary>
    /// Ensure a single device is registered and running. Restarts it if the
    /// configuration has changed, starts it if not yet running. Does NOT
    /// touch any other device — useful for targeted start requests.
    /// </summary>
    public async Task EnsureDeviceRunningAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        stateStore.RegisterDevice(device, definitionLoader);

        if (!IsTransportSupported(device))
        {
            logger.LogInformation("Device {DeviceId} registered but not started: {Reason}", device.DeviceId, GetUnsupportedTransportMessage(device));
            return;
        }

        if (_handles.TryGetValue(device.DeviceId, out var existing))
        {
            if (DeviceConfigChanged(existing.Device, device))
            {
                await StopDeviceAsync(device.DeviceId);
                StartDevice(device, cancellationToken);
                logger.LogInformation("Restarted device {DeviceId} with updated configuration (targeted start).", device.DeviceId);
            }
            else
            {
                logger.LogInformation("Device {DeviceId} is already running with matching configuration.", device.DeviceId);
            }
        }
        else
        {
            StartDevice(device, cancellationToken);
            logger.LogInformation("Started device {DeviceId} (targeted start).", device.DeviceId);
        }
    }

    /// <summary>
    /// Stop a single device runtime loop.
    /// </summary>
    public async Task StopDeviceAsync(string deviceId)
    {
        if (_handles.TryRemove(deviceId, out var handle))
        {
            logger.LogInformation(
                handle.Mode is DeviceExecutionMode.PassiveBleAdvertisement
                    ? "Stopping passive BLE advertisement listener for {DeviceId}."
                    : "Stopping device polling loop for {DeviceId}.",
                deviceId);
            await handle.Cts.CancelAsync();
            try { await handle.Task; } catch (OperationCanceledException) { }
            handle.Cts.Dispose();
        }
    }

    /// <summary>
    /// Stop all running device loops (called on app shutdown).
    /// </summary>
    public async Task StopAllAsync()
    {
        var ids = _handles.Keys.ToList();
        foreach (var id in ids)
        {
            await StopDeviceAsync(id);
        }
    }

    private async Task RunDeviceLoopAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(device.PollIntervalMilliseconds));

        while (!cancellationToken.IsCancellationRequested)
        {
            var startedAt = DateTimeOffset.UtcNow;
            stateStore.MarkPollStarted(device, startedAt);

            try
            {
                logger.LogDebug("Polling device {DeviceId}.", device.DeviceId);

                var rawSample = await pollingClient.PollAsync(device, cancellationToken);
                var filteredSnapshot = smoothingFilter.Apply(device, rawSample.Snapshot);
                var sample = rawSample with { Snapshot = filteredSnapshot };
                DateTimeOffset? persistedAt = null;
                var outcome = "Succeeded";
                string? persistenceError = null;

                try
                {
                    await telemetryRepository.PersistAsync(device, sample, cancellationToken);
                    persistedAt = DateTimeOffset.UtcNow;
                }
                catch (Exception exception)
                {
                    outcome = "PersistFailed";
                    persistenceError = exception.Message;
                    logger.LogError(exception, "Telemetry persistence failed for device {DeviceId}.", device.DeviceId);
                }

                stateStore.MarkPollCompleted(device, startedAt, DateTimeOffset.UtcNow, sample.Snapshot, persistedAt, outcome, persistenceError);

                // Evaluate notification rules against the latest snapshot
                try
                {
                    await notificationEvaluator.EvaluateAsync(device.DeviceId, device.DisplayName, sample.Snapshot, cancellationToken);
                }
                catch (Exception notifEx)
                {
                    logger.LogWarning(notifEx, "Notification evaluation failed for device {DeviceId}.", device.DeviceId);
                }

                try
                {
                    if (automationEvaluator is not null)
                        await automationEvaluator.EvaluateAsync(device.DeviceId, device.DisplayName, sample.Snapshot, cancellationToken);
                }
                catch (Exception automationEx)
                {
                    logger.LogWarning(automationEx, "Automation evaluation failed for device {DeviceId}.", device.DeviceId);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (NotSupportedException exception)
            {
                // Transport type not yet implemented — stop the loop instead of spamming logs.
                stateStore.MarkPollFailed(device, startedAt, exception);
                logger.LogWarning("Stopping polling loop for device {DeviceId}: {Message}", device.DeviceId, exception.Message);
                break;
            }
            catch (Exception exception)
            {
                stateStore.MarkPollFailed(device, startedAt, exception);
                logger.LogError(exception, "Polling failed for device {DeviceId}.", device.DeviceId);
                var userFacingError = BluetoothFailureHints.Describe(exception);

                // Record communication failure so it appears in the notification history log.
                try
                {
                    notificationEvaluator.RecordPollFailure(device.DeviceId, device.DisplayName, userFacingError);
                }
                catch (Exception nfEx)
                {
                    logger.LogWarning(nfEx, "Failed to record poll failure event for device {DeviceId}.", device.DeviceId);
                }
            }

            try
            {
                using var waitCts = CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken,
                    pollTrigger.GetToken());

                var hasNextTick = await timer.WaitForNextTickAsync(waitCts.Token);
                if (!hasNextTick)
                {
                    break;
                }
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // PollTrigger signalled – run next poll immediately.
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    private async Task RunPassiveAdvertisementLoopAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await passiveBleAdvertisementMonitor.RunAsync(device, cancellationToken);
                break;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch (NotSupportedException exception)
            {
                stateStore.MarkPassiveMonitoringFailed(device, exception);
                logger.LogWarning(
                    "Stopping passive BLE advertisement listener for device {DeviceId}: {Message}",
                    device.DeviceId,
                    exception.Message);
                break;
            }
            catch (Exception exception)
            {
                stateStore.MarkPassiveMonitoringFailed(device, exception);
                logger.LogError(exception, "Passive BLE advertisement listener failed for device {DeviceId}.", device.DeviceId);

                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), cancellationToken);
                    stateStore.MarkPassiveMonitoringListening(device, DateTimeOffset.UtcNow);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
            }
        }
    }

    private static bool DeviceConfigChanged(DeviceConfiguration a, DeviceConfiguration b)
    {
        return a.DefinitionId != b.DefinitionId
            || a.DefinitionHash != b.DefinitionHash
            || a.TransportPortName != b.TransportPortName
            || a.Address != b.Address
            || a.PollIntervalMilliseconds != b.PollIntervalMilliseconds
            || a.DisplayName != b.DisplayName
            || a.SortOrder != b.SortOrder
            || a.IsMaster != b.IsMaster
            || a.TemperatureUnit != b.TemperatureUnit
            || a.BleSettingsPin != b.BleSettingsPin
            || a.HttpUsername != b.HttpUsername
            || a.HttpPassword != b.HttpPassword;
    }

    private enum DeviceExecutionMode
    {
        Polling,
        PassiveBleAdvertisement
    }

    private sealed class DeviceHandle(DeviceConfiguration device, CancellationTokenSource cts, DeviceExecutionMode mode)
    {
        public DeviceConfiguration Device { get; } = device;
        public CancellationTokenSource Cts { get; } = cts;
        public DeviceExecutionMode Mode { get; } = mode;
        public Task Task { get; set; } = Task.CompletedTask;
    }
}
