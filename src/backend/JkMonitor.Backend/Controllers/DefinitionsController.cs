using JkMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace JkMonitor.Backend.Controllers;

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
            EntityCount = d.Entities.Count,
            RegisterBankCount = d.RegisterBanks.Count
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
}
