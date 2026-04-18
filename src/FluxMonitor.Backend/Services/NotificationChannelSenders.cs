using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public interface INotificationChannelSender
{
    string ChannelType { get; }
    Task<string> SendAsync(NotificationChannelConfig channel, string subject, string body, string severity, CancellationToken cancellationToken);
}

public sealed class NtfyChannelSender(IHttpClientFactory httpClientFactory) : INotificationChannelSender
{
    public string ChannelType => "ntfy";

    public async Task<string> SendAsync(NotificationChannelConfig channel, string subject, string body, string severity, CancellationToken cancellationToken)
    {
        var settings = channel.Settings;
        var baseUrl = NotificationChannelSettings.GetString(settings, "baseUrl") ?? "https://ntfy.sh";
        var topic = NotificationChannelSettings.GetString(settings, "topic") ?? throw new InvalidOperationException("ntfy topic is required.");
        var accessToken = NotificationChannelSettings.GetString(settings, "accessToken");
        var priority = NotificationChannelSettings.GetInt(settings, "priority") ?? SeverityToPriority(severity);

        using var client = httpClientFactory.CreateClient();
        var trimmedBaseUrl = baseUrl.TrimEnd('/');
        var jsonPublishUrl = $"{trimmedBaseUrl}/";

        // Use JSON publish format to support non-ASCII characters in title/body
        var payload = new Dictionary<string, object>
        {
            ["topic"] = topic,
            ["title"] = subject,
            ["message"] = body,
            ["priority"] = priority,
            ["tags"] = new[] { SeverityToTag(severity) }
        };

        using var jsonRequest = new HttpRequestMessage(HttpMethod.Post, jsonPublishUrl);
        jsonRequest.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        if (!string.IsNullOrEmpty(accessToken))
        {
            jsonRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        }

        using var jsonResponse = await client.SendAsync(jsonRequest, cancellationToken);
        if (jsonResponse.IsSuccessStatusCode)
        {
            return "sent";
        }

        var jsonError = await ReadErrorAsync(jsonResponse, cancellationToken);

        // Fall back to the simpler topic endpoint format. Some self-hosted setups and proxies
        // are more permissive with topic publishes than root JSON publishes.
        using var topicRequest = new HttpRequestMessage(HttpMethod.Post, $"{trimmedBaseUrl}/{Uri.EscapeDataString(topic)}");
        topicRequest.Content = new StringContent(body, Encoding.UTF8, "text/plain");
        if (!string.IsNullOrWhiteSpace(subject))
        {
            topicRequest.Headers.TryAddWithoutValidation("Title", subject);
        }

        topicRequest.Headers.TryAddWithoutValidation("Priority", priority.ToString());
        topicRequest.Headers.TryAddWithoutValidation("Tags", SeverityToTag(severity));

        if (!string.IsNullOrEmpty(accessToken))
        {
            topicRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        }

        using var topicResponse = await client.SendAsync(topicRequest, cancellationToken);
        if (topicResponse.IsSuccessStatusCode)
        {
            return "sent";
        }

        var topicError = await ReadErrorAsync(topicResponse, cancellationToken);
        throw new InvalidOperationException($"ntfy publish failed. JSON publish: {jsonError}. Topic publish fallback: {topicError}.");
    }

    private static int SeverityToPriority(string severity) => severity.ToLowerInvariant() switch
    {
        "critical" => 5,
        "warning" => 4,
        "info" => 3,
        _ => 3
    };

    private static string SeverityToTag(string severity) => severity.ToLowerInvariant() switch
    {
        "critical" => "rotating_light",
        "warning" => "warning",
        _ => "information_source"
    };

    private static async Task<string> ReadErrorAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var body = response.Content is null
            ? string.Empty
            : (await response.Content.ReadAsStringAsync(cancellationToken)).Trim();

        if (string.IsNullOrWhiteSpace(body))
        {
            return $"{(int)response.StatusCode} {response.ReasonPhrase}";
        }

        return $"{(int)response.StatusCode} {response.ReasonPhrase}: {body}";
    }
}

public sealed class EmailChannelSender(ILogger<EmailChannelSender> logger) : INotificationChannelSender
{
    public string ChannelType => "email";

    public async Task<string> SendAsync(NotificationChannelConfig channel, string subject, string body, string severity, CancellationToken cancellationToken)
    {
        var settings = channel.Settings;
        var host = NotificationChannelSettings.GetString(settings, "host") ?? throw new InvalidOperationException("SMTP host is required.");
        var port = NotificationChannelSettings.GetInt(settings, "port") ?? 587;
        var useSsl = NotificationChannelSettings.GetBool(settings, "useSsl") ?? true;
        var username = NotificationChannelSettings.GetString(settings, "username");
        var password = NotificationChannelSettings.GetString(settings, "password");
        var fromAddress = NotificationChannelSettings.GetString(settings, "fromAddress") ?? throw new InvalidOperationException("From address is required.");
        var fromName = NotificationChannelSettings.GetString(settings, "fromName") ?? "Flux Monitor";
        var toAddresses = NotificationChannelSettings.GetStringArray(settings, "toAddresses");

        if (toAddresses.Count == 0)
            throw new InvalidOperationException("At least one recipient email address is required.");

        using var smtpClient = new MailKit.Net.Smtp.SmtpClient();
        await smtpClient.ConnectAsync(host, port, useSsl ? MailKit.Security.SecureSocketOptions.StartTls : MailKit.Security.SecureSocketOptions.Auto, cancellationToken);

        if (!string.IsNullOrEmpty(username))
        {
            await smtpClient.AuthenticateAsync(username, password ?? string.Empty, cancellationToken);
        }

        var message = new MimeKit.MimeMessage();
        message.From.Add(new MimeKit.MailboxAddress(fromName, fromAddress));
        foreach (var to in toAddresses)
        {
            message.To.Add(MimeKit.MailboxAddress.Parse(to));
        }
        message.Subject = $"[{severity.ToUpperInvariant()}] {subject}";
        message.Body = new MimeKit.TextPart("plain") { Text = body };

        await smtpClient.SendAsync(message, cancellationToken);
        await smtpClient.DisconnectAsync(true, cancellationToken);

        logger.LogInformation("Sent email notification to {Recipients} via {Host}.", string.Join(", ", toAddresses), host);
        return "sent";
    }
}

