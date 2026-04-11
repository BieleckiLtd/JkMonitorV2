using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/logs")]
public sealed class LogsController(
    ILogQueryService logQueryService,
    ILogMutationService logMutationService) : ControllerBase
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

    [HttpPost("delete")]
    public async Task<ActionResult<DeleteLogsResponse>> Delete(
        [FromBody] DeleteLogsRequest request,
        CancellationToken cancellationToken = default)
    {
        var hasEntryIds = request.EntryIds is { Count: > 0 };

        if (request.DeleteAll == hasEntryIds)
        {
            return BadRequest("Specify either deleteAll=true or one or more entryIds.");
        }

        var deletedCount = request.DeleteAll
            ? await logMutationService.DeleteAllAsync(cancellationToken)
            : await logMutationService.DeleteAsync(request.EntryIds!, cancellationToken);

        return Ok(new DeleteLogsResponse
        {
            DeletedCount = deletedCount
        });
    }

    public sealed record class DeleteLogsRequest
    {
        public bool DeleteAll { get; init; }

        public IReadOnlyList<long>? EntryIds { get; init; }
    }

    public sealed record class DeleteLogsResponse
    {
        public required int DeletedCount { get; init; }
    }
}
