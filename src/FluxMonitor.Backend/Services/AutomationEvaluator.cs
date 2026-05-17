using System.Collections.Concurrent;
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
    PollTrigger pollTrigger,
    ILogger<AutomationEvaluator> logger)
{
    private const int MaxLogEntries = 100;

    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastTriggered = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, bool> _previousExpressionState = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _lastScheduleBucket = new(StringComparer.OrdinalIgnoreCase);
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
        var rules = configStore.GetRules()
            .Where(rule => rule.Enabled && IsRuleRelevantToPoll(rule, observedDeviceId))
            .ToArray();

        foreach (var rule in rules)
        {
            try
            {
                if (!ShouldTrigger(rule, observedDeviceId, observedDeviceName, snapshot, now))
                    continue;

                await ExecuteRuleAsync(rule, now, cancellationToken);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Automation rule '{RuleId}' failed during evaluation.", rule.Id);
            }
        }
    }

    private static bool IsRuleRelevantToPoll(AutomationRuleConfig rule, string observedDeviceId)
        => string.IsNullOrWhiteSpace(rule.SourceDeviceId)
            || string.Equals(rule.SourceDeviceId, observedDeviceId, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(rule.TriggerType, "expression", StringComparison.OrdinalIgnoreCase);

    private bool ShouldTrigger(
        AutomationRuleConfig rule,
        string observedDeviceId,
        string observedDeviceName,
        DeviceTelemetrySnapshot snapshot,
        DateTimeOffset now)
    {
        if (_lastTriggered.TryGetValue(rule.Id, out var lastTriggered)
            && now - lastTriggered < TimeSpan.FromMinutes(rule.CooldownMinutes))
        {
            return false;
        }

        return rule.TriggerType.ToLowerInvariant() switch
        {
            "expression" => ShouldTriggerExpression(rule, observedDeviceId, observedDeviceName, snapshot),
            "date-time" => ShouldTriggerDateTime(rule, now),
            "time-of-day" => ShouldTriggerDaily(rule, now),
            "weekly" => ShouldTriggerWeekly(rule, now),
            "hourly" => ShouldTriggerHourly(rule, now),
            _ => false
        };
    }

    private bool ShouldTriggerExpression(
        AutomationRuleConfig rule,
        string observedDeviceId,
        string observedDeviceName,
        DeviceTelemetrySnapshot snapshot)
    {
        if (!string.IsNullOrWhiteSpace(rule.SourceDeviceId)
            && !string.Equals(rule.SourceDeviceId, observedDeviceId, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        bool triggered;
        try
        {
            var expression = new Expression(
                rule.Expression,
                ExpressionOptions.AllowNullParameter | ExpressionOptions.IgnoreCaseAtBuiltInFunctions);

            expression.Parameters["device"] = observedDeviceName;
            expression.Parameters["deviceId"] = observedDeviceId;
            expression.Parameters["hour"] = DateTimeOffset.Now.Hour;
            expression.Parameters["minute"] = DateTimeOffset.Now.Minute;
            expression.Parameters["dayOfWeek"] = (int)DateTimeOffset.Now.DayOfWeek;
            PopulateSnapshotParameters(expression, snapshot);

            var result = expression.Evaluate();
            triggered = result is true or 1 or 1.0;
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "NCalc expression error in automation rule '{RuleId}': {Expression}", rule.Id, rule.Expression);
            return false;
        }

        var wasTriggered = _previousExpressionState.GetValueOrDefault(rule.Id, false);
        _previousExpressionState[rule.Id] = triggered;

        return triggered && !wasTriggered;
    }

    private bool ShouldTriggerDateTime(AutomationRuleConfig rule, DateTimeOffset now)
    {
        if (rule.RunAt is null || now < rule.RunAt.Value)
            return false;

        return MarkScheduleBucket(rule.Id, "once");
    }

    private bool ShouldTriggerDaily(AutomationRuleConfig rule, DateTimeOffset now)
    {
        var localNow = now.ToLocalTime();
        if (!AutomationRuleValidator.TryParseTimeOfDay(rule.TimeOfDay, out var time)
            || localNow.Hour != time.Hour
            || localNow.Minute != time.Minute)
        {
            return false;
        }

        return MarkScheduleBucket(rule.Id, localNow.ToString("yyyy-MM-dd:HH:mm"));
    }

    private bool ShouldTriggerWeekly(AutomationRuleConfig rule, DateTimeOffset now)
    {
        var localNow = now.ToLocalTime();
        if (!rule.DaysOfWeek.Contains((int)localNow.DayOfWeek)
            || !AutomationRuleValidator.TryParseTimeOfDay(rule.TimeOfDay, out var time)
            || localNow.Hour != time.Hour
            || localNow.Minute != time.Minute)
        {
            return false;
        }

        return MarkScheduleBucket(rule.Id, localNow.ToString("yyyy-MM-dd:HH:mm"));
    }

    private bool ShouldTriggerHourly(AutomationRuleConfig rule, DateTimeOffset now)
    {
        var localNow = now.ToLocalTime();
        if (rule.MinuteOfHour != localNow.Minute)
            return false;

        return MarkScheduleBucket(rule.Id, localNow.ToString("yyyy-MM-dd:HH"));
    }

    private bool MarkScheduleBucket(string ruleId, string bucket)
    {
        if (_lastScheduleBucket.TryGetValue(ruleId, out var previous)
            && string.Equals(previous, bucket, StringComparison.Ordinal))
        {
            return false;
        }

        _lastScheduleBucket[ruleId] = bucket;
        return true;
    }

    private async Task ExecuteRuleAsync(AutomationRuleConfig rule, DateTimeOffset now, CancellationToken cancellationToken)
    {
        _lastTriggered[rule.Id] = now;

        var result = await WriteParameterAsync(rule, cancellationToken);
        var message = result.Success
            ? $"Wrote {rule.RawValue} to {rule.TargetParameterKey} on {rule.TargetDeviceId}."
            : result.Error ?? "Automation write failed.";

        logger.LogInformation(
            "Automation rule '{RuleId}' triggered. TargetDevice={TargetDeviceId}, TargetParameter={TargetParameterKey}, Success={Success}, Message={Message}",
            rule.Id,
            rule.TargetDeviceId,
            rule.TargetParameterKey,
            result.Success,
            message);

        AppendLogEntry(new AutomationLogEntry
        {
            RuleId = rule.Id,
            RuleName = rule.Name,
            FiredAt = DateTimeOffset.UtcNow,
            TriggerType = rule.TriggerType,
            SourceDeviceId = rule.SourceDeviceId,
            TargetDeviceId = rule.TargetDeviceId,
            TargetParameterKey = rule.TargetParameterKey,
            RawValue = rule.RawValue,
            Success = result.Success,
            Message = message
        });
    }

    private async Task<WriteRegisterResult> WriteParameterAsync(AutomationRuleConfig rule, CancellationToken cancellationToken)
    {
        var device = deviceConfigStore.GetDevices().FirstOrDefault(d =>
            string.Equals(d.DeviceId, rule.TargetDeviceId, StringComparison.OrdinalIgnoreCase));

        if (device is null)
            return new WriteRegisterResult(false, rule.RawValue, null, $"Device '{rule.TargetDeviceId}' not found.");

        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
            return new WriteRegisterResult(false, rule.RawValue, null, $"Device definition '{device.DefinitionId}' not found.");

        var blockedWriteReason = DevicesController.GetProtectedWriteBlockReason(
            definition,
            rule.TargetParameterKey,
            stateStore.GetDeviceState(rule.TargetDeviceId)?.LatestTelemetry);
        if (blockedWriteReason is not null)
            return new WriteRegisterResult(false, rule.RawValue, null, blockedWriteReason);

        try
        {
            var result = string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase)
                ? await genericBlePollingClient.WriteEntityAsync(device, definition, rule.TargetParameterKey, rule.RawValue, cancellationToken)
                : await genericSerialPollingClient.WriteEntityAsync(device, definition, rule.TargetParameterKey, rule.RawValue, cancellationToken);

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
            return new WriteRegisterResult(false, rule.RawValue, null, exception.Message);
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

    private static void PopulateSnapshotParameters(Expression expression, DeviceTelemetrySnapshot snapshot)
    {
        foreach (var value in snapshot.NumericValues)
        {
            if (value.Value.HasValue)
                expression.Parameters[value.Key] = (double)value.Value.Value;
        }

        foreach (var parameter in snapshot.Parameters)
        {
            if (parameter.NumericValue.HasValue && !expression.Parameters.ContainsKey(parameter.Key))
                expression.Parameters[parameter.Key] = (double)parameter.NumericValue.Value;
            else if (parameter.BooleanValue.HasValue && !expression.Parameters.ContainsKey(parameter.Key))
                expression.Parameters[parameter.Key] = parameter.BooleanValue.Value ? 1 : 0;
            else if (parameter.RawValue.HasValue && !expression.Parameters.ContainsKey(parameter.Key))
                expression.Parameters[parameter.Key] = parameter.RawValue.Value;
        }
    }
}
