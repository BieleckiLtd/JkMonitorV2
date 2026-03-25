using JkMonitor.Backend.Models;

namespace JkMonitor.Backend.Services;

public sealed class NotificationDispatcher(
    NotificationConfigStore configStore,
    IEnumerable<INotificationChannelSender> senders,
    ILogger<NotificationDispatcher> logger)
{
    private readonly Dictionary<string, INotificationChannelSender> _senders =
        senders.ToDictionary(s => s.ChannelType, StringComparer.OrdinalIgnoreCase);

    public async Task<IReadOnlyList<string>> DispatchAsync(
        IReadOnlyList<string> channelIds,
        string subject,
        string body,
        string severity,
        CancellationToken cancellationToken)
    {
        var results = new List<string>();

        foreach (var channelId in channelIds)
        {
            var channel = configStore.GetChannel(channelId);
            if (channel is null)
            {
                results.Add($"{channelId}: channel not found");
                continue;
            }

            if (!channel.Enabled)
            {
                results.Add($"{channelId}: disabled");
                continue;
            }

            if (!_senders.TryGetValue(channel.Type, out var sender))
            {
                results.Add($"{channelId}: unsupported type '{channel.Type}'");
                continue;
            }

            try
            {
                var result = await sender.SendAsync(channel, subject, body, severity, cancellationToken);
                results.Add($"{channelId}: {result}");
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Failed to send notification via channel '{ChannelId}' ({ChannelType}).", channelId, channel.Type);
                results.Add($"{channelId}: error — {ex.Message}");
            }
        }

        return results;
    }

    public async Task<TestChannelResponse> TestChannelAsync(string channelId, CancellationToken cancellationToken)
    {
        var channel = configStore.GetChannel(channelId);
        if (channel is null)
            return new TestChannelResponse { Success = false, Error = "Channel not found." };

        if (!_senders.TryGetValue(channel.Type, out var sender))
            return new TestChannelResponse { Success = false, Error = $"Unsupported channel type '{channel.Type}'." };

        try
        {
            await sender.SendAsync(channel, "JK Monitor — Test", "This is a test notification from JK Monitor.", "info", cancellationToken);
            return new TestChannelResponse { Success = true };
        }
        catch (Exception ex)
        {
            return new TestChannelResponse { Success = false, Error = ex.Message };
        }
    }
}
