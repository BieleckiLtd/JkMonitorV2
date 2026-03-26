using System.Collections.Concurrent;
using FluxMonitor.Contracts.Configuration;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Manages per-device polling loops at runtime. Supports adding, removing,
/// and replacing devices without restarting the application.
/// </summary>
public sealed class DeviceOrchestrator(
    IDevicePollingClient pollingClient,
    ITelemetryRepository telemetryRepository,
    DeviceStateStore stateStore,
    DeviceDefinitionLoader definitionLoader,
    PollTrigger pollTrigger,
    CellVoltageSmoothingFilter smoothingFilter,
    NotificationEvaluator notificationEvaluator,
    ILogger<DeviceOrchestrator> logger)
{
    private readonly ConcurrentDictionary<string, DeviceHandle> _handles = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Apply a full device configuration set. Diffs against running devices to
    /// stop removed ones, start new ones, and restart changed ones — all live.
    /// </summary>
    public async Task ApplyConfigurationAsync(IReadOnlyList<DeviceConfiguration> devices, CancellationToken cancellationToken = default)
    {
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
                    StartDevice(device, cancellationToken);
                    logger.LogInformation("Restarted device {DeviceId} with updated configuration (live).", id);
                }
            }
            else
            {
                stateStore.RegisterDevice(device, definitionLoader);
                StartDevice(device, cancellationToken);
                logger.LogInformation("Started device {DeviceId} (live).", id);
            }
        }
    }

    /// <summary>
    /// Start a single device polling loop.
    /// </summary>
    public void StartDevice(DeviceConfiguration device, CancellationToken applicationStopping)
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(applicationStopping);
        var handle = new DeviceHandle(device, cts);
        handle.Task = RunDeviceLoopAsync(device, cts.Token);
        _handles[device.DeviceId] = handle;
    }

    /// <summary>
    /// Stop a single device polling loop.
    /// </summary>
    public async Task StopDeviceAsync(string deviceId)
    {
        if (_handles.TryRemove(deviceId, out var handle))
        {
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

                // Record communication failure so it appears in the notification history log.
                try
                {
                    notificationEvaluator.RecordPollFailure(device.DeviceId, device.DisplayName, exception.Message);
                }
                catch (Exception nfEx)
                {
                    logger.LogWarning(nfEx, "Failed to record poll failure event for device {DeviceId}.", device.DeviceId);
                }
            }

            try
            {
                await Task.WhenAny(
                    timer.WaitForNextTickAsync(cancellationToken).AsTask(),
                    Task.Delay(Timeout.Infinite, pollTrigger.GetToken()));
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                // PollTrigger signalled – run next poll immediately.
            }
        }
    }

    private static bool DeviceConfigChanged(DeviceConfiguration a, DeviceConfiguration b)
    {
        return a.DefinitionId != b.DefinitionId
            || a.TransportPortName != b.TransportPortName
            || a.Address != b.Address
            || a.PollIntervalMilliseconds != b.PollIntervalMilliseconds
            || a.DisplayName != b.DisplayName
            || a.IsMaster != b.IsMaster
            || a.DatabaseName != b.DatabaseName;
    }

    private sealed class DeviceHandle(DeviceConfiguration device, CancellationTokenSource cts)
    {
        public DeviceConfiguration Device { get; } = device;
        public CancellationTokenSource Cts { get; } = cts;
        public Task Task { get; set; } = Task.CompletedTask;
    }
}
