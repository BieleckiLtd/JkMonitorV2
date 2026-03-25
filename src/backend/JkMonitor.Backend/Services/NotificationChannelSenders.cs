using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using JkMonitor.Backend.Models;

namespace JkMonitor.Backend.Services;

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
        var url = baseUrl.TrimEnd('/');

        // Use JSON publish format to support non-ASCII characters in title/body
        var payload = new Dictionary<string, object>
        {
            ["topic"] = topic,
            ["title"] = subject,
            ["message"] = body,
            ["priority"] = priority,
            ["tags"] = new[] { SeverityToTag(severity) }
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        if (!string.IsNullOrEmpty(accessToken))
        {
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);
        }

        var response = await client.SendAsync(request, cancellationToken);
        response.EnsureSuccessStatusCode();
        return "sent";
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
        var fromName = NotificationChannelSettings.GetString(settings, "fromName") ?? "JK Monitor";
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

public sealed class WhatsAppChannelSender(
    IHttpClientFactory httpClientFactory,
    ILogger<WhatsAppChannelSender> logger) : INotificationChannelSender
{
    public string ChannelType => "whatsapp";

    public async Task<string> SendAsync(NotificationChannelConfig channel, string subject, string body, string severity, CancellationToken cancellationToken)
    {
        var settings = channel.Settings;
        var apiVersion = NotificationChannelSettings.GetString(settings, "apiVersion") ?? "v22.0";
        var phoneNumberId = NotificationChannelSettings.GetString(settings, "phoneNumberId") ?? throw new InvalidOperationException("WhatsApp phone number ID is required.");
        var accessToken = NotificationChannelSettings.GetString(settings, "accessToken") ?? throw new InvalidOperationException("WhatsApp access token is required.");
        var recipientNumber = NormalizeRecipientNumber(NotificationChannelSettings.GetString(settings, "recipientNumber"))
            ?? throw new InvalidOperationException("WhatsApp recipient number is required.");
        var previewUrl = NotificationChannelSettings.GetBool(settings, "previewUrl") ?? false;

        var messageText = BuildMessageText(subject, body);
        var endpoint = $"https://graph.facebook.com/{apiVersion.Trim('/')}/{Uri.EscapeDataString(phoneNumberId)}/messages";

        var payload = new Dictionary<string, object?>
        {
            ["messaging_product"] = "whatsapp",
            ["recipient_type"] = "individual",
            ["to"] = recipientNumber,
            ["type"] = "text",
            ["text"] = new Dictionary<string, object?>
            {
                ["preview_url"] = previewUrl,
                ["body"] = messageText,
            },
        };

        using var client = httpClientFactory.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        var response = await client.SendAsync(request, cancellationToken);
        var responseBody = await response.Content.ReadAsStringAsync(cancellationToken);
        response.EnsureSuccessStatusCode();

        var messageId = TryGetMessageId(responseBody);
        logger.LogInformation("Sent WhatsApp notification to {RecipientNumber} using phone number ID {PhoneNumberId}.", recipientNumber, phoneNumberId);
        return string.IsNullOrWhiteSpace(messageId) ? "sent" : $"sent ({messageId})";
    }

    private static string BuildMessageText(string subject, string body)
    {
        if (string.IsNullOrWhiteSpace(subject))
        {
            return body;
        }

        if (string.IsNullOrWhiteSpace(body))
        {
            return subject;
        }

        return $"{subject}\n{body}";
    }

    private static string? NormalizeRecipientNumber(string? recipientNumber)
    {
        if (string.IsNullOrWhiteSpace(recipientNumber))
        {
            return null;
        }

        var digitsOnly = new string(recipientNumber.Where(char.IsDigit).ToArray());
        return string.IsNullOrWhiteSpace(digitsOnly) ? null : digitsOnly;
    }

    private static string? TryGetMessageId(string responseBody)
    {
        if (string.IsNullOrWhiteSpace(responseBody))
        {
            return null;
        }

        using var document = JsonDocument.Parse(responseBody);
        if (!document.RootElement.TryGetProperty("messages", out var messages) || messages.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        foreach (var message in messages.EnumerateArray())
        {
            if (message.TryGetProperty("id", out var idElement))
            {
                return idElement.GetString();
            }
        }

        return null;
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
