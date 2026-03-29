using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/health")]
public sealed class HealthController(IHostEnvironment environment, DeviceStateStore stateStore) : ControllerBase
{
    [HttpGet]
    public IActionResult Get()
    {
        var status = stateStore.GetStatus(environment.EnvironmentName);
        return Ok(status);
    }
}
