using System.Text.Json;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/definitions")]
public sealed class DefinitionsController(
    DeviceDefinitionLoader definitionLoader,
    DeviceConfigStore deviceConfigStore,
    PollingClientDispatcher pollingClientDispatcher,
    IConfiguration configuration) : ControllerBase
{
    [HttpGet]
    public async Task<IActionResult> GetAll(
        [FromQuery] bool includeRemote = false,
        CancellationToken cancellationToken = default)
    {
        if (includeRemote && configuration.GetValue("Monitor:EnableRemoteDeviceDefinitions", true))
        {
            await definitionLoader.EnsureRemoteDefinitionsLoadedAsync(cancellationToken);
        }

        var definitions = new Dictionary<string, DeviceDefinition>(definitionLoader.GetAll(), StringComparer.OrdinalIgnoreCase);
        foreach (var device in deviceConfigStore.GetDevices())
        {
            if (device.TryResolveDefinition(definitionLoader, out var definition) && definition is not null)
            {
                definitions.TryAdd(definition.Device.Id, definition);
            }
        }

        var summaries = definitions.Values
            .Select(ToSummary)
            .OrderBy(summary => summary.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(summary => summary.Id, StringComparer.OrdinalIgnoreCase);

        return Ok(summaries);
    }

    [HttpGet("{id}")]
    public IActionResult GetById(string id, [FromQuery] bool preferCatalog = false)
    {
        if (preferCatalog &&
            definitionLoader.TryGet(id, out var catalogDefinition) &&
            catalogDefinition is not null)
        {
            return Ok(catalogDefinition);
        }

        if (!TryResolveDefinition(id, out var definition) || definition is null)
        {
            return NotFound(new { message = $"Device definition '{id}' not found." });
        }

        return Ok(definition);
    }

    [HttpGet("{id}/entities")]
    public IActionResult GetEntities(string id)
    {
        if (!TryResolveDefinition(id, out var definition) || definition is null)
        {
            return NotFound(new { message = $"Device definition '{id}' not found." });
        }

        var storedEntities = new HashSet<string>(
            definition.Storage?.TimeSeries?.Select(ts => ts.Entity) ?? [],
            StringComparer.OrdinalIgnoreCase);

        if (definition.Storage?.CellVoltages is not null)
            storedEntities.Add(definition.Storage.CellVoltages.Entity);

        var entities = definition.Entities.Select(e => new EntitySummaryResponse(
            e.Id, e.Name, e.Type, e.Category, e.Source.Unit, e.Role, e.Hidden,
            Computed: false, Expression: null, FallbackFor: null,
            Stored: storedEntities.Contains(e.Id)));

        var computed = definition.ComputedEntities.Select(c => new EntitySummaryResponse(
            c.Id, c.Name, c.Type, c.Category, c.Unit, c.Role, c.Hidden,
            Computed: true, c.Expression, c.FallbackFor,
            Stored: storedEntities.Contains(c.Id)));

        return Ok(entities.Concat(computed));
    }

    [HttpGet("{id}/ui/{page}")]
    public IActionResult GetUiPage(string id, string page)
    {
        if (!TryResolveDefinition(id, out var definition) || definition is null)
        {
            return NotFound(new { message = $"Device definition '{id}' not found." });
        }

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
        {
            return BadRequest(new { message = "No file provided." });
        }

        using var reader = new StreamReader(file.OpenReadStream());
        var json = reader.ReadToEnd();

        try
        {
            var definition = definitionLoader.LoadFromJson(json);
            return Ok(ToSummary(definition));
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

    private bool TryResolveDefinition(string definitionId, out DeviceDefinition? definition)
    {
        foreach (var device in deviceConfigStore.GetDevices())
        {
            if (!string.Equals(device.DefinitionId, definitionId, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (device.TryResolveDefinition(definitionLoader, out definition) && definition is not null)
            {
                return true;
            }
        }

        return definitionLoader.TryGet(definitionId, out definition);
    }

    private DefinitionSummaryResponse ToSummary(DeviceDefinition definition)
    {
        return new DefinitionSummaryResponse(
            definition.Device.Id,
            definition.Device.Name,
            definition.Device.Manufacturer ?? string.Empty,
            definition.Device.Model ?? string.Empty,
            definition.Device.Category,
            definition.Device.Description,
            definition.Device.Icon,
            definition.Connection.Protocol.Type,
            definition.Connection.Transport.Type,
            pollingClientDispatcher.IsDefinitionSupported(definition),
            pollingClientDispatcher.GetUnsupportedDefinitionMessage(definition),
            definition.Entities.Count,
            definition.DataSources.Count);
    }

    private sealed record DefinitionSummaryResponse(
        string Id,
        string Name,
        string Manufacturer,
        string Model,
        string? Category,
        string? Description,
        string? Icon,
        string ProtocolType,
        string TransportType,
        bool IsTransportSupported,
        string? UnsupportedTransportMessage,
        int EntityCount,
        int DataSourceCount);

    private sealed record EntitySummaryResponse(
        string Id,
        string Name,
        string Type,
        string Category,
        string? Unit,
        string? Role,
        bool Hidden,
        bool Computed,
        string? Expression,
        string? FallbackFor,
        bool Stored);
}
