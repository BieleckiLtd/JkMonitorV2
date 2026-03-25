using System.Text.Json;
using System.Text.Json.Serialization;
using JkMonitor.Backend.Models;

namespace JkMonitor.Backend.Services;

public sealed class NotificationConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _filePath;
    private readonly ILogger<NotificationConfigStore> _logger;
    private readonly object _lock = new();
    private NotificationConfig _config;

    public NotificationConfigStore(string contentRootPath, ILogger<NotificationConfigStore> logger)
    {
        _filePath = Path.Combine(contentRootPath, "notifications.json");
        _logger = logger;
        _config = Load();
    }

    public NotificationConfig GetConfig()
    {
        lock (_lock)
        {
            return _config;
        }
    }

    public IReadOnlyList<NotificationChannelConfig> GetChannels()
    {
        lock (_lock)
        {
            return _config.Channels.AsReadOnly();
        }
    }

    public IReadOnlyList<NotificationRuleConfig> GetRules()
    {
        lock (_lock)
        {
            return _config.Rules.AsReadOnly();
        }
    }

    public NotificationChannelConfig? GetChannel(string id)
    {
        lock (_lock)
        {
            return _config.Channels.Find(c => string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
        }
    }

    public void SaveChannels(IReadOnlyList<NotificationChannelConfig> channels)
    {
        lock (_lock)
        {
            _config.Channels = [.. channels];
            Persist();
        }
    }

    public void SaveRules(IReadOnlyList<NotificationRuleConfig> rules)
    {
        lock (_lock)
        {
            _config.Rules = [.. rules];
            Persist();
        }
    }

    private NotificationConfig Load()
    {
        try
        {
            if (File.Exists(_filePath))
            {
                var json = File.ReadAllText(_filePath);
                var config = JsonSerializer.Deserialize<NotificationConfig>(json, JsonOptions);
                if (config is not null)
                {
                    _logger.LogInformation("Loaded notification config from {Path} ({ChannelCount} channels, {RuleCount} rules).",
                        _filePath, config.Channels.Count, config.Rules.Count);
                    return config;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to load notification config from {Path}. Starting with defaults.", _filePath);
        }

        return new NotificationConfig();
    }

    private void Persist()
    {
        try
        {
            var json = JsonSerializer.Serialize(_config, JsonOptions);
            File.WriteAllText(_filePath, json);
            _logger.LogInformation("Saved notification config to {Path}.", _filePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to save notification config to {Path}.", _filePath);
        }
    }
}
