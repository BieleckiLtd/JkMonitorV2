using JkMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace JkMonitor.Backend.Controllers;

[ApiController]
[Route("api/devices")]
public sealed class DevicesController(IHostEnvironment environment, DeviceStateStore stateStore) : ControllerBase
{
    [HttpGet("current")]
    public IActionResult GetCurrent()
    {
        var status = stateStore.GetStatus(environment.EnvironmentName);
        return Ok(status.Devices);
    }
}
