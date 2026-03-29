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
    public IActionResult GetAvailableEntities()
    {
        // Return known entity IDs and their friendly names for the rule editor
        var entities = new[]
        {
            new { id = "total_voltage", name = "Total Voltage", unit = "V" },
            new { id = "current", name = "Current", unit = "A" },
            new { id = "power", name = "Power", unit = "W" },
            new { id = "state_of_charge", name = "State of Charge", unit = "%" },
            new { id = "mos_temperature", name = "MOS Temperature", unit = "°C" },
            new { id = "battery_temp_1", name = "Battery Temp 1", unit = "°C" },
            new { id = "battery_temp_2", name = "Battery Temp 2", unit = "°C" },
            new { id = "delta_cell_voltage", name = "Cell Delta", unit = "V" },
            new { id = "min_cell_voltage", name = "Min Cell Voltage", unit = "V" },
            new { id = "max_cell_voltage", name = "Max Cell Voltage", unit = "V" },
            new { id = "avg_cell_voltage", name = "Avg Cell Voltage", unit = "V" },
            new { id = "cycle_count", name = "Cycle Count", unit = "" },
            new { id = "alarm_flags", name = "Alarm Flags", unit = "" },
        };

        return Ok(entities);
    }

    [HttpGet("devices")]
    public IActionResult GetAvailableDevices()
    {
        var status = deviceStateStore.GetStatus(environment.EnvironmentName);
        var devices = status.Devices.Select(d => new { id = d.DeviceId, name = d.DisplayName }).ToArray();
        return Ok(devices);
    }
}
