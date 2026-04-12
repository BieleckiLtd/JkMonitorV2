using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/notifications")]
public sealed class NotificationsController(
    NotificationConfigStore configStore,
    NotificationDispatcher dispatcher,
    NotificationEvaluator evaluator,
    DeviceStateStore deviceStateStore,
    DeviceConfigStore deviceConfigStore,
    DeviceDefinitionLoader definitionLoader,
    IHostEnvironment environment) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<NotificationConfigResponse>> GetConfig(CancellationToken cancellationToken)
    {
        await configStore.InitializeAsync(cancellationToken);
        var config = configStore.GetConfig();
        return Ok(new NotificationConfigResponse
        {
            Channels = config.Channels,
            Rules = config.Rules
        });
    }

    [HttpPut("channels")]
    public async Task<ActionResult<NotificationConfigResponse>> SaveChannels(
        [FromBody] SaveNotificationChannelsRequest request,
        CancellationToken cancellationToken)
    {
        await configStore.SaveChannelsAsync(request.Channels, cancellationToken);
        var config = configStore.GetConfig();
        return Ok(new NotificationConfigResponse
        {
            Channels = config.Channels,
            Rules = config.Rules
        });
    }

    [HttpPut("rules")]
    public async Task<ActionResult<NotificationConfigResponse>> SaveRules(
        [FromBody] SaveNotificationRulesRequest request,
        CancellationToken cancellationToken)
    {
        await configStore.SaveRulesAsync(request.Rules, cancellationToken);
        var config = configStore.GetConfig();
        return Ok(new NotificationConfigResponse
        {
            Channels = config.Channels,
            Rules = config.Rules
        });
    }

    [HttpPost("channels/test")]
    public async Task<ActionResult<TestChannelResponse>> TestChannel(
        [FromBody] TestChannelRequest request,
        CancellationToken cancellationToken)
    {
        var result = await dispatcher.TestChannelAsync(request.ChannelId, cancellationToken);
        return Ok(result);
    }

    [HttpGet("log")]
    public ActionResult<IReadOnlyList<NotificationLogEntry>> GetLog()
    {
        return Ok(evaluator.GetRecentLog());
    }

    [HttpGet("entities")]
    public IActionResult GetAvailableEntities([FromQuery] string? deviceId = null)
    {
        if (!string.IsNullOrWhiteSpace(deviceId))
        {
            var definition = ResolveDefinitionForDevice(deviceId);
            if (definition is not null)
                return Ok(BuildEntityList(definition));
        }

        // No device specified – return union of entities across all configured devices.
        var devices = deviceConfigStore.GetDevices();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var entities = new List<object>();

        foreach (var device in devices)
        {
            if (!device.TryResolveDefinition(definitionLoader, out var def) || def is null)
                continue;

            foreach (var entry in BuildEntityList(def))
            {
                if (seen.Add(entry.id))
                    entities.Add(entry);
            }
        }

        return Ok(entities);
    }

    [HttpGet("devices")]
    public IActionResult GetAvailableDevices()
    {
        var status = deviceStateStore.GetStatus(environment.EnvironmentName);
        var devices = status.Devices.Select(d =>
        {
            var definition = ResolveDefinitionForDevice(d.DeviceId);
            return new
            {
                id = d.DeviceId,
                name = d.DisplayName,
                entities = definition is not null ? BuildEntityList(definition) : [],
            };
        }).ToArray();
        return Ok(devices);
    }

    private Contracts.DeviceDefinition.DeviceDefinition? ResolveDefinitionForDevice(string deviceId)
    {
        var device = deviceConfigStore.GetDevices()
            .FirstOrDefault(d => string.Equals(d.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
            return null;

        return device.TryResolveDefinition(definitionLoader, out var definition) ? definition : null;
    }

    private static List<EntityListItem> BuildEntityList(Contracts.DeviceDefinition.DeviceDefinition definition)
    {
        var list = new List<EntityListItem>();

        foreach (var entity in definition.Entities)
        {
            if (entity.Hidden || entity.Type == "cell_array")
                continue;

            list.Add(new EntityListItem(entity.Id, entity.Name, entity.Source.Unit ?? ""));
        }

        foreach (var computed in definition.ComputedEntities)
        {
            if (computed.Hidden)
                continue;

            list.Add(new EntityListItem(computed.Id, computed.Name, computed.Unit ?? ""));
        }

        return list;
    }

    private sealed record EntityListItem(string id, string name, string unit);
}
