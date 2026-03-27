using System.Text.Json;
using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/definitions")]
public sealed class DefinitionsController(DeviceDefinitionLoader definitionLoader) : ControllerBase
{
    [HttpGet]
    public IActionResult GetAll()
    {
        var definitions = definitionLoader.GetAll();
        var summaries = definitions.Values.Select(d => new
        {
            d.Device.Id,
            d.Device.Name,
            d.Device.Manufacturer,
            d.Device.Model,
            d.Device.Category,
            d.Device.Description,
            d.Device.Icon,
            ProtocolType = d.Connection.Protocol.Type,
            TransportType = d.Connection.Transport.Type,
            IsTransportSupported = PollingClientDispatcher.IsTransportSupported(d.Connection.Transport.Type),
            UnsupportedTransportMessage = PollingClientDispatcher.IsTransportSupported(d.Connection.Transport.Type)
                ? null
                : PollingClientDispatcher.GetUnsupportedTransportMessage(d.Connection.Transport.Type),
            EntityCount = d.Entities.Count,
            DataSourceCount = d.DataSources.Count
        });
        return Ok(summaries);
    }

    [HttpGet("{id}")]
    public IActionResult GetById(string id)
    {
        if (!definitionLoader.TryGet(id, out var definition) || definition is null)
            return NotFound(new { message = $"Device definition '{id}' not found." });

        return Ok(definition);
    }

    [HttpGet("{id}/ui/{page}")]
    public IActionResult GetUiPage(string id, string page)
    {
        if (!definitionLoader.TryGet(id, out var definition) || definition is null)
            return NotFound(new { message = $"Device definition '{id}' not found." });

        if (definition.Ui?.Pages is null ||
            !definition.Ui.Pages.TryGetValue(page, out var pageDefinition))
        {
            return NotFound(new { message = $"UI page '{page}' not found in definition '{id}'." });
        }

        return Ok(pageDefinition);
    }

    [HttpPost("upload")]
    public IActionResult Upload(IFormFile file)
    {
        if (file is null || file.Length == 0)
            return BadRequest(new { message = "No file provided." });

        using var reader = new StreamReader(file.OpenReadStream());
        var json = reader.ReadToEnd();

        try
        {
            var definition = definitionLoader.SaveAndLoad(json);
            return Ok(new
            {
                definition.Device.Id,
                definition.Device.Name,
                definition.Device.Manufacturer,
                definition.Device.Model,
                definition.Device.Category,
                definition.Device.Description,
                definition.Device.Icon,
                ProtocolType = definition.Connection.Protocol.Type,
                TransportType = definition.Connection.Transport.Type,
                IsTransportSupported = PollingClientDispatcher.IsTransportSupported(definition.Connection.Transport.Type),
                UnsupportedTransportMessage = PollingClientDispatcher.IsTransportSupported(definition.Connection.Transport.Type)
                    ? null
                    : PollingClientDispatcher.GetUnsupportedTransportMessage(definition.Connection.Transport.Type),
                EntityCount = definition.Entities.Count,
                DataSourceCount = definition.DataSources.Count
            });
        }
        catch (JsonException ex)
        {
            return BadRequest(new { message = $"Invalid JSON: {ex.Message}" });
        }
        catch (Exception ex)
        {
            return BadRequest(new { message = ex.Message });
        }
    }
}
