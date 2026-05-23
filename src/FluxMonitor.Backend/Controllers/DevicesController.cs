using System.IO.Ports;
using System.Text.Json;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/devices")]
public sealed class DevicesController(
    DeviceStateStore stateStore,
    DeviceStateBroadcaster deviceStateBroadcaster,
    DeviceOrchestrator orchestrator,
    DeviceConfigStore deviceConfigStore,
    GenericSerialPollingClient genericModbusPollingClient,
    GenericBlePollingClient genericBlePollingClient,
    GenericBleAdvertisementPollingClient genericBleAdvertisementPollingClient,
    PollingClientDispatcher pollingClientDispatcher,
    DeviceDefinitionLoader definitionLoader,
    DeviceDetailInterestStore detailInterestStore,
    ITelemetryRepository telemetryRepository,
    IOptionsMonitor<MonitorConfiguration> configuration,
    PollTrigger pollTrigger,
    ILogger<DevicesController> logger) : ControllerBase
{
    private static readonly JsonSerializerOptions DeviceStateStreamJsonOptions = new(JsonSerializerDefaults.Web);

    private RetentionConfiguration GetCurrentRetention() => configuration.CurrentValue.Storage.Retention;

    [HttpGet("current")]
    public IActionResult GetCurrent(
        [FromQuery] string[] detailDeviceId,
        [FromQuery] bool summary = false,
        [FromQuery] bool enabledOnly = false)
    {
        var devices = stateStore.GetCurrentDevices();
        if (enabledOnly)
        {
            devices = FilterEnabledDeviceStates(devices);
        }

        return Ok(summary || detailDeviceId.Length > 0
            ? ProjectDeviceStates(devices, detailDeviceId)
            : devices);
    }

    [HttpGet("current/stream")]
    public async Task GetCurrentStream(
        [FromQuery] string[] detailDeviceId,
        [FromQuery] bool summary = false,
        [FromQuery] bool enabledOnly = false,
        CancellationToken cancellationToken = default)
    {
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");
        Response.ContentType = "text/event-stream";

        var currentDevices = stateStore.GetCurrentDevices();
        if (enabledOnly)
        {
            currentDevices = FilterEnabledDeviceStates(currentDevices);
        }

        var requestedDetailDeviceIds = NormalizeDetailDeviceIds(detailDeviceId);
        var detailDeviceIds = summary
            ? requestedDetailDeviceIds
            : currentDevices.Select(device => device.DeviceId).ToHashSet(StringComparer.OrdinalIgnoreCase);
        using var detailLease = detailInterestStore.Acquire(detailDeviceIds);
        if (detailDeviceIds.Count > 0)
        {
            pollTrigger.Signal();
        }

        await using var subscription = deviceStateBroadcaster.Subscribe(currentDevices);

        try
        {
            await foreach (var devices in subscription.Reader.ReadAllAsync(cancellationToken))
            {
                var visibleDevices = enabledOnly
                    ? FilterEnabledDeviceStates(devices)
                    : devices;
                var projectedDevices = summary
                    ? ProjectDeviceStates(visibleDevices, detailDeviceIds)
                    : visibleDevices;
                var payload = SerializeCurrentDevicesStream(projectedDevices);
                await Response.WriteAsync($"data: {payload}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The client disconnected.
        }
    }

    [HttpGet("config")]
    public IActionResult GetConfig()
    {
        return Ok(BuildDeviceConfigurationResponse(deviceConfigStore.GetDevices()));
    }

    [HttpGet("summary")]
    public IActionResult GetSummary([FromQuery] bool enabledOnly = false)
    {
        var configuredDevices = deviceConfigStore.GetDevices();
        if (enabledOnly)
        {
            configuredDevices = FilterEnabledDeviceConfigurations(configuredDevices);
        }

        var devices = configuredDevices
            .Select(device => new DeviceSummaryApiModel
            {
                DeviceId = device.DeviceId,
                DisplayName = device.DisplayName,
                SortOrder = device.SortOrder,
                DefinitionId = device.DefinitionId,
                Enabled = device.Enabled
            })
            .ToArray();

        return Ok(new DeviceSummariesResponse { Devices = devices });
    }

    [HttpPut("config")]
    public async Task<ActionResult> SaveConfig(
        [FromBody] SaveDeviceConfigurationsRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            var requestedDevices = request.Devices
                .Select(DeviceConfigurationApiMapper.ToConfiguration)
                .ToArray();
            var existingDevices = deviceConfigStore.GetDevices();
            var existingIds = existingDevices.Select(device => device.DeviceId).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var requestedIds = requestedDevices.Select(device => device.DeviceId).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var added = requestedDevices.Where(device => !existingIds.Contains(device.DeviceId)).Select(device => device.DeviceId).ToArray();
            var removed = existingDevices.Where(device => !requestedIds.Contains(device.DeviceId)).Select(device => device.DeviceId).ToArray();

            logger.LogInformation(
                "Saving device configuration. RequestedCount={RequestedCount}, Added={AddedCount}, Removed={RemovedCount}.",
                requestedDevices.Length,
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

            var devices = await deviceConfigStore.SaveDevicesAsync(requestedDevices, cancellationToken);

            // Apply live — starts/stops device polling loops without restart
            await orchestrator.ApplyConfigurationAsync(devices, cancellationToken);
            logger.LogInformation("Device configuration applied successfully. ActiveDeviceCount={DeviceCount}.", devices.Count);

            return Ok(BuildDeviceConfigurationResponse(devices));
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
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use 1s, 1m, or {persistedResolution}. Legacy 5m and 1h inputs are accepted as persisted-history aliases." });

        if (!TimescaleTelemetryRepository.TryParseBucketValueKind(bucketView, out var bucketValueKind))
            return BadRequest(new { message = $"Invalid bucket view '{bucketView}'. Use avg, min, max, or last." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? GetDefaultHistoryFrom(resolution, toValue);

        var normalizedResolution = NormalizeHistoryResolution(resolution, persistedResolution);
        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));
        if (device is null)
        {
            return Ok(new
            {
                deviceId,
                resolution = normalizedResolution,
                bucketView = TimescaleTelemetryRepository.FormatBucketValueKind(bucketValueKind),
                from = fromValue,
                to = toValue,
                entities = Array.Empty<string>(),
                points = Array.Empty<object>()
            });
        }

        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
        {
            return BadRequest(new { message = $"Device definition '{device.DefinitionId}' not found." });
        }

        var requestedEntities = definition.Storage?.TimeSeries
            .Select(mapping => mapping.Entity)
            .Where(entity => !string.IsNullOrWhiteSpace(entity))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray() ?? [];

        IReadOnlyList<SeriesHistoryDataPoint> seriesPoints = requestedEntities.Length == 0
            ? []
            : await telemetryRepository.QuerySeriesHistoryAsync(
                deviceId,
                requestedEntities,
                normalizedResolution,
                bucketValueKind,
                fromValue,
                toValue,
                cancellationToken);

        var points = seriesPoints.Select(point =>
        {
            var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase)
            {
                ["timestamp"] = point.Timestamp
            };
            foreach (var value in point.Values)
            {
                row[value.Key] = value.Value;
            }

            return row;
        }).ToArray();

        return Ok(new
        {
            deviceId,
            resolution = normalizedResolution,
            bucketView = TimescaleTelemetryRepository.FormatBucketValueKind(bucketValueKind),
            from = fromValue,
            to = toValue,
            entities = requestedEntities,
            points
        });
    }

    [HttpGet("{deviceId}/history/series")]
    public async Task<IActionResult> GetSeriesHistory(
        string deviceId,
        [FromQuery(Name = "entity")] string[] entities,
        [FromQuery] string resolution = "5m",
        [FromQuery] string bucketView = "avg",
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        CancellationToken cancellationToken = default)
    {
        var persistedResolution = TimescaleTelemetryRepository.GetPersistedResolution(GetCurrentRetention().PersistedBucketMinutes);
        var allowed = new HashSet<string>(StringComparer.Ordinal) { "1s", "1m", "5m", "1h", persistedResolution };
        if (!allowed.Contains(resolution))
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use 1s, 1m, or {persistedResolution}. Legacy 5m and 1h inputs are accepted as persisted-history aliases." });

        if (!TimescaleTelemetryRepository.TryParseBucketValueKind(bucketView, out var bucketValueKind))
            return BadRequest(new { message = $"Invalid bucket view '{bucketView}'. Use avg, min, max, or last." });

        var requestedEntities = entities
            .Where(entity => !string.IsNullOrWhiteSpace(entity))
            .Select(entity => entity.Trim())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        if (requestedEntities.Length == 0)
            return BadRequest(new { message = "Specify at least one entity query value." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? GetDefaultHistoryFrom(resolution, toValue);
        var normalizedResolution = NormalizeHistoryResolution(resolution, persistedResolution);
        var points = await telemetryRepository.QuerySeriesHistoryAsync(
            deviceId,
            requestedEntities,
            normalizedResolution,
            bucketValueKind,
            fromValue,
            toValue,
            cancellationToken);

        return Ok(new
        {
            deviceId,
            resolution = normalizedResolution,
            bucketView = TimescaleTelemetryRepository.FormatBucketValueKind(bucketValueKind),
            from = fromValue,
            to = toValue,
            entities = requestedEntities,
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
            return BadRequest(new { message = $"Invalid resolution '{resolution}'. Use 1s, 1m, or {persistedResolution}. Legacy 5m and 1h inputs are accepted as persisted-history aliases." });

        if (!TimescaleTelemetryRepository.TryParseBucketValueKind(bucketView, out var bucketValueKind))
            return BadRequest(new { message = $"Invalid bucket view '{bucketView}'. Use avg, min, max, or last." });

        var toValue = to ?? DateTimeOffset.UtcNow;
        var fromValue = from ?? GetDefaultHistoryFrom(resolution, toValue);

        var normalizedResolution = NormalizeHistoryResolution(resolution, persistedResolution);
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

            var blockedWriteReason = GetProtectedWriteBlockReason(
                definition,
                parameterKey,
                stateStore.GetDeviceState(deviceId)?.LatestTelemetry);
            if (blockedWriteReason is not null)
                return BadRequest(new { message = blockedWriteReason });

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

    [HttpPost("{deviceId}/parameters/batch")]
    public async Task<IActionResult> WriteParametersBatch(
        string deviceId,
        [FromBody] BatchWriteParametersRequest request,
        CancellationToken cancellationToken)
    {
        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
            return NotFound(new { message = $"Device '{deviceId}' not found." });

        if (request.Parameters is null || request.Parameters.Count == 0)
            return BadRequest(new { message = "Specify at least one parameter write." });

        try
        {
            if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
                return BadRequest(new { message = $"Device definition '{device.DefinitionId}' not found." });

            var latestTelemetry = stateStore.GetDeviceState(deviceId)?.LatestTelemetry;
            foreach (var parameter in request.Parameters)
            {
                var blockedWriteReason = GetProtectedWriteBlockReason(
                    definition,
                    parameter.ParameterKey,
                    latestTelemetry);
                if (blockedWriteReason is not null)
                    return BadRequest(new { message = blockedWriteReason });
            }

            IReadOnlyList<EntityWriteResult> results;
            if (string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
            {
                var bleResults = new List<EntityWriteResult>(request.Parameters.Count);
                foreach (var parameter in request.Parameters)
                {
                    var result = await genericBlePollingClient.WriteEntityAsync(
                        device,
                        definition,
                        parameter.ParameterKey,
                        parameter.RawValue,
                        cancellationToken);
                    bleResults.Add(new EntityWriteResult(
                        parameter.ParameterKey,
                        result.Success,
                        result.WrittenValue,
                        result.ReadBackValue,
                        result.Error));
                }

                results = bleResults;
            }
            else
            {
                results = await genericModbusPollingClient.WriteEntitiesAsync(
                    device,
                    definition,
                    request.Parameters.Select(parameter => new EntityWriteRequest(parameter.ParameterKey, parameter.RawValue)).ToArray(),
                    cancellationToken);
            }

            pollTrigger.Signal();
            return Ok(new
            {
                success = results.All(result => result.Success),
                results = results.Select(result => new
                {
                    parameterKey = result.EntityId,
                    success = result.Success,
                    writtenValue = result.WrittenValue,
                    readBackValue = result.ReadBackValue,
                    error = result.Error
                }).ToArray()
            });
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
            logger.LogError(ex, "Batch parameter write failed for a configured device.");
            return StatusCode(500, new { message = "Failed to write parameters." });
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

            var devices = definition is not null &&
                          string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase)
                ? await genericBleAdvertisementPollingClient.DiscoverDevicesAsync(definition, timeout, cancellationToken)
                : await genericBlePollingClient.DiscoverDevicesAsync(definition, timeout, cancellationToken, returnOnFirstMatch);

            if (definition is not null)
            {
                devices = devices
                    .Where(device => device.IsDefinitionVerified)
                    .ToArray();
            }

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
            return Ok(new { devices = Array.Empty<object>(), error = BluetoothFailureHints.Describe(ex) });
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
                        SortOrder = d.SortOrder,
                        DefinitionId = d.DefinitionId, TransportPortName = d.TransportPortName,
                        BleSettingsPin = d.BleSettingsPin,
                        HttpUsername = d.HttpUsername,
                        HttpPassword = d.HttpPassword,
                        Address = d.Address, IsMaster = d.IsMaster,
                        PollIntervalMilliseconds = d.PollIntervalMilliseconds, Enabled = true,
                        CellVoltageSmoothingFactor = d.CellVoltageSmoothingFactor,
                        CellVoltageSmoothingBreakoutMillivolts = d.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecision = d.DisplayPrecision,
                        TemperatureUnit = d.TemperatureUnit,
                        HasDefinitionOverride = d.HasDefinitionOverride,
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
        if (IsPassiveAdvertisementDefinition(definition))
        {
            logger.LogInformation("Start configuration applied; passive BLE device is now listening for broadcast updates.");
            var passiveState = stateStore.GetDeviceState(deviceId);
            var passiveOutcome = passiveState?.LastOutcome ?? "Listening";

            return Ok(new
            {
                deviceId,
                started = true,
                outcome = passiveOutcome,
                error = GetStartOutcomeError(passiveOutcome, passiveState?.LastError),
                message = BuildStartOutcomeMessage(passiveOutcome, passiveState?.LastError)
            });
        }

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
                        SortOrder = d.SortOrder,
                        DefinitionId = d.DefinitionId, TransportPortName = d.TransportPortName,
                        BleSettingsPin = d.BleSettingsPin,
                        HttpUsername = d.HttpUsername,
                        HttpPassword = d.HttpPassword,
                        Address = d.Address, IsMaster = d.IsMaster,
                        PollIntervalMilliseconds = d.PollIntervalMilliseconds, Enabled = false,
                        CellVoltageSmoothingFactor = d.CellVoltageSmoothingFactor,
                        CellVoltageSmoothingBreakoutMillivolts = d.CellVoltageSmoothingBreakoutMillivolts,
                        DisplayPrecision = d.DisplayPrecision,
                        TemperatureUnit = d.TemperatureUnit,
                        HasDefinitionOverride = d.HasDefinitionOverride,
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
        => string.Equals(outcome, "Succeeded", StringComparison.OrdinalIgnoreCase) ||
           string.Equals(outcome, "Listening", StringComparison.OrdinalIgnoreCase);

    internal static string NormalizeHistoryResolution(string requestedResolution, string persistedResolution)
        => string.Equals(requestedResolution, "1s", StringComparison.Ordinal) ||
           string.Equals(requestedResolution, "1m", StringComparison.Ordinal)
            ? requestedResolution
            : persistedResolution;

    internal static DateTimeOffset GetDefaultHistoryFrom(string resolution, DateTimeOffset toValue)
    {
        if (string.Equals(resolution, "1s", StringComparison.Ordinal))
        {
            return toValue.AddMinutes(-10);
        }

        if (string.Equals(resolution, "1m", StringComparison.Ordinal))
        {
            return toValue.AddHours(-1);
        }

        if (string.Equals(resolution, "1h", StringComparison.Ordinal))
        {
            return toValue.AddDays(-7);
        }

        return toValue.AddDays(-1);
    }

    internal static string? GetStartOutcomeError(string? outcome, string? lastError)
    {
        if (IsSuccessfulStartOutcome(outcome))
            return null;

        return string.IsNullOrWhiteSpace(lastError)
            ? "The first poll did not complete successfully."
            : BluetoothFailureHints.Describe(lastError);
    }

    internal static string BuildStartOutcomeMessage(string? outcome, string? lastError)
    {
        if (string.Equals(outcome, "Listening", StringComparison.OrdinalIgnoreCase))
            return "Device started and listening for broadcast updates.";

        return IsSuccessfulStartOutcome(outcome)
            ? "Device started and responding."
            : $"Device started but first poll failed: {GetStartOutcomeError(outcome, lastError)}";
    }

    internal static string BuildStartTimeoutMessage(string? outcome, string? lastError)
        => IsTerminalStartOutcome(outcome)
            ? $"Device started, but no successful poll completed within 8 seconds. Last error: {GetStartOutcomeError(outcome, lastError)}"
            : "Device started but no response received within 8 seconds. Check serial port and address.";

    internal static string? GetProtectedWriteBlockReason(
        DeviceDefinition definition,
        string parameterKey,
        DeviceTelemetrySnapshot? latestTelemetry)
    {
        var entity = definition.Entities.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, parameterKey, StringComparison.OrdinalIgnoreCase));
        var guard = entity?.Write?.Guard;
        if (guard is null)
            return null;

        var message = string.IsNullOrWhiteSpace(guard.Message)
            ? "Write is blocked by the current device state."
            : guard.Message;

        if (guard.AnyNonZero.Any(entityId => HasNonZeroEntityValue(latestTelemetry, entityId)))
            return message;

        if (!string.IsNullOrWhiteSpace(guard.BlockWhen))
        {
            var result = new ExpressionEvaluator().Evaluate(
                guard.BlockWhen,
                BuildNumericValueMap(latestTelemetry),
                latestTelemetry?.Cells);
            if (result.HasValue && result.Value != 0)
                return message;
        }

        return null;
    }

    private static bool IsPassiveAdvertisementDefinition(Contracts.DeviceDefinition.DeviceDefinition definition)
    {
        return string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase) &&
               string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase);
    }

    private static bool HasNonZeroEntityValue(DeviceTelemetrySnapshot? latestTelemetry, string entityId)
    {
        if (latestTelemetry is null)
            return false;

        if (latestTelemetry.NumericValues.TryGetValue(entityId, out var numericValue) &&
            numericValue.HasValue)
        {
            return numericValue.Value != 0;
        }

        var parameter = latestTelemetry.Parameters.FirstOrDefault(candidate =>
            string.Equals(candidate.Key, entityId, StringComparison.OrdinalIgnoreCase));
        return parameter is not null && GetParameterNumericValue(parameter) is { } parameterValue && parameterValue != 0;
    }

    private static Dictionary<string, decimal?> BuildNumericValueMap(DeviceTelemetrySnapshot? latestTelemetry)
    {
        var values = new Dictionary<string, decimal?>(StringComparer.OrdinalIgnoreCase);
        if (latestTelemetry is null)
            return values;

        foreach (var entry in latestTelemetry.NumericValues)
        {
            values[entry.Key] = entry.Value;
        }

        foreach (var parameter in latestTelemetry.Parameters)
        {
            if (!values.ContainsKey(parameter.Key) && GetParameterNumericValue(parameter) is { } value)
                values[parameter.Key] = value;
        }

        return values;
    }

    private static decimal? GetParameterNumericValue(DeviceParameter parameter)
    {
        if (parameter.NumericValue.HasValue)
            return parameter.NumericValue.Value;
        if (parameter.BooleanValue.HasValue)
            return parameter.BooleanValue.Value ? 1m : 0m;
        if (parameter.RawValue.HasValue)
            return parameter.RawValue.Value;
        return null;
    }

    private IReadOnlyList<DeviceRuntimeState> ProjectDeviceStates(
        IReadOnlyList<DeviceRuntimeState> devices,
        IEnumerable<string> detailDeviceIds)
    {
        var detailSet = NormalizeDetailDeviceIds(detailDeviceIds);
        if (detailSet.Count == 0)
        {
            return devices.Select(ProjectCollapsedDeviceState).ToArray();
        }

        return devices
            .Select(device => detailSet.Contains(device.DeviceId)
                ? device
                : ProjectCollapsedDeviceState(device))
            .ToArray();
    }

    private DeviceRuntimeState ProjectCollapsedDeviceState(DeviceRuntimeState device)
    {
        if (device.LatestTelemetry is null)
            return device;

        if (!definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
            return device with { LatestTelemetry = ProjectCollapsedTelemetryWithoutDefinition(device.LatestTelemetry) };

        return device with { LatestTelemetry = ProjectCollapsedTelemetry(device.LatestTelemetry, definition) };
    }

    private static DeviceTelemetrySnapshot ProjectCollapsedTelemetry(
        DeviceTelemetrySnapshot telemetry,
        DeviceDefinition definition)
    {
        var summaryEntityIds = GetSummaryEntityIds(definition);
        var parameters = telemetry.Parameters
            .Where(parameter => summaryEntityIds.Contains(parameter.Key) && !parameter.IsWritable)
            .ToArray();
        var numericValues = telemetry.NumericValues
            .Where(value => summaryEntityIds.Contains(value.Key))
            .ToDictionary(value => value.Key, value => value.Value, StringComparer.OrdinalIgnoreCase);

        return telemetry with
        {
            Cells = [],
            Parameters = parameters,
            NumericValues = numericValues
        };
    }

    private static DeviceTelemetrySnapshot ProjectCollapsedTelemetryWithoutDefinition(DeviceTelemetrySnapshot telemetry)
    {
        var parameters = telemetry.Parameters
            .Where(parameter => !parameter.IsWritable)
            .ToArray();
        var parameterIds = parameters
            .Select(parameter => parameter.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var numericValues = telemetry.NumericValues
            .Where(value => parameterIds.Contains(value.Key))
            .ToDictionary(value => value.Key, value => value.Value, StringComparer.OrdinalIgnoreCase);

        return telemetry with
        {
            Cells = [],
            Parameters = parameters,
            NumericValues = numericValues
        };
    }

    private static HashSet<string> GetSummaryEntityIds(DeviceDefinition definition)
    {
        var fastestIntervalMs = definition.DataSources
            .Select(bank => definition.PollGroups.GetValueOrDefault(bank.PollGroup)?.IntervalMs ?? 1000)
            .Where(intervalMs => intervalMs > 0)
            .DefaultIfEmpty(1000)
            .Min();
        var summaryBankIds = definition.DataSources
            .Where(bank =>
            {
                var intervalMs = definition.PollGroups.GetValueOrDefault(bank.PollGroup)?.IntervalMs ?? 1000;
                return intervalMs > 0 && intervalMs <= fastestIntervalMs;
            })
            .Select(bank => bank.Id)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var ids = definition.Entities
            .Where(entity => summaryBankIds.Contains(entity.Source.Bank))
            .Select(entity => entity.Id)
            .Concat(definition.ComputedEntities.Select(entity => entity.Id))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrWhiteSpace(definition.Alarms?.Source))
        {
            ids.Add(definition.Alarms.Source);
        }

        return ids;
    }

    private static HashSet<string> NormalizeDetailDeviceIds(IEnumerable<string> detailDeviceIds)
        => detailDeviceIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Select(id => id.Trim())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private DeviceConfigurationsResponse BuildDeviceConfigurationResponse(IReadOnlyList<DeviceConfiguration> devices)
    {
        var mappedDevices = devices
            .Select(device =>
            {
                var persistedId = deviceConfigStore.TryGetPersistedDeviceId(device.DeviceId, out var id)
                    ? id
                    : (int?)null;
                device.TryResolveDefinition(definitionLoader, out var definition);
                return DeviceConfigurationApiMapper.ToApiModel(device, persistedId, definition);
            })
            .ToArray();

        return new DeviceConfigurationsResponse
        {
            Devices = mappedDevices,
            RememberedDeviceIds = deviceConfigStore.GetRememberedDeviceIds()
        };
    }

    internal static string SerializeCurrentDevicesStream(IReadOnlyList<DeviceRuntimeState> devices)
    {
        return JsonSerializer.Serialize(new DeviceStateStreamEnvelope
        {
            Devices = devices
        }, DeviceStateStreamJsonOptions);
    }

    internal static IReadOnlyList<DeviceRuntimeState> FilterEnabledDeviceStates(IEnumerable<DeviceRuntimeState> devices)
        => devices
            .Where(device => device.Enabled)
            .ToArray();

    internal static IReadOnlyList<DeviceConfiguration> FilterEnabledDeviceConfigurations(IEnumerable<DeviceConfiguration> devices)
        => devices
            .Where(device => device.Enabled)
            .ToArray();

}

public sealed record WriteParameterRequest(uint RawValue);

public sealed record BatchWriteParametersRequest(IReadOnlyList<BatchWriteParameterRequest> Parameters);

public sealed record BatchWriteParameterRequest(string ParameterKey, uint RawValue);

internal sealed record DeviceStateStreamEnvelope
{
    public required IReadOnlyList<DeviceRuntimeState> Devices { get; init; }
}
