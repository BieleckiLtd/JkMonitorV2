using System.Net;
using System.Net.Http;
using System.Text.Json;
using JkMonitor.Backend.Models;
using JkMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace JkMonitor.Backend.Tests;

public class NotificationChannelSendersTests
{
    [Fact]
    public async Task WhatsAppChannelSender_SendAsync_PostsExpectedCloudApiRequest()
    {
        Uri? requestUri = null;
        string? authorizationScheme = null;
        string? authorizationToken = null;
        string? requestBody = null;

        var sender = new WhatsAppChannelSender(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                requestUri = request.RequestUri;
                authorizationScheme = request.Headers.Authorization?.Scheme;
                authorizationToken = request.Headers.Authorization?.Parameter;
                requestBody = request.Content?.ReadAsStringAsync().GetAwaiter().GetResult();

                return new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""
                        {
                          "messages": [
                            {
                              "id": "wamid.test-123"
                            }
                          ]
                        }
                        """)
                };
            })),
            NullLogger<WhatsAppChannelSender>.Instance);

        var channel = new NotificationChannelConfig
        {
            Id = "whatsapp-1",
            Type = "whatsapp",
            Name = "Ops WhatsApp",
            Settings = new Dictionary<string, object?>
            {
                ["apiVersion"] = "v22.0",
                ["phoneNumberId"] = "123456789012345",
                ["recipientNumber"] = "+44 7700 900123",
                ["accessToken"] = "access-token-123",
                ["previewUrl"] = true,
            }
        };

        var result = await sender.SendAsync(channel, "Charge complete", "Battery is at 100%.", "info", CancellationToken.None);

        Assert.Equal("sent (wamid.test-123)", result);
        Assert.Equal("https://graph.facebook.com/v22.0/123456789012345/messages", requestUri?.AbsoluteUri);
        Assert.Equal("Bearer", authorizationScheme);
        Assert.Equal("access-token-123", authorizationToken);
        Assert.NotNull(requestBody);

        using var document = JsonDocument.Parse(requestBody!);
        Assert.Equal("whatsapp", document.RootElement.GetProperty("messaging_product").GetString());
        Assert.Equal("individual", document.RootElement.GetProperty("recipient_type").GetString());
        Assert.Equal("447700900123", document.RootElement.GetProperty("to").GetString());
        Assert.Equal("text", document.RootElement.GetProperty("type").GetString());
        Assert.True(document.RootElement.GetProperty("text").GetProperty("preview_url").GetBoolean());
        Assert.Equal("Charge complete\nBattery is at 100%.", document.RootElement.GetProperty("text").GetProperty("body").GetString());
    }

    [Fact]
    public async Task WhatsAppChannelSender_SendAsync_RequiresRecipientNumber()
    {
        var sender = new WhatsAppChannelSender(
            new StubHttpClientFactory(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK))),
            NullLogger<WhatsAppChannelSender>.Instance);

        var channel = new NotificationChannelConfig
        {
            Id = "whatsapp-1",
            Type = "whatsapp",
            Name = "Ops WhatsApp",
            Settings = new Dictionary<string, object?>
            {
                ["apiVersion"] = "v22.0",
                ["phoneNumberId"] = "123456789012345",
                ["recipientNumber"] = "   ",
                ["accessToken"] = "access-token-123",
            }
        };

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            sender.SendAsync(channel, "Charge complete", "Battery is at 100%.", "info", CancellationToken.None));

        Assert.Equal("WhatsApp recipient number is required.", exception.Message);
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