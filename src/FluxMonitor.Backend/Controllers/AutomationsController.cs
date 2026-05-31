using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Microsoft.AspNetCore.Mvc;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/automations")]
public sealed class AutomationsController(
    AutomationConfigStore configStore,
    AutomationEvaluator evaluator,
    DeviceStateStore deviceStateStore,
    DeviceConfigStore deviceConfigStore,
    DeviceDefinitionLoader definitionLoader) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<AutomationConfigResponse>> GetConfig(CancellationToken cancellationToken)
    {
        await configStore.InitializeAsync(cancellationToken);
        var config = configStore.GetConfig();
        return Ok(new AutomationConfigResponse
        {
            Rules = config.Rules
        });
    }

    [HttpPut("rules")]
    public async Task<ActionResult<AutomationConfigResponse>> SaveRules(
        [FromBody] SaveAutomationRulesRequest request,
        CancellationToken cancellationToken)
    {
        var validationErrors = AutomationRuleValidator.Validate(request.Rules).ToList();
        for (var index = 0; index < request.Rules.Count; index++)
        {
            var rule = request.Rules[index];
            if (string.IsNullOrWhiteSpace(rule.Expression))
                continue;

            if (!AutomationExpressionSyntaxValidator.TryValidate(rule.Expression, out var expressionError))
            {
                validationErrors.Add($"{GetRuleLabel(rule, index)}: {expressionError}");
            }
        }

        if (validationErrors.Count > 0)
        {
            return ValidationProblem(new ValidationProblemDetails(new Dictionary<string, string[]>
            {
                ["rules"] = [.. validationErrors]
            })
            {
                Title = "Invalid automation rules.",
                Status = StatusCodes.Status400BadRequest
            });
        }

        await configStore.SaveRulesAsync(request.Rules, cancellationToken);
        var config = configStore.GetConfig();
        return Ok(new AutomationConfigResponse
        {
            Rules = config.Rules
        });
    }

    [HttpGet("log")]
    public ActionResult<IReadOnlyList<AutomationLogEntry>> GetLog()
        => Ok(evaluator.GetRecentLog());

    [HttpPost("rules/test")]
    public async Task<ActionResult<TestAutomationRuleResponse>> TestRule(
        [FromBody] TestAutomationRuleRequest request,
        CancellationToken cancellationToken)
    {
        return Ok(await evaluator.TestAsync(request.Rule, cancellationToken));
    }

    [HttpPost("expressions/validate")]
    public ActionResult<ValidateAutomationExpressionResponse> ValidateExpression(
        [FromBody] ValidateAutomationExpressionRequest request)
    {
        var isValid = AutomationExpressionSyntaxValidator.TryValidate(request.Expression, out var error);
        return Ok(new ValidateAutomationExpressionResponse
        {
            IsValid = isValid,
            Message = isValid ? null : error
        });
    }

    [HttpGet("devices")]
    public IActionResult GetAvailableDevices()
    {
        var configuredDevices = deviceConfigStore.GetDevices();
        var runtimeStates = deviceStateStore.GetCurrentDevices()
            .ToDictionary(device => device.DeviceId, StringComparer.OrdinalIgnoreCase);

        var devices = configuredDevices
            .OrderBy(device => device.SortOrder)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(device =>
            {
                device.TryResolveDefinition(definitionLoader, out var definition);
                runtimeStates.TryGetValue(device.DeviceId, out var state);
                var parameters = BuildParameterList(definition, state?.LatestTelemetry);

                return new AutomationDeviceOption(
                    device.DeviceId,
                    device.DisplayName,
                    parameters,
                    parameters.Where(parameter => parameter.IsWritable).ToArray());
            })
            .ToArray();

        return Ok(devices);
    }

    private static IReadOnlyList<AutomationParameterOption> BuildParameterList(
        DeviceDefinition? definition,
        DeviceTelemetrySnapshot? telemetry)
    {
        var parameters = new Dictionary<string, AutomationParameterOption>(StringComparer.OrdinalIgnoreCase);

        if (definition is not null)
        {
            foreach (var entity in definition.Entities)
            {
                if (entity.Hidden || string.Equals(entity.Type, "cell_array", StringComparison.OrdinalIgnoreCase))
                    continue;

                parameters[entity.Id] = new AutomationParameterOption(
                    entity.Id,
                    entity.Name,
                    entity.Category,
                    entity.Source.Unit ?? string.Empty,
                    entity.Writable,
                    null,
                    null,
                    null,
                    null,
                    entity.Options?.Select(option => new AutomationSelectOption(option.Value, option.Label)).ToArray() ?? []);
            }

            foreach (var computed in definition.ComputedEntities)
            {
                if (computed.Hidden)
                    continue;

                parameters.TryAdd(computed.Id, new AutomationParameterOption(
                    computed.Id,
                    computed.Name,
                    computed.Category,
                    computed.Unit ?? string.Empty,
                    false,
                    null,
                    null,
                    null,
                    null,
                    []));
            }
        }

        if (telemetry is not null)
        {
            foreach (var parameter in telemetry.Parameters)
            {
                parameters[parameter.Key] = new AutomationParameterOption(
                    parameter.Key,
                    parameter.DisplayName,
                    parameter.Category,
                    parameter.Unit ?? string.Empty,
                    parameter.IsWritable,
                    parameter.NumericValue,
                    parameter.StringValue,
                    parameter.BooleanValue,
                    parameter.RawValue,
                    parameter.Options?.Select(option => new AutomationSelectOption(option.Value, option.Label)).ToArray() ?? []);
            }
        }

        return parameters.Values
            .OrderBy(parameter => parameter.Category, StringComparer.OrdinalIgnoreCase)
            .ThenBy(parameter => parameter.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static string GetRuleLabel(AutomationRuleConfig rule, int index)
        => string.IsNullOrWhiteSpace(rule.Name) ? $"Rule {index + 1}" : $"Rule \"{rule.Name}\"";
}
