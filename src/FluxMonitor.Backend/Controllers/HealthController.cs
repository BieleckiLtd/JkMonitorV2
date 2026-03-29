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

[ApiController]
[Route("api/system/clock")]
public sealed class SystemClockController : ControllerBase
{
    [HttpGet]
    public IActionResult Get()
    {
        var now = DateTimeOffset.Now;
        return Ok(new DeviceClockSnapshot(
            now.ToString("yyyy-MM-dd'T'HH:mm:ss.fff"),
            TimeZoneInfo.Local.Id,
            (int)now.Offset.TotalMinutes));
    }
}

public sealed record DeviceClockSnapshot(
    string LocalDateTime,
    string TimeZoneId,
    int UtcOffsetMinutes);
