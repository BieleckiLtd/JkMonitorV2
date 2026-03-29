namespace FluxMonitor.Backend.Models;

// ── Persistence models (stored in notifications.json) ──

public sealed class NotificationConfig
{
    public List<NotificationChannelConfig> Channels { get; set; } = [];
    public List<NotificationRuleConfig> Rules { get; set; } = [];
}

public sealed class NotificationChannelConfig
{
    public required string Id { get; set; }
    public required string Type { get; set; } // "ntfy" | "email" | "brevo" | "telegram"
    public required string Name { get; set; }
    public bool Enabled { get; set; } = true;
    public Dictionary<string, object?> Settings { get; set; } = [];
}

public sealed class NotificationRuleConfig
{
    public required string Id { get; set; }
    public required string Name { get; set; }
    public bool Enabled { get; set; } = true;
    public required string DeviceId { get; set; }
    public required string EntityId { get; set; }
    public required string Expression { get; set; }
    public List<string> ChannelIds { get; set; } = [];
    public string MessageTemplate { get; set; } = "{name}: {value} on {device}";
    public string Severity { get; set; } = "info";
    public int CooldownMinutes { get; set; } = 15;
}

// ── API request/response ──

public sealed class SaveNotificationChannelsRequest
{
    public List<NotificationChannelConfig> Channels { get; init; } = [];
}

public sealed class SaveNotificationRulesRequest
{
    public List<NotificationRuleConfig> Rules { get; init; } = [];
}

public sealed class NotificationConfigResponse
{
    public required IReadOnlyList<NotificationChannelConfig> Channels { get; init; }
    public required IReadOnlyList<NotificationRuleConfig> Rules { get; init; }
}

public sealed class TestChannelRequest
{
    public required string ChannelId { get; init; }
}

public sealed class TestChannelResponse
{
    public bool Success { get; init; }
    public string? Error { get; init; }
}

public sealed class NotificationLogEntry
{
    public required string RuleId { get; init; }
    public required string RuleName { get; init; }
    public required string DeviceId { get; init; }
    public required string EntityId { get; init; }
    public required DateTimeOffset FiredAt { get; init; }
    public required string Message { get; init; }
    public required string Severity { get; init; }
    public double? Value { get; init; }
    public double? PreviousValue { get; init; }
    public IReadOnlyList<string> ChannelResults { get; init; } = [];
}
