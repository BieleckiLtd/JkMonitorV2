using System.Net;
using System.Net.Http;
using System.Text.Json;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public class NotificationChannelSendersTests
{
    [Fact]
    public async Task BrevoChannelSender_SendAsync_PostsExpectedApiRequest()
    {
        Uri? requestUri = null;
        string? apiKeyHeader = null;
        string? requestBody = null;

        var sender = new BrevoChannelSender(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                requestUri = request.RequestUri;
                apiKeyHeader = request.Headers.TryGetValues("api-key", out var vals) ? string.Join("", vals) : null;
                requestBody = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult();
                return new HttpResponseMessage(HttpStatusCode.Created);
            })),
            NullLogger<BrevoChannelSender>.Instance);

        var channel = new NotificationChannelConfig
        {
            Id = "brevo-1",
            Type = "brevo",
            Name = "Ops Brevo",
            Settings = new Dictionary<string, object?>
            {
                ["apiKey"] = "xsmtpsib-test-key",
                ["fromAddress"] = "alerts@example.com",
                ["fromName"] = "Flux Monitor",
                ["toAddresses"] = "admin@example.com",
            }
        };

        var result = await sender.SendAsync(channel, "Charge complete", "Battery is at 100%.", "info", CancellationToken.None);

        Assert.Equal("sent", result);
        Assert.Equal("https://api.brevo.com/v3/smtp/email", requestUri?.AbsoluteUri);
        Assert.Equal("xsmtpsib-test-key", apiKeyHeader);
        Assert.NotNull(requestBody);

        using var document = JsonDocument.Parse(requestBody!);
        Assert.Equal("alerts@example.com", document.RootElement.GetProperty("sender").GetProperty("email").GetString());
        Assert.Equal("Flux Monitor", document.RootElement.GetProperty("sender").GetProperty("name").GetString());
        Assert.Equal("[INFO] Charge complete", document.RootElement.GetProperty("subject").GetString());
        Assert.Equal("Battery is at 100%.", document.RootElement.GetProperty("textContent").GetString());
        var to = document.RootElement.GetProperty("to");
        Assert.Equal(JsonValueKind.Array, to.ValueKind);
        Assert.Equal("admin@example.com", to[0].GetProperty("email").GetString());
    }

    [Fact]
    public async Task BrevoChannelSender_SendAsync_RequiresApiKey()
    {
        var sender = new BrevoChannelSender(
            new StubHttpClientFactory(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.Created))),
            NullLogger<BrevoChannelSender>.Instance);

        var channel = new NotificationChannelConfig
        {
            Id = "brevo-1",
            Type = "brevo",
            Name = "Ops Brevo",
            Settings = new Dictionary<string, object?>
            {
                ["fromAddress"] = "alerts@example.com",
                ["toAddresses"] = "admin@example.com",
            }
        };

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            sender.SendAsync(channel, "Test", "Body", "info", CancellationToken.None));

        Assert.Equal("Brevo API key is required.", exception.Message);
    }

    [Fact]
    public async Task TelegramChannelSender_SendAsync_PostsExpectedBotApiRequest()
    {
        Uri? requestUri = null;
        string? requestBody = null;

        var sender = new TelegramChannelSender(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                requestUri = request.RequestUri;
                requestBody = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult();
                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""{"ok":true}""")
                };
            })),
            NullLogger<TelegramChannelSender>.Instance);

        var channel = new NotificationChannelConfig
        {
            Id = "telegram-1",
            Type = "telegram",
            Name = "Ops Telegram",
            Settings = new Dictionary<string, object?>
            {
                ["botToken"] = "123456:ABC-DEF",
                ["chatId"] = "-1001234567890",
            }
        };

        var result = await sender.SendAsync(channel, "Charge complete", "Battery is at 100%.", "info", CancellationToken.None);

        Assert.Equal("sent", result);
        Assert.Contains("123456%3AABC-DEF", requestUri?.AbsoluteUri);
        Assert.Contains("/sendMessage", requestUri?.AbsoluteUri);
        Assert.NotNull(requestBody);

        using var document = JsonDocument.Parse(requestBody!);
        Assert.Equal("-1001234567890", document.RootElement.GetProperty("chat_id").GetString());
        Assert.Equal("*Charge complete*\nBattery is at 100%.", document.RootElement.GetProperty("text").GetString());
    }

    [Fact]
    public async Task TelegramChannelSender_SendAsync_RequiresChatId()
    {
        var sender = new TelegramChannelSender(
            new StubHttpClientFactory(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK))),
            NullLogger<TelegramChannelSender>.Instance);

        var channel = new NotificationChannelConfig
        {
            Id = "telegram-1",
            Type = "telegram",
            Name = "Ops Telegram",
            Settings = new Dictionary<string, object?>
            {
                ["botToken"] = "123456:ABC-DEF",
            }
        };

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            sender.SendAsync(channel, "Test", "Body", "info", CancellationToken.None));

        Assert.Equal("Telegram chat ID is required.", exception.Message);
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(responder(request));
        }
    }
}