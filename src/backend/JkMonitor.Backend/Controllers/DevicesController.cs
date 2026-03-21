using JkMonitor.Backend.Models;
using JkMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace JkMonitor.Backend.Controllers;

[ApiController]
[Route("api/devices")]
public sealed class DevicesController(
    IHostEnvironment environment,
    DeviceStateStore stateStore,
    SetupConfigurationService setupConfigurationService) : ControllerBase
{
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
}
