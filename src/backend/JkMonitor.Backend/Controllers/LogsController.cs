using JkMonitor.Backend.Services;
using JkMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;

namespace JkMonitor.Backend.Controllers;

[ApiController]
[Route("api/logs")]
public sealed class LogsController(InMemoryLogStore logStore) : ControllerBase
{
    [HttpGet]
    public ActionResult<LogQueryResponse> Get(
        [FromQuery] string? levels = null,
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        [FromQuery] string? search = null,
        [FromQuery] int skip = 0,
        [FromQuery] int take = 200)
    {
        take = Math.Clamp(take, 1, 1000);
        skip = Math.Max(skip, 0);

        IReadOnlyList<string>? levelList = null;

        if (!string.IsNullOrWhiteSpace(levels))
        {
            levelList = levels.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }

        return Ok(logStore.Query(levelList, from, to, search, skip, take));
    }
}
