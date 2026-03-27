using System.IO.Ports;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/devices")]
public sealed class DevicesController(
    IHostEnvironment environment,
    DeviceStateStore stateStore,
    DeviceOrchestrator orchestrator,
    DeviceConfigStore deviceConfigStore,
    DeviceDatabaseService deviceDatabaseService,
    GenericModbusPollingClient genericPollingClient,
    GenericBlePollingClient genericBlePollingClient,
    PollingClientDispatcher pollingClientDispatcher,
    DeviceDefinitionLoader definitionLoader,
    ITelemetryRepository telemetryRepository,
    PollTrigger pollTrigger,
    ILogger<DevicesController> logger) : ControllerBase
{

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
                logger.LogInformation("Adding device(s): {DeviceIds}.", string.Join(", ", added));
            }

            if (removed.Length > 0)
            {
                logger.LogInformation("Removing device(s): {DeviceIds}.", string.Join(", ", removed));
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
        [FromQuery] string resolution = "1m",
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        CancellationToken cancellationToken = default)
    {
        var allowed = new HashSet<string>(StringComparer.Ordinal) { "1s", "1m", "5m", "1h" };
        if (!allowed.Contains(resolution))
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use: 1s, 1m, 5m, 1h." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? resolution switch
        {
            "1s" => toValue.AddMinutes(-10),
            "1m" => toValue.AddHours(-1),
            "5m" => toValue.AddDays(-1),
            "1h" => toValue.AddDays(-7),
            _ => toValue.AddHours(-1),
        };

        var points = await telemetryRepository.QueryHistoryAsync(deviceId, resolution, fromValue, toValue, cancellationToken);
        return Ok(new { deviceId, resolution, from = fromValue, to = toValue, points });
    }

    [HttpGet("{deviceId}/history/cell/{cellIndex:int}")]
    public async Task<IActionResult> GetCellHistory(
        string deviceId,
        int cellIndex,
        [FromQuery] string resolution = "1m",
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        CancellationToken cancellationToken = default)
    {
        if (cellIndex < 1 || cellIndex > 31)
            return BadRequest(new { message = "Cell index must be between 1 and 31." });

        var allowed = new HashSet<string>(StringComparer.Ordinal) { "1s", "1m", "5m", "1h" };
        if (!allowed.Contains(resolution))
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use: 1s, 1m, 5m, 1h." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? resolution switch
        {
            "1s" => toValue.AddMinutes(-10),
            "1m" => toValue.AddHours(-1),
            "5m" => toValue.AddDays(-1),
            "1h" => toValue.AddDays(-7),
            _ => toValue.AddHours(-1),
        };

        var points = await telemetryRepository.QueryCellHistoryAsync(deviceId, cellIndex, resolution, fromValue, toValue, cancellationToken);
        return Ok(new { deviceId, cellIndex, resolution, from = fromValue, to = toValue, points });
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
            if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
                return BadRequest(new { message = $"Device definition '{device.DefinitionId}' not found." });

            var result = await genericPollingClient.WriteEntityAsync(
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
        catch (InvalidDataException ex)
        {
            return BadRequest(new { message = ex.Message });
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
        CancellationToken cancellationToken = default)
    {
        try
        {
            logger.LogInformation(
                "BLE scan requested. DefinitionId={DefinitionId}, TimeoutMs={TimeoutMs}.",
                string.IsNullOrWhiteSpace(definitionId) ? "<none>" : definitionId.Trim(),
                timeoutMs);

            Contracts.DeviceDefinition.DeviceDefinition? definition = null;
            if (!string.IsNullOrWhiteSpace(definitionId) &&
                (!definitionLoader.TryGet(definitionId.Trim(), out definition) || definition is null))
            {
                logger.LogWarning("BLE scan requested with unknown definition '{DefinitionId}'.", definitionId);
                return Ok(new
                {
                    devices = Array.Empty<object>(),
                    error = $"Device definition '{definitionId}' not found."
                });
            }

            if (definition is not null &&
                !string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
            {
                logger.LogWarning(
                    "BLE scan requested for non-BLE definition '{DefinitionId}' ({TransportType}).",
                    definition.Device.Id,
                    definition.Connection.Transport.Type);
                return Ok(new
                {
                    devices = Array.Empty<object>(),
                    error = $"Device definition '{definition.Device.Id}' does not use BLE transport."
                });
            }

            var timeout = timeoutMs.HasValue
                ? TimeSpan.FromMilliseconds(Math.Clamp(timeoutMs.Value, 1000, 15000))
                : (TimeSpan?)null;

            var devices = await genericBlePollingClient.DiscoverDevicesAsync(definition, timeout, cancellationToken);
            logger.LogInformation(
                "BLE scan completed. DefinitionId={DefinitionId}, ResultCount={ResultCount}.",
                definition?.Device.Id ?? "<none>",
                devices.Count);
            return Ok(new { devices });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            logger.LogInformation("BLE scan request cancelled by caller.");
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "BLE scan failed. DefinitionId={DefinitionId}.", definitionId);
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
            logger.LogWarning("Start requested for unknown device '{DeviceId}'.", deviceId);
            return NotFound(new { message = $"Device '{deviceId}' not found in configuration." });
        }

        if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
        {
            logger.LogWarning(
                "Start requested for device {DeviceId} but definition '{DefinitionId}' could not be loaded.",
                deviceId,
                device.DefinitionId);
            return BadRequest(new { message = $"Device definition '{device.DefinitionId}' not found." });
        }

        logger.LogInformation(
            "Starting device {DeviceId}. DefinitionId={DefinitionId}, TransportType={TransportType}, Target={TransportTarget}.",
            deviceId,
            device.DefinitionId,
            definition.Connection.Transport.Type,
            string.IsNullOrWhiteSpace(device.TransportPortName) ? "<none>" : device.TransportPortName);

        if (!pollingClientDispatcher.IsDefinitionSupported(definition))
        {
            var supportMessage = pollingClientDispatcher.GetUnsupportedDefinitionMessage(definition)
                ?? "Device definition is not supported.";
            logger.LogWarning(
                "Start rejected for device {DeviceId}: unsupported transport. Reason={Reason}",
                deviceId,
                supportMessage);
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
                        DatabaseName = d.DatabaseName,
                        Address = d.Address, IsMaster = d.IsMaster,
                        PollIntervalMilliseconds = d.PollIntervalMilliseconds, Enabled = true,
                        CellVoltageSmoothingFactor = d.CellVoltageSmoothingFactor,
                        CellVoltageSmoothingBreakoutMillivolts = d.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecision = d.DisplayPrecision
                    }
                    : d).ToList();

            allDevices = await deviceConfigStore.SaveDevicesAsync(updatedDevices, cancellationToken);
        }

        // Apply using the in-memory device list (avoids config file-watcher race)
        await orchestrator.ApplyConfigurationAsync(allDevices, cancellationToken);
        logger.LogInformation("Start configuration applied for device {DeviceId}; waiting for initial poll result.", deviceId);

        // Wait for the first poll result (up to ~8 seconds)
        const int maxWaitMs = 8000;
        const int pollIntervalMs = 200;
        var waited = 0;

        while (waited < maxWaitMs)
        {
            await Task.Delay(pollIntervalMs, cancellationToken);
            waited += pollIntervalMs;

            var state = stateStore.GetDeviceState(deviceId);
            if (state is not null && state.LastOutcome is not "NotStarted")
            {
                if (string.Equals(state.LastOutcome, "Succeeded", StringComparison.OrdinalIgnoreCase))
                {
                    logger.LogInformation(
                        "Initial poll succeeded for device {DeviceId} after {ElapsedMs} ms.",
                        deviceId,
                        waited);
                }
                else
                {
                    logger.LogWarning(
                        "Initial poll did not succeed for device {DeviceId}. Outcome={Outcome}, Error={Error}, ElapsedMs={ElapsedMs}.",
                        deviceId,
                        state.LastOutcome,
                        state.LastError,
                        waited);
                }

                return Ok(new
                {
                    deviceId,
                    started = true,
                    outcome = state.LastOutcome,
                    error = state.LastError,
                    message = state.LastOutcome == "Succeeded"
                        ? "Device started and responding."
                        : $"Device started but first poll failed: {state.LastError}"
                });
            }
        }

        logger.LogWarning(
            "Device {DeviceId} start timed out waiting for initial poll result after {ElapsedMs} ms.",
            deviceId,
            waited);
        return Ok(new
        {
            deviceId,
            started = true,
            outcome = "Timeout",
            error = "No poll result within timeout.",
            message = "Device started but no response received within 8 seconds. Check serial port and address."
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
            logger.LogWarning("Stop requested for unknown device '{DeviceId}'.", deviceId);
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
                        DatabaseName = d.DatabaseName,
                        Address = d.Address, IsMaster = d.IsMaster,
                        PollIntervalMilliseconds = d.PollIntervalMilliseconds, Enabled = false,
                        CellVoltageSmoothingFactor = d.CellVoltageSmoothingFactor,
                        CellVoltageSmoothingBreakoutMillivolts = d.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecision = d.DisplayPrecision
                    }
                    : d).ToList();

            allDevices = await deviceConfigStore.SaveDevicesAsync(updatedDevices, cancellationToken);
        }

        // Apply using the in-memory device list (avoids config file-watcher race)
        await orchestrator.ApplyConfigurationAsync(allDevices, cancellationToken);
        logger.LogInformation("Stopped device {DeviceId}.", deviceId);

        return Ok(new { deviceId, stopped = true, message = "Device stopped." });
    }

    [HttpGet("databases")]
    public async Task<IActionResult> ListDatabases(CancellationToken cancellationToken)
    {
        try
        {
            var databases = await deviceDatabaseService.ListDatabasesAsync(cancellationToken);
            return Ok(new { databases });
        }
        catch (Exception ex)
        {
            return Ok(new { databases = Array.Empty<string>(), error = ex.Message });
        }
    }

    [HttpPost("databases/create")]
    public async Task<IActionResult> CreateDatabase(
        [FromBody] CreateDatabaseRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.DatabaseName))
            return BadRequest(new { message = "Database name is required." });

        var result = await deviceDatabaseService.CreateDatabaseAsync(
            request.DatabaseName.Trim(), request.Provider ?? "timescaledb", cancellationToken);

        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("databases/validate")]
    public async Task<IActionResult> ValidateDatabase(
        [FromBody] ValidateDatabaseRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.DatabaseName))
            return BadRequest(new { message = "Database name is required." });

        var result = await deviceDatabaseService.ValidateSchemaAsync(request.DatabaseName.Trim(), cancellationToken);
        return Ok(result);
    }

    [HttpGet("databases/suggest/{deviceId}")]
    public IActionResult SuggestDatabaseName(string deviceId)
    {
        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        Contracts.DeviceDefinition.DeviceDefinition? definition = null;
        var defId = device?.DefinitionId;
        if (!string.IsNullOrEmpty(defId))
            definitionLoader.TryGet(defId, out definition);

        var suggested = deviceDatabaseService.SuggestDatabaseName(deviceId, definition?.Storage?.Database?.DefaultNamePattern);
        var requiresDatabase = definition?.Storage?.Database is not null;
        var provider = definition?.Storage?.Database?.Provider ?? "timescaledb";

        return Ok(new { suggested, requiresDatabase, provider });
    }
}

public sealed record WriteParameterRequest(uint RawValue);
public sealed record CreateDatabaseRequest(string DatabaseName, string? Provider);
public sealed record ValidateDatabaseRequest(string DatabaseName);
