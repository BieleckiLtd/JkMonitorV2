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
    JkRs485PollingClient rs485PollingClient,
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

        var profile = _configuration.DeviceProfiles.FirstOrDefault(p =>
            string.Equals(p.ProfileId, device.ProfileId, StringComparison.OrdinalIgnoreCase));

        if (profile is null)
            return BadRequest(new { message = $"Profile '{device.ProfileId}' not found." });

        try
        {
            var result = await rs485PollingClient.WriteConfigRegisterAsync(
                device, profile, parameterKey, request.RawValue, cancellationToken);

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
