using System.Collections.Concurrent;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Status;
using NCalc;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Evaluates notification rules against device telemetry using NCalc expressions.
/// Tracks previous values to support transition-based triggers (e.g. prev &gt;= 90 &amp;&amp; value == 100).
/// </summary>
public sealed class NotificationEvaluator(
    NotificationConfigStore configStore,
    NotificationDispatcher dispatcher,
    ILogger<NotificationEvaluator> logger)
{
    // deviceId:entityId → previous numeric value
    private readonly ConcurrentDictionary<string, double> _previousValues = new(StringComparer.OrdinalIgnoreCase);

    // ruleId → last triggered timestamp (for cooldown)
    private readonly ConcurrentDictionary<string, DateTimeOffset> _lastTriggered = new(StringComparer.OrdinalIgnoreCase);

    // ruleId → whether the expression was true on the previous evaluation (edge triggering)
    private readonly ConcurrentDictionary<string, bool> _previouslyTriggered = new(StringComparer.OrdinalIgnoreCase);

    // deviceId → whether the device is currently in a communication-failure state
    private readonly ConcurrentDictionary<string, bool> _deviceCommFailed = new(StringComparer.OrdinalIgnoreCase);

    // warning key → true once emitted, to avoid log spam for persistently invalid rules
    private readonly ConcurrentDictionary<string, bool> _validationWarnings = new(StringComparer.OrdinalIgnoreCase);

    // Recent notification log (ring buffer, last 100)
    private readonly ConcurrentQueue<NotificationLogEntry> _log = new();
    private const int MaxLogEntries = 100;

    public IReadOnlyList<NotificationLogEntry> GetRecentLog()
    {
        return [.. _log];
    }

    /// <summary>
    /// Record a poll failure for a device so communication loss is visible in the notification log.
    /// Only logs the first failure after a successful poll (not every consecutive failure).
    /// </summary>
    public void RecordPollFailure(string deviceId, string deviceName, string errorMessage)
    {
        // Only log the transition from healthy → failed (not every failed poll).
        if (!_deviceCommFailed.TryAdd(deviceId, true))
        {
            if (_deviceCommFailed.TryGetValue(deviceId, out var already) && already)
                return; // already in failed state
            _deviceCommFailed[deviceId] = true;
        }

        logger.LogWarning("Communication lost with device {DeviceId} ({DeviceName}): {Error}", deviceId, deviceName, errorMessage);

        AppendLogEntry(new NotificationLogEntry
        {
            RuleId = "system:comm-lost",
            RuleName = "Communication",
            DeviceId = deviceId,
            EntityId = string.Empty,
            FiredAt = DateTimeOffset.UtcNow,
            Message = $"Communication lost with {deviceName}: {errorMessage}",
            Severity = "warning",
        });
    }

    public async Task EvaluateAsync(string deviceId, string deviceName, DeviceTelemetrySnapshot? snapshot, CancellationToken cancellationToken)
    {
        if (snapshot is null) return;

        // Detect communication recovery: was failed, now succeeding.
        if (_deviceCommFailed.TryGetValue(deviceId, out var wasFailed) && wasFailed)
        {
            _deviceCommFailed[deviceId] = false;
            logger.LogInformation("Communication restored with device {DeviceId} ({DeviceName}).", deviceId, deviceName);

            AppendLogEntry(new NotificationLogEntry
            {
                RuleId = "system:comm-restored",
                RuleName = "Communication",
                DeviceId = deviceId,
                EntityId = string.Empty,
                FiredAt = DateTimeOffset.UtcNow,
                Message = $"Communication restored with {deviceName}.",
                Severity = "info",
            });
        }

        var rules = configStore.GetRules();
        var matchingRules = rules.Where(r =>
            r.Enabled &&
            string.Equals(r.DeviceId, deviceId, StringComparison.OrdinalIgnoreCase))
            .ToList();

        if (matchingRules.Count == 0) return;

        foreach (var rule in matchingRules)
        {
            try
            {
                await EvaluateRuleAsync(rule, deviceId, deviceName, snapshot, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Failed to evaluate notification rule '{RuleId}' for device {DeviceId}.", rule.Id, deviceId);
            }
        }
    }

    private async Task EvaluateRuleAsync(
        NotificationRuleConfig rule,
        string deviceId,
        string deviceName,
        DeviceTelemetrySnapshot snapshot,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(rule.EntityId))
        {
            if (_validationWarnings.TryAdd($"missing-entity:{rule.Id}", true))
            {
                logger.LogWarning(
                    "Skipping notification rule '{RuleId}' for device {DeviceId} because no entity is selected. Re-save the rule with a valid entity.",
                    rule.Id,
                    deviceId);
            }

            return;
        }

        // Resolve the current entity value from the snapshot
        var currentValue = ResolveEntityValue(rule.EntityId, snapshot);
        if (currentValue is null)
        {
            if (_validationWarnings.TryAdd($"unresolved-entity:{rule.Id}:{rule.EntityId}", true))
            {
                logger.LogWarning(
                    "Skipping notification rule '{RuleId}' for device {DeviceId} because entity '{EntityId}' is not available in the current snapshot.",
                    rule.Id,
                    deviceId,
                    rule.EntityId);
            }

            return;
        }

        var cacheKey = $"{deviceId}:{rule.EntityId}";
        var previousValue = _previousValues.GetValueOrDefault(cacheKey, currentValue.Value);

        // Update for next evaluation
        _previousValues[cacheKey] = currentValue.Value;

        // Evaluate the NCalc expression
        bool triggered;
        try
        {
            var expression = new Expression(rule.Expression,
                ExpressionOptions.AllowNullParameter | ExpressionOptions.IgnoreCaseAtBuiltInFunctions);

            expression.Parameters["value"] = currentValue.Value;
            expression.Parameters["prev"] = previousValue;
            expression.Parameters["device"] = deviceName;

            // Expose all snapshot values as variables for complex expressions
            PopulateSnapshotParameters(expression, snapshot);

            var result = expression.Evaluate();
            triggered = result is true or 1 or 1.0;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "NCalc expression error in rule '{RuleId}': {Expression}", rule.Id, rule.Expression);
            return;
        }

        // Edge triggering: only fire on the rising edge (false → true).
        // This prevents repeated notifications when an expression stays true across multiple polls.
        var wasTriggeredBefore = _previouslyTriggered.GetValueOrDefault(rule.Id, false);
        _previouslyTriggered[rule.Id] = triggered;

        if (!triggered || wasTriggeredBefore) return;

        // Check cooldown (still applied to prevent rapid re-triggers on flapping values)
        if (_lastTriggered.TryGetValue(rule.Id, out var lastTriggered) &&
            DateTimeOffset.UtcNow - lastTriggered < TimeSpan.FromMinutes(rule.CooldownMinutes))
        {
            return;
        }

        // Fire notification
        _lastTriggered[rule.Id] = DateTimeOffset.UtcNow;

        var message = RenderTemplate(rule.MessageTemplate, rule, deviceId, deviceName, currentValue.Value, previousValue);
        var subject = rule.Name;

        logger.LogInformation("Notification rule '{RuleId}' triggered for device {DeviceId}: {Message} (value={Value}, prev={Prev})",
            rule.Id, deviceId, message, currentValue.Value, previousValue);

        var channelResults = await dispatcher.DispatchAsync(rule.ChannelIds, subject, message, rule.Severity, cancellationToken);

        // Log the event
        AppendLogEntry(new NotificationLogEntry
        {
            RuleId = rule.Id,
            RuleName = rule.Name,
            DeviceId = deviceId,
            EntityId = rule.EntityId,
            FiredAt = DateTimeOffset.UtcNow,
            Message = message,
            Severity = rule.Severity,
            Value = currentValue.Value,
            PreviousValue = previousValue,
            ChannelResults = channelResults
        });
    }

    private void AppendLogEntry(NotificationLogEntry entry)
    {
        _log.Enqueue(entry);
        while (_log.Count > MaxLogEntries)
        {
            _log.TryDequeue(out _);
        }
    }

    private static double? ResolveEntityValue(string entityId, DeviceTelemetrySnapshot snapshot)
    {
        if (snapshot.NumericValues.TryGetValue(entityId, out var value) && value.HasValue)
            return (double)value.Value;

        return ResolveFromParameters(entityId, snapshot);
    }

    private static double? ResolveFromParameters(string entityId, DeviceTelemetrySnapshot snapshot)
    {
        if (snapshot.Parameters is null) return null;
        var param = snapshot.Parameters.FirstOrDefault(p =>
            string.Equals(p.Key, entityId, StringComparison.OrdinalIgnoreCase));
        return (double?)param?.NumericValue;
    }

    private static void PopulateSnapshotParameters(Expression expression, DeviceTelemetrySnapshot snapshot)
    {
        foreach (var value in snapshot.NumericValues)
        {
            if (value.Value.HasValue)
                expression.Parameters[value.Key] = (double)value.Value.Value;
        }

        // Expose all dynamic parameters so expressions can reference any device entity.
        if (snapshot.Parameters is not null)
        {
            foreach (var p in snapshot.Parameters)
            {
                if (p.NumericValue.HasValue && !expression.Parameters.ContainsKey(p.Key))
                    expression.Parameters[p.Key] = (double)p.NumericValue.Value;
            }
        }
    }

    private static string RenderTemplate(string template, NotificationRuleConfig rule, string deviceId, string deviceName, double value, double prev)
    {
        return template
            .Replace("{value}", value.ToString("G"))
            .Replace("{prev}", prev.ToString("G"))
            .Replace("{device}", deviceName)
            .Replace("{deviceId}", deviceId)
            .Replace("{name}", rule.Name)
            .Replace("{entity}", rule.EntityId)
            .Replace("{severity}", rule.Severity);
    }
}