public sealed class BrevoChannelSender(
    IHttpClientFactory httpClientFactory,
    ILogger<BrevoChannelSender> logger) : INotificationChannelSender
{
    public string ChannelType => "brevo";

    public async Task<string> SendAsync(NotificationChannelConfig channel, string subject, string body, string severity, CancellationToken cancellationToken)
    {
        var settings = channel.Settings;
        var apiKey = NotificationChannelSettings.GetString(settings, "apiKey") ?? throw new InvalidOperationException("Brevo API key is required.");
        var fromAddress = NotificationChannelSettings.GetString(settings, "fromAddress") ?? throw new InvalidOperationException("Brevo sender address is required.");
        var fromName = NotificationChannelSettings.GetString(settings, "fromName") ?? "Flux Monitor";
        var toAddresses = NotificationChannelSettings.GetStringArray(settings, "toAddresses");

        if (toAddresses.Count == 0)
            throw new InvalidOperationException("At least one recipient email address is required.");

        var payload = new Dictionary<string, object>
        {
            ["sender"] = new Dictionary<string, string> { ["name"] = fromName, ["email"] = fromAddress },
            ["to"] = toAddresses.Select(a => new Dictionary<string, string> { ["email"] = a }).ToArray(),
            ["subject"] = $"[{severity.ToUpperInvariant()}] {subject}",
            ["textContent"] = body,
        };

        using var client = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.brevo.com/v3/smtp/email");
        request.Headers.Add("api-key", apiKey);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        logger.LogInformation("Sent Brevo email notification to {Recipients}.", string.Join(", ", toAddresses));
        return "sent";
    }
}

public sealed class TelegramChannelSender(
    IHttpClientFactory httpClientFactory,
    ILogger<TelegramChannelSender> logger) : INotificationChannelSender
{
    public string ChannelType => "telegram";

    public async Task<string> SendAsync(NotificationChannelConfig channel, string subject, string body, string severity, CancellationToken cancellationToken)
    {
        var settings = channel.Settings;
        var botToken = NotificationChannelSettings.GetString(settings, "botToken") ?? throw new InvalidOperationException("Telegram bot token is required.");
        var chatId = NotificationChannelSettings.GetString(settings, "chatId") ?? throw new InvalidOperationException("Telegram chat ID is required.");

        var messageText = BuildMessageText(subject, body);
        var endpoint = $"https://api.telegram.org/bot{Uri.EscapeDataString(botToken)}/sendMessage";

        var payload = new Dictionary<string, object>
        {
            ["chat_id"] = chatId,
            ["text"] = messageText,
        };

        using var client = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();

        logger.LogInformation("Sent Telegram notification to chat {ChatId}.", chatId);
        return "sent";
    }

    private static string BuildMessageText(string subject, string body)
    {
        if (string.IsNullOrWhiteSpace(subject)) return body;
        if (string.IsNullOrWhiteSpace(body)) return subject;
        return $"*{subject}*\n{body}";
    }
}

internal static class NotificationChannelSettings
{
    public static string? GetString(Dictionary<string, object?> settings, string key)
        => settings.TryGetValue(key, out var val) ? val?.ToString() : null;

    public static int? GetInt(Dictionary<string, object?> settings, string key)
    {
        if (!settings.TryGetValue(key, out var val) || val is null) return null;
        if (val is JsonElement je && je.ValueKind == JsonValueKind.Number) return je.GetInt32();
        if (int.TryParse(val.ToString(), out var i)) return i;
        return null;
    }

    public static bool? GetBool(Dictionary<string, object?> settings, string key)
    {
        if (!settings.TryGetValue(key, out var val) || val is null) return null;
        if (val is JsonElement je && je.ValueKind == JsonValueKind.True) return true;
        if (val is JsonElement je2 && je2.ValueKind == JsonValueKind.False) return false;
        if (bool.TryParse(val.ToString(), out var b)) return b;
        return null;
    }

    public static IReadOnlyList<string> GetStringArray(Dictionary<string, object?> settings, string key)
    {
        if (!settings.TryGetValue(key, out var val) || val is null) return [];
        if (val is JsonElement je && je.ValueKind == JsonValueKind.Array)
        {
            return je.EnumerateArray().Select(e => e.GetString()!).Where(s => !string.IsNullOrWhiteSpace(s)).ToList();
        }

        var str = val.ToString();
        if (!string.IsNullOrWhiteSpace(str))
        {
            return str.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        }

        return [];
    }
}
