using System.IO.Ports;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/devices")]
public sealed class DevicesController(
    IHostEnvironment environment,
    DeviceStateStore stateStore,
    DeviceOrchestrator orchestrator,
    DeviceConfigStore deviceConfigStore,
    GenericSerialPollingClient genericModbusPollingClient,
    GenericBlePollingClient genericBlePollingClient,
    PollingClientDispatcher pollingClientDispatcher,
    DeviceDefinitionLoader definitionLoader,
    ITelemetryRepository telemetryRepository,
    IOptionsMonitor<MonitorConfiguration> configuration,
    PollTrigger pollTrigger,
    ILogger<DevicesController> logger) : ControllerBase
{
    private RetentionConfiguration GetCurrentRetention() => configuration.CurrentValue.Storage.Retention;

    [HttpGet("current")]
    public IActionResult GetCurrent()
    {
        var status = stateStore.GetStatus(environment.EnvironmentName);
        return Ok(status.Devices);
    }

    [HttpGet("config")]
    public IActionResult GetConfig()
    {
        return Ok(new { devices = deviceConfigStore.GetDevices() });
    }

    [HttpPut("config")]
    public async Task<ActionResult> SaveConfig(
        [FromBody] SaveDeviceConfigurationRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            var existingDevices = deviceConfigStore.GetDevices();
            var existingIds = existingDevices.Select(device => device.DeviceId).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var requestedIds = request.Devices.Select(device => device.DeviceId).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var added = request.Devices.Where(device => !existingIds.Contains(device.DeviceId)).Select(device => device.DeviceId).ToArray();
            var removed = existingDevices.Where(device => !requestedIds.Contains(device.DeviceId)).Select(device => device.DeviceId).ToArray();

            logger.LogInformation(
                "Saving device configuration. RequestedCount={RequestedCount}, Added={AddedCount}, Removed={RemovedCount}.",
                request.Devices.Count,
                added.Length,
                removed.Length);

            if (added.Length > 0)
            {
                logger.LogInformation("Adding {AddedCount} device(s).", added.Length);
            }

            if (removed.Length > 0)
            {
                logger.LogInformation("Removing {RemovedCount} device(s).", removed.Length);
            }

            var devices = await deviceConfigStore.SaveDevicesAsync(request.Devices, cancellationToken);

            // Apply live — starts/stops device polling loops without restart
            await orchestrator.ApplyConfigurationAsync(devices, cancellationToken);
            logger.LogInformation("Device configuration applied successfully. ActiveDeviceCount={DeviceCount}.", devices.Count);

            return Ok(new { devices });
        }
        catch (InvalidOperationException exception)
        {
            logger.LogWarning(exception, "Failed to save device configuration due to invalid operation.");
            return BadRequest(new { message = exception.Message });
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Unexpected failure while saving device configuration.");
            return StatusCode(500, new { message = "Failed to save device configuration." });
        }
    }

    [HttpGet("{deviceId}/history")]
    public async Task<IActionResult> GetHistory(
        string deviceId,
        [FromQuery] string resolution = "5m",
        [FromQuery] string bucketView = "avg",
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        CancellationToken cancellationToken = default)
    {
        var persistedResolution = TimescaleTelemetryRepository.GetPersistedResolution(GetCurrentRetention().PersistedBucketMinutes);
        var allowed = new HashSet<string>(StringComparer.Ordinal) { "1s", "1m", "5m", "1h", persistedResolution };
        if (!allowed.Contains(resolution))
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use 1s or {persistedResolution}. Legacy 1m, 5m, and 1h inputs are accepted as persisted-history aliases." });

        if (!TimescaleTelemetryRepository.TryParseBucketValueKind(bucketView, out var bucketValueKind))
            return BadRequest(new { message = $"Invalid bucket view '{bucketView}'. Use avg, min, max, or last." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? (
            string.Equals(resolution, "1s", StringComparison.Ordinal) ? toValue.AddMinutes(-10) :
            string.Equals(resolution, "1m", StringComparison.Ordinal) ? toValue.AddHours(-1) :
            string.Equals(resolution, "1h", StringComparison.Ordinal) ? toValue.AddDays(-7) :
            toValue.AddDays(-1));

        var normalizedResolution = string.Equals(resolution, "1s", StringComparison.Ordinal) ? "1s" : persistedResolution;
        var points = await telemetryRepository.QueryHistoryAsync(deviceId, normalizedResolution, bucketValueKind, fromValue, toValue, cancellationToken);
        return Ok(new
        {
            deviceId,
            resolution = normalizedResolution,
            bucketView = TimescaleTelemetryRepository.FormatBucketValueKind(bucketValueKind),
            from = fromValue,
            to = toValue,
            points
        });
    }

    [HttpGet("{deviceId}/history/cell/{cellIndex:int}")]
    public async Task<IActionResult> GetCellHistory(
        string deviceId,
        int cellIndex,
        [FromQuery] string resolution = "5m",
        [FromQuery] string bucketView = "avg",
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        CancellationToken cancellationToken = default)
    {
        if (cellIndex < 1 || cellIndex > 31)
            return BadRequest(new { message = "Cell index must be between 1 and 31." });

        var persistedResolution = TimescaleTelemetryRepository.GetPersistedResolution(GetCurrentRetention().PersistedBucketMinutes);
        var allowed = new HashSet<string>(StringComparer.Ordinal) { "1s", "1m", "5m", "1h", persistedResolution };
        if (!allowed.Contains(resolution))
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use 1s or {persistedResolution}. Legacy 1m, 5m, and 1h inputs are accepted as persisted-history aliases." });

        if (!TimescaleTelemetryRepository.TryParseBucketValueKind(bucketView, out var bucketValueKind))
            return BadRequest(new { message = $"Invalid bucket view '{bucketView}'. Use avg, min, max, or last." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? (
            string.Equals(resolution, "1s", StringComparison.Ordinal) ? toValue.AddMinutes(-10) :
            string.Equals(resolution, "1m", StringComparison.Ordinal) ? toValue.AddHours(-1) :
            string.Equals(resolution, "1h", StringComparison.Ordinal) ? toValue.AddDays(-7) :
            toValue.AddDays(-1));

        var normalizedResolution = string.Equals(resolution, "1s", StringComparison.Ordinal) ? "1s" : persistedResolution;
        var points = await telemetryRepository.QueryCellHistoryAsync(deviceId, cellIndex, normalizedResolution, bucketValueKind, fromValue, toValue, cancellationToken);
        return Ok(new
        {
            deviceId,
            cellIndex,
            resolution = normalizedResolution,
            bucketView = TimescaleTelemetryRepository.FormatBucketValueKind(bucketValueKind),
            from = fromValue,
            to = toValue,
            points
        });
    }

    [HttpPost("{deviceId}/parameters/{parameterKey}")]
    public async Task<IActionResult> WriteParameter(
        string deviceId, string parameterKey,
        [FromBody] WriteParameterRequest request,
        CancellationToken cancellationToken)
    {
        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
            return NotFound(new { message = $"Device '{deviceId}' not found." });

        try
        {
            if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
                return BadRequest(new { message = $"Device definition '{device.DefinitionId}' not found." });

            var result = string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase)
                ? await genericBlePollingClient.WriteEntityAsync(
                    device, definition, parameterKey, request.RawValue, cancellationToken)
                : await genericModbusPollingClient.WriteEntityAsync(
                    device, definition, parameterKey, request.RawValue, cancellationToken);

            pollTrigger.Signal();
            return Ok(result);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (TimeoutException ex)
        {
            return StatusCode(504, new { message = ex.Message });
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (NotSupportedException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (InvalidDataException ex)
        {
            return BadRequest(new { message = ex.Message });
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Parameter write failed for a configured device.");
            return StatusCode(500, new { message = "Failed to write parameter." });
        }
    }

    [HttpGet("ports")]
    public IActionResult GetAvailablePorts()
    {
        try
        {
            var ports = SerialPort.GetPortNames().OrderBy(p => p).ToArray();
            return Ok(new { ports });
        }
        catch (Exception ex)
        {
            return Ok(new { ports = Array.Empty<string>(), error = ex.Message });
        }
    }

    [HttpGet("ble/scan")]
    public async Task<IActionResult> ScanBleDevices(
        [FromQuery] string? definitionId = null,
        [FromQuery] int? timeoutMs = null,
        [FromQuery] bool returnOnFirstMatch = false,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var hasDefinitionFilter = !string.IsNullOrWhiteSpace(definitionId);
            logger.LogInformation(
                "BLE scan requested. HasDefinitionFilter={HasDefinitionFilter}, TimeoutMs={TimeoutMs}, ReturnOnFirstMatch={ReturnOnFirstMatch}.",
                hasDefinitionFilter,
                timeoutMs,
                returnOnFirstMatch);

            Contracts.DeviceDefinition.DeviceDefinition? definition = null;
            if (!string.IsNullOrWhiteSpace(definitionId) &&
                (!definitionLoader.TryGet(definitionId.Trim(), out definition) || definition is null))
            {
                logger.LogWarning("BLE scan requested with an unknown definition filter.");
                return Ok(new
                {
                    devices = Array.Empty<object>(),
                    error = $"Device definition '{definitionId}' not found."
                });
            }

            if (definition is not null &&
                !string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
            {
                logger.LogWarning("BLE scan requested for a non-BLE device definition.");
                return Ok(new
                {
                    devices = Array.Empty<object>(),
                    error = $"Device definition '{definition.Device.Id}' does not use BLE transport."
                });
            }

            var timeout = timeoutMs.HasValue
                ? TimeSpan.FromMilliseconds(Math.Clamp(timeoutMs.Value, 1000, 15000))
                : (TimeSpan?)null;

            var devices = await genericBlePollingClient.DiscoverDevicesAsync(definition, timeout, cancellationToken, returnOnFirstMatch);
            logger.LogInformation(
                "BLE scan completed. DefinitionFilterApplied={DefinitionFilterApplied}, ResultCount={ResultCount}, ReturnOnFirstMatch={ReturnOnFirstMatch}.",
                definition is not null,
                devices.Count,
                returnOnFirstMatch);
            return Ok(new { devices });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("BLE scan request cancelled by caller.");
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "BLE scan failed. HasDefinitionFilter={HasDefinitionFilter}.", !string.IsNullOrWhiteSpace(definitionId));
            return Ok(new { devices = Array.Empty<object>(), error = ex.Message });
        }
    }

    [HttpPost("{deviceId}/start")]
    public async Task<IActionResult> StartDevice(string deviceId, CancellationToken cancellationToken)
    {
        var allDevices = deviceConfigStore.GetDevices();
        var device = allDevices.FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
        {
            logger.LogWarning("Start requested for an unknown configured device.");
            return NotFound(new { message = $"Device '{deviceId}' not found in configuration." });
        }

        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
        {
            logger.LogWarning("Start requested for a device whose definition could not be loaded.");
            return BadRequest(new { message = $"Device definition '{device.DefinitionId}' not found." });
        }

        logger.LogInformation(
            "Starting configured device polling. HasTransportTarget={HasTransportTarget}.",
            !string.IsNullOrWhiteSpace(device.TransportPortName));

        if (!pollingClientDispatcher.IsDefinitionSupported(definition))
        {
            var supportMessage = pollingClientDispatcher.GetUnsupportedDefinitionMessage(definition)
                ?? "Device definition is not supported.";
            logger.LogWarning("Start rejected because the configured transport is unsupported.");
            return Ok(new
            {
                deviceId,
                started = false,
                outcome = "UnsupportedTransport",
                error = supportMessage,
                message = supportMessage
            });
        }

        if (!device.Enabled)
        {
            var updatedDevices = allDevices.Select(d =>
                string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase)
                    ? new DeviceConfiguration
                    {
                        DeviceId = d.DeviceId, DisplayName = d.DisplayName,
                        DefinitionId = d.DefinitionId, TransportPortName = d.TransportPortName,
                        BleSettingsPin = d.BleSettingsPin,
                        Address = d.Address, IsMaster = d.IsMaster,
                        PollIntervalMilliseconds = d.PollIntervalMilliseconds, Enabled = true,
                        CellVoltageSmoothingFactor = d.CellVoltageSmoothingFactor,
                        CellVoltageSmoothingBreakoutMillivolts = d.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecision = d.DisplayPrecision,
                        DefinitionVersion = d.DefinitionVersion,
                        DefinitionJson = d.DefinitionJson,
                        DefinitionHash = d.DefinitionHash
                    }
                    : d).ToList();

            allDevices = await deviceConfigStore.SaveDevicesAsync(updatedDevices, cancellationToken);
            device = allDevices.First(d => string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
        }

        // Start only the targeted device (not all enabled devices)
        await orchestrator.EnsureDeviceRunningAsync(device, cancellationToken);
        logger.LogInformation("Start configuration applied; waiting for initial poll result.");

        // Wait for the first poll result (up to ~8 seconds)
        const int maxWaitMs = 8000;
        const int pollIntervalMs = 200;
        var waited = 0;
        string? lastObservedOutcome = null;
        string? lastObservedError = null;

        while (waited < maxWaitMs)
        {
            await Task.Delay(pollIntervalMs, cancellationToken);
            waited += pollIntervalMs;

            var state = stateStore.GetDeviceState(deviceId);
            if (state is not null && IsTerminalStartOutcome(state.LastOutcome))
            {
                var error = GetStartOutcomeError(state.LastOutcome, state.LastError);

                if (IsSuccessfulStartOutcome(state.LastOutcome))
                {
                    logger.LogInformation("Initial poll succeeded after {ElapsedMs} ms.", waited);

                    return Ok(new
                    {
                        deviceId,
                        started = true,
                        outcome = state.LastOutcome,
                        error,
                        message = BuildStartOutcomeMessage(state.LastOutcome, error)
                    });
                }

                lastObservedOutcome = state.LastOutcome;
                lastObservedError = error;

                logger.LogDebug(
                    "Initial poll attempt did not succeed. HasOutcome={HasOutcome}, HasError={HasError}, ElapsedMs={ElapsedMs}. Waiting for successful poll within timeout.",
                    !string.IsNullOrWhiteSpace(state.LastOutcome),
                    !string.IsNullOrWhiteSpace(error),
                    waited);
            }
        }

        logger.LogWarning(
            "Device start timed out waiting for successful initial poll result after {ElapsedMs} ms. HasOutcome={HasOutcome}, HasError={HasError}.",
            waited,
            !string.IsNullOrWhiteSpace(lastObservedOutcome),
            !string.IsNullOrWhiteSpace(lastObservedError));
        return Ok(new
        {
            deviceId,
            started = true,
            outcome = lastObservedOutcome ?? "Timeout",
            error = lastObservedError ?? "No poll result within timeout.",
            message = BuildStartTimeoutMessage(lastObservedOutcome, lastObservedError)
        });
    }

    [HttpPost("{deviceId}/stop")]
    public async Task<IActionResult> StopDevice(string deviceId, CancellationToken cancellationToken)
    {
        var allDevices = deviceConfigStore.GetDevices();
        var device = allDevices.FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
        {
            logger.LogWarning("Stop requested for an unknown configured device.");
            return NotFound(new { message = $"Device '{deviceId}' not found in configuration." });
        }

        if (device.Enabled)
        {
            var updatedDevices = allDevices.Select(d =>
                string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase)
                    ? new DeviceConfiguration
                    {
                        DeviceId = d.DeviceId, DisplayName = d.DisplayName,
                        DefinitionId = d.DefinitionId, TransportPortName = d.TransportPortName,
                        BleSettingsPin = d.BleSettingsPin,
                        Address = d.Address, IsMaster = d.IsMaster,
                        PollIntervalMilliseconds = d.PollIntervalMilliseconds, Enabled = false,
                        CellVoltageSmoothingFactor = d.CellVoltageSmoothingFactor,
                        CellVoltageSmoothingBreakoutMillivolts = d.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecision = d.DisplayPrecision,
                        DefinitionVersion = d.DefinitionVersion,
                        DefinitionJson = d.DefinitionJson,
                        DefinitionHash = d.DefinitionHash
                    }
                    : d).ToList();

            allDevices = await deviceConfigStore.SaveDevicesAsync(updatedDevices, cancellationToken);
        }

        // Apply using the in-memory device list (avoids config file-watcher race)
        await orchestrator.ApplyConfigurationAsync(allDevices, cancellationToken);
        logger.LogInformation("Stopped configured device.");

        return Ok(new { deviceId, stopped = true, message = "Device stopped." });
    }

    internal static bool IsTerminalStartOutcome(string? outcome)
        => !string.IsNullOrWhiteSpace(outcome) &&
           !string.Equals(outcome, "NotStarted", StringComparison.OrdinalIgnoreCase) &&
           !string.Equals(outcome, "Started", StringComparison.OrdinalIgnoreCase);

    internal static bool IsSuccessfulStartOutcome(string? outcome)
        => string.Equals(outcome, "Succeeded", StringComparison.OrdinalIgnoreCase);

    internal static string? GetStartOutcomeError(string? outcome, string? lastError)
    {
        if (IsSuccessfulStartOutcome(outcome))
            return null;

        return string.IsNullOrWhiteSpace(lastError)
            ? "The first poll did not complete successfully."
            : lastError.Trim();
    }

    internal static string BuildStartOutcomeMessage(string? outcome, string? lastError)
        => IsSuccessfulStartOutcome(outcome)
            ? "Device started and responding."
            : $"Device started but first poll failed: {GetStartOutcomeError(outcome, lastError)}";

    internal static string BuildStartTimeoutMessage(string? outcome, string? lastError)
        => IsTerminalStartOutcome(outcome)
            ? $"Device started, but no successful poll completed within 8 seconds. Last error: {GetStartOutcomeError(outcome, lastError)}"
            : "Device started but no response received within 8 seconds. Check serial port and address.";

}

public sealed record WriteParameterRequest(uint RawValue);
