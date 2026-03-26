using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/database")]
public sealed class DatabaseController(ITelemetryRepository repository) : ControllerBase
{
    [HttpGet("size")]
    public async Task<IActionResult> GetSize(CancellationToken cancellationToken)
    {
        var info = await repository.GetDatabaseSizeAsync(cancellationToken);
        return Ok(info);
    }

    [HttpGet("export")]
    public async Task Export(CancellationToken cancellationToken)
    {
        Response.ContentType = "application/octet-stream";
        Response.Headers["Content-Disposition"] = "attachment; filename=FluxMonitor-export.csv";
        await repository.ExportAsync(Response.Body, cancellationToken);
    }

    [HttpPost("import")]
    [RequestSizeLimit(500_000_000)]
    public async Task<IActionResult> Import(IFormFile file, CancellationToken cancellationToken)
    {
        if (file == null || file.Length == 0)
        {
            return BadRequest(new { error = "No file provided." });
        }

        await using var stream = file.OpenReadStream();
        await repository.ImportAsync(stream, cancellationToken);
        return Ok(new { message = "Import completed successfully." });
    }
}
