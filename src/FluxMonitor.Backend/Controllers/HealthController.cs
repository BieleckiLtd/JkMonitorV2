using System.Text.Json;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/health")]
public sealed class HealthController(
    IHostEnvironment environment,
    DeviceStateStore stateStore,
    RuntimeStatusBroadcaster runtimeStatusBroadcaster) : ControllerBase
{
    private static readonly JsonSerializerOptions RuntimeStatusStreamJsonOptions = new(JsonSerializerDefaults.Web);

    [HttpGet]
    public IActionResult Get()
    {
        var status = stateStore.GetStatus(environment.EnvironmentName);
        return Ok(status);
    }

    [HttpGet("stream")]
    public async Task GetStream(CancellationToken cancellationToken)
    {
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");
        Response.ContentType = "text/event-stream";

        await using var subscription = runtimeStatusBroadcaster.Subscribe(stateStore.GetStatus(environment.EnvironmentName));

        try
        {
            await foreach (var status in subscription.Reader.ReadAllAsync(cancellationToken))
            {
                var payload = SerializeRuntimeStatusStream(status);
                await Response.WriteAsync($"data: {payload}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The client disconnected.
        }
    }

    internal static string SerializeRuntimeStatusStream(MonitorRuntimeStatus status)
    {
        return JsonSerializer.Serialize(new RuntimeStatusStreamEnvelope
        {
            Status = status
        }, RuntimeStatusStreamJsonOptions);
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

internal sealed record RuntimeStatusStreamEnvelope
{
    public required MonitorRuntimeStatus Status { get; init; }
}
