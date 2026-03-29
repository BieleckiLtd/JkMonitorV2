using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class NotificationConfigStoreTests : IDisposable
{
    private readonly string _tempRootPath = Path.Combine(Path.GetTempPath(), $"FluxMonitor-notifications-{Guid.NewGuid():N}");

    [Fact]
    public void LoadLegacyConfigFromFile_ParsesNotificationConfig()
    {
        Directory.CreateDirectory(_tempRootPath);
        var notificationsPath = Path.Combine(_tempRootPath, "notifications.json");
        File.WriteAllText(notificationsPath, """
            {
              "channels": [
                {
                  "id": "ntfy-main",
                  "type": "ntfy",
                  "name": "Main ntfy",
                  "enabled": true,
                  "settings": {
                    "baseUrl": "https://ntfy.sh",
                    "topic": "FluxMonitor-alerts"
                  }
                }
              ],
              "rules": [
                {
                  "id": "rule-1",
                  "name": "Battery full",
                  "enabled": true,
                  "deviceId": "jk-master-01",
                  "entityId": "state_of_charge",
                  "expression": "value == 100",
                  "channelIds": ["ntfy-main"],
                  "messageTemplate": "Battery full",
                  "severity": "info",
                  "cooldownMinutes": 15
                }
              ]
            }
            """);

        var config = NotificationConfigStore.LoadLegacyConfigFromFile(notificationsPath);

        Assert.NotNull(config);
        var channel = Assert.Single(config!.Channels);
        var rule = Assert.Single(config.Rules);

        Assert.Equal("ntfy-main", channel.Id);
        Assert.Equal("FluxMonitor-alerts", channel.Settings["topic"]?.ToString());
        Assert.Equal("rule-1", rule.Id);
        Assert.Equal(["ntfy-main"], rule.ChannelIds);
    }

    [Fact]
    public void LoadLegacyConfigFromFile_ReturnsNullWhenMissing()
    {
        var missingPath = Path.Combine(_tempRootPath, "missing-notifications.json");
        Assert.Null(NotificationConfigStore.LoadLegacyConfigFromFile(missingPath));
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempRootPath))
        {
            Directory.Delete(_tempRootPath, recursive: true);
        }
    }
}