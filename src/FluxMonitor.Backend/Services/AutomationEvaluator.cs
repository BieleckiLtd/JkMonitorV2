using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using FluxMonitor.Backend.Controllers;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using NCalc;

namespace FluxMonitor.Backend.Services;

public sealed class AutomationEvaluator(
    AutomationConfigStore configStore,
    DeviceStateStore stateStore,
    DeviceConfigStore deviceConfigStore,
    DeviceDefinitionLoader definitionLoader,
    GenericSerialPollingClient genericSerialPollingClient,
    GenericBlePollingClient genericBlePollingClient,
    EcoFlowBlePollingClient ecoFlowBlePollingClient,
    PollTrigger pollTrigger,
    ILogger<AutomationEvaluator> logger)
{
    private const int MaxLogEntries = 100;

    private static readonly Regex AndRegex = new(@"\bAND\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex OrRegex = new(@"\bOR\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex NotRegex = new(@"\bNOT\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex EqualityRegex = new(@"(?<![<>=!])=(?!=)", RegexOptions.Compiled);
    private static readonly Regex LeadingIfRegex = new(@"^\s*IF\s*:?\s*", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastTriggered = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, bool> _previousExpressionState = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentQueue<AutomationLogEntry> _log = new();

    public IReadOnlyList<AutomationLogEntry> GetRecentLog()
        => [.. _log];

    public async Task EvaluateAsync(
        string observedDeviceId,
        string observedDeviceName,
        DeviceTelemetrySnapshot? snapshot,
        CancellationToken cancellationToken)
    {
        if (snapshot is null)
            return;

        var now = DateTimeOffset.UtcNow;
        var rules = configStore.GetRules().Where(rule => rule.Enabled).ToArray();

        foreach (var rule in rules)
        {
            try
            {
                if (_lastTriggered.TryGetValue(rule.Id, out var lastTriggered)
                    && now - lastTriggered < TimeSpan.FromMinutes(rule.CooldownMinutes))
                {
                    continue;
                }

                var matched = EvaluateCondition(rule.Expression);
                var wasMatched = _previousExpressionState.GetValueOrDefault(rule.Id, false);
                _previousExpressionState[rule.Id] = matched;

                if (!matched || wasMatched)
                    continue;

                await ExecuteRuleAsync(rule, now, cancellationToken);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Automation rule '{RuleId}' failed during evaluation.", rule.Id);
            }
        }
    }

    public async Task<TestAutomationRuleResponse> TestAsync(AutomationRuleConfig rule, CancellationToken cancellationToken)
    {
        var validationErrors = AutomationRuleValidator.ValidateActionsOnly(rule);
        if (validationErrors.Count > 0)
        {
            return new TestAutomationRuleResponse
            {
                ConditionMatched = false,
                Message = validationErrors[0]
            };
        }

        var actionResults = await ExecuteActionsAsync(rule, cancellationToken);
        var success = actionResults.Count > 0 && actionResults.All(result => result.Success);
        return new TestAutomationRuleResponse
        {
            ConditionMatched = success,
            Message = success
                ? $"Test wrote {actionResults.Count} automation action(s)."
                : "Test ran, but one or more actions failed.",
            ActionResults = actionResults
        };
    }

    private bool EvaluateCondition(string expressionText)
    {
        if (string.IsNullOrWhiteSpace(expressionText))
            return false;

        try
        {
            var context = BuildExpressionContext(expressionText);
            var expression = new Expression(
                context.Expression,
                ExpressionOptions.AllowNullParameter | ExpressionOptions.IgnoreCaseAtBuiltInFunctions);

            foreach (var (key, value) in context.Parameters)
            {
                expression.Parameters[key] = value;
            }

            var result = expression.Evaluate();
            return result is true or 1 or 1.0;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "NCalc expression error in automation expression: {Expression}", expressionText);
            return false;
        }
    }

    private AutomationExpressionContext BuildExpressionContext(string rawExpression)
    {
        var expression = NormalizeExpressionText(rawExpression);
        var parameters = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

        var now = DateTimeOffset.Now;
        AddToken("time.hour", now.Hour);
        AddToken("time.minute", now.Minute);
        AddToken("time.day", now.Day);
        AddToken("time.month", now.Month);
        AddToken("time.day_of_week", GetIsoDayOfWeek(now.DayOfWeek));
        AddToken("time.dayOfWeek", GetIsoDayOfWeek(now.DayOfWeek));
        AddToken("time.unix_seconds", now.ToUnixTimeSeconds());

        foreach (var device in stateStore.GetCurrentDevices())
        {
            if (device.LatestTelemetry is null)
                continue;

            foreach (var parameter in EnumerateDeviceValues(device.LatestTelemetry))
            {
                AddToken($"{device.DeviceId}.{parameter.Key}", parameter.Value);
            }
        }

        return new AutomationExpressionContext(expression, parameters);

        void AddToken(string token, object value)
        {
            var safeName = ToSafeParameterName(token);
            expression = ReplaceToken(expression, token, safeName);
            parameters[safeName] = value;
        }
    }

    private static string NormalizeExpressionText(string expression)
    {
        var normalized = expression.Trim();
        normalized = LeadingIfRegex.Replace(normalized, string.Empty);
        var thenIndex = normalized.IndexOf("THEN:", StringComparison.OrdinalIgnoreCase);
        if (thenIndex >= 0)
            normalized = normalized[..thenIndex].Trim();

        normalized = AndRegex.Replace(normalized, "&&");
        normalized = OrRegex.Replace(normalized, "||");
        normalized = NotRegex.Replace(normalized, "!");
        normalized = EqualityRegex.Replace(normalized, "==");
        return normalized;
    }

    private static string ReplaceToken(string expression, string token, string safeName)
        => Regex.Replace(
            expression,
            $@"(?<![A-Za-z0-9_]){Regex.Escape(token)}(?![A-Za-z0-9_])",
            safeName,
            RegexOptions.IgnoreCase);

    private static string ToSafeParameterName(string token)
        => "p_" + Regex.Replace(token, @"[^A-Za-z0-9_]", "_");

    private static int GetIsoDayOfWeek(DayOfWeek dayOfWeek)
        => dayOfWeek is DayOfWeek.Sunday ? 7 : (int)dayOfWeek;

    private static IEnumerable<KeyValuePair<string, object>> EnumerateDeviceValues(DeviceTelemetrySnapshot snapshot)
    {
        foreach (var value in snapshot.NumericValues)
        {
            if (value.Value.HasValue)
                yield return new KeyValuePair<string, object>(value.Key, (double)value.Value.Value);
        }

        foreach (var parameter in snapshot.Parameters)
        {
            if (parameter.NumericValue.HasValue)
                yield return new KeyValuePair<string, object>(parameter.Key, (double)parameter.NumericValue.Value);
            else if (parameter.BooleanValue.HasValue)
                yield return new KeyValuePair<string, object>(parameter.Key, parameter.BooleanValue.Value ? 1 : 0);
            else if (parameter.RawValue.HasValue)
                yield return new KeyValuePair<string, object>(parameter.Key, parameter.RawValue.Value);
        }
    }

    private async Task ExecuteRuleAsync(AutomationRuleConfig rule, DateTimeOffset now, CancellationToken cancellationToken)
    {
        _lastTriggered[rule.Id] = now;
        var actionResults = await ExecuteActionsAsync(rule, cancellationToken);
        var success = actionResults.Count > 0 && actionResults.All(result => result.Success);
        var message = success
            ? $"Wrote {actionResults.Count} automation action(s)."
            : "One or more automation actions failed.";

        logger.LogInformation(
            "Automation rule '{RuleId}' triggered. Success={Success}, Message={Message}",
            rule.Id,
            success,
            message);

        AppendLogEntry(new AutomationLogEntry
        {
            RuleId = rule.Id,
            RuleName = rule.Name,
            FiredAt = DateTimeOffset.UtcNow,
            ConditionMatched = true,
            Success = success,
            Message = message,
            ActionResults = actionResults,
            TargetDeviceId = actionResults.FirstOrDefault()?.TargetDeviceId ?? string.Empty,
            TargetParameterKey = actionResults.FirstOrDefault()?.TargetParameterKey ?? string.Empty,
            RawValue = actionResults.FirstOrDefault()?.RawValue ?? 0
        });
    }

    private async Task<IReadOnlyList<AutomationActionLogEntry>> ExecuteActionsAsync(
        AutomationRuleConfig rule,
        CancellationToken cancellationToken)
    {
        var results = new List<AutomationActionLogEntry>();
        foreach (var action in AutomationRuleValidator.NormalizeActions(rule))
        {
            var result = await WriteParameterAsync(action, cancellationToken);
            results.Add(new AutomationActionLogEntry
            {
                TargetDeviceId = action.TargetDeviceId,
                TargetParameterKey = action.TargetParameterKey,
                RawValue = action.RawValue,
                Success = result.Success,
                Message = result.Success
                    ? $"Wrote {action.RawValue} to {action.TargetParameterKey} on {action.TargetDeviceId}."
                    : result.Error ?? "Automation write failed."
            });
        }

        return results;
    }

    private async Task<WriteRegisterResult> WriteParameterAsync(AutomationActionConfig action, CancellationToken cancellationToken)
    {
        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, action.TargetDeviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
            return new WriteRegisterResult(false, action.RawValue, null, $"Device '{action.TargetDeviceId}' not found.");

        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
            return new WriteRegisterResult(false, action.RawValue, null, $"Device definition '{device.DefinitionId}' not found.");

        var blockedWriteReason = DevicesController.GetProtectedWriteBlockReason(
            definition,
            action.TargetParameterKey,
            stateStore.GetDeviceState(action.TargetDeviceId)?.LatestTelemetry);
        if (blockedWriteReason is not null)
            return new WriteRegisterResult(false, action.RawValue, null, blockedWriteReason);

        try
        {
            var result = string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase)
                ? string.Equals(definition.Connection.Protocol.Type, EcoFlowBlePollingClient.ProtocolType, StringComparison.OrdinalIgnoreCase)
                    ? await ecoFlowBlePollingClient.WriteEntityAsync(device, definition, action.TargetParameterKey, action.RawValue, cancellationToken)
                    : await genericBlePollingClient.WriteEntityAsync(device, definition, action.TargetParameterKey, action.RawValue, cancellationToken)
                : await genericSerialPollingClient.WriteEntityAsync(device, definition, action.TargetParameterKey, action.RawValue, cancellationToken);

            pollTrigger.Signal();
            return result;
        }
        catch (Exception exception) when (exception is ArgumentException
            or TimeoutException
            or InvalidOperationException
            or NotSupportedException
            or InvalidDataException
            or PlatformNotSupportedException)
        {
            return new WriteRegisterResult(false, action.RawValue, null, exception.Message);
        }
    }

    private void AppendLogEntry(AutomationLogEntry entry)
    {
        _log.Enqueue(entry);
        while (_log.Count > MaxLogEntries)
        {
            _log.TryDequeue(out _);
        }
    }

    private sealed record AutomationExpressionContext(string Expression, IReadOnlyDictionary<string, object> Parameters);
}
