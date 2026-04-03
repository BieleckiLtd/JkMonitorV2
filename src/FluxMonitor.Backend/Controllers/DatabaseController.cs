using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/database")]
public sealed class DatabaseController(
    ITelemetryRepository repository,
    SetupConfigurationService setupConfigurationService,
    DeviceConfigStore deviceConfigStore,
    DeviceOrchestrator deviceOrchestrator) : ControllerBase
{
    [HttpGet("settings")]
    public ActionResult<DatabaseSettingsStateResponse> GetSettings()
    {
        return Ok(setupConfigurationService.GetDatabaseSettings());
    }

    [HttpPost("settings")]
    public ActionResult<SaveDatabaseSettingsResponse> SaveSettings([FromBody] SaveDatabaseSettingsRequest request)
    {
        try
        {
            return Ok(setupConfigurationService.SaveDatabaseSettings(request));
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(new { message = exception.Message });
        }
    }

    [HttpGet("size")]
    public async Task<IActionResult> GetSize(CancellationToken cancellationToken)
    {
        var info = await repository.GetDatabaseSizeAsync(cancellationToken);
        return Ok(info);
    }

    [HttpGet("compression")]
    public async Task<IActionResult> GetCompressionStats(CancellationToken cancellationToken)
    {
        var stats = await repository.GetCompressionStatsAsync(cancellationToken);
        return stats is not null ? Ok(stats) : Ok(new { message = "Compression not available." });
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
        await deviceConfigStore.ReloadAsync(cancellationToken);
        await deviceOrchestrator.ApplyConfigurationAsync(deviceConfigStore.GetDevices(), cancellationToken);
        return Ok(new { message = "Import completed successfully." });
    }
}
