using JkMonitor.Backend.Models;
using JkMonitor.Backend.Services;
using JkMonitor.Contracts.Configuration;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Controllers;

[ApiController]
[Route("api/devices")]
public sealed class DevicesController(
    IHostEnvironment environment,
    DeviceStateStore stateStore,
    SetupConfigurationService setupConfigurationService,
    GenericModbusPollingClient genericPollingClient,
    DeviceDefinitionLoader definitionLoader,
    JkRs485PollingClient rs485PollingClient,
    ITelemetryRepository telemetryRepository,
    PollTrigger pollTrigger,
    IOptions<MonitorConfiguration> configuration) : ControllerBase
{
    private readonly MonitorConfiguration _configuration = configuration.Value;

    [HttpGet("current")]
    public IActionResult GetCurrent()
    {
        var status = stateStore.GetStatus(environment.EnvironmentName);
        return Ok(status.Devices);
    }

    [HttpGet("config")]
    public ActionResult<DeviceConfigurationStateResponse> GetConfig()
    {
        return Ok(setupConfigurationService.GetDeviceConfiguration());
    }

    [HttpPut("config")]
    public ActionResult<DeviceConfigurationStateResponse> SaveConfig([FromBody] SaveDeviceConfigurationRequest request)
    {
        try
        {
            return Ok(setupConfigurationService.SaveDevices(request));
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(new { message = exception.Message });
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
        var device = _configuration.Devices.FirstOrDefault(d =>
            string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
            return NotFound(new { message = $"Device '{deviceId}' not found." });

        try
        {
            WriteRegisterResult result;

            // Prefer definition-driven write when DefinitionId is configured
            if (!string.IsNullOrEmpty(device.DefinitionId) &&
                definitionLoader.TryGet(device.DefinitionId, out var definition) && definition is not null)
            {
                result = await genericPollingClient.WriteEntityAsync(
                    device, definition, parameterKey, request.RawValue, cancellationToken);
            }
            else
            {
                // Fallback to legacy profile-based write
                var profile = _configuration.DeviceProfiles.FirstOrDefault(p =>
                    string.Equals(p.ProfileId, device.ProfileId, StringComparison.OrdinalIgnoreCase));

                if (profile is null)
                    return BadRequest(new { message = $"Profile '{device.ProfileId}' not found." });

                result = await rs485PollingClient.WriteConfigRegisterAsync(
                    device, profile, parameterKey, request.RawValue, cancellationToken);
            }

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
}

public sealed record WriteParameterRequest(uint RawValue);
