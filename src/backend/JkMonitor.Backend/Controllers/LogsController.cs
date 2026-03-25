using JkMonitor.Backend.Services;
using JkMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;

namespace JkMonitor.Backend.Controllers;

[ApiController]
[Route("api/logs")]
public sealed class LogsController(ILogQueryService logQueryService) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<LogQueryResponse>> Get(
        [FromQuery] string? levels = null,
        [FromQuery] DateTimeOffset? from = null,
        [FromQuery] DateTimeOffset? to = null,
        [FromQuery] string? search = null,
        [FromQuery] int skip = 0,
        [FromQuery] int take = 200,
        CancellationToken cancellationToken = default)
    {
        take = Math.Clamp(take, 1, 1000);
        skip = Math.Max(skip, 0);

        IReadOnlyList<string>? levelList = null;

        if (!string.IsNullOrWhiteSpace(levels))
        {
            levelList = levels.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }

        return Ok(await logQueryService.QueryAsync(levelList, from, to, search, skip, take, cancellationToken));
    }
}
