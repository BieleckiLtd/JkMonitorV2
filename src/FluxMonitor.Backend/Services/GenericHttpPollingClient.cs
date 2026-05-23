using System.Net.Http.Headers;
using System.Text;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

public sealed class GenericHttpPollingClient(
    IHttpClientFactory httpClientFactory,
    DefinitionDrivenTelemetryBuilder telemetryBuilder,
    DeviceDefinitionLoader definitionLoader,
    ILogger<GenericHttpPollingClient> logger) : IDevicePollingClient
{
    public static bool IsDefinitionSupported(DeviceDefinition definition)
        => string.Equals(definition.Connection.Transport.Type, "http", StringComparison.OrdinalIgnoreCase)
           && string.Equals(definition.Connection.Protocol.Type, "http-json", StringComparison.OrdinalIgnoreCase);

    public static string? GetUnsupportedDefinitionMessage(DeviceDefinition definition)
    {
        if (!string.Equals(definition.Connection.Transport.Type, "http", StringComparison.OrdinalIgnoreCase))
            return null;

        return string.Equals(definition.Connection.Protocol.Type, "http-json", StringComparison.OrdinalIgnoreCase)
            ? null
            : $"HTTP transport currently supports only the 'http-json' protocol, not '{definition.Connection.Protocol.Type}'.";
    }

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
        {
            throw new InvalidOperationException(
                $"Device '{device.DeviceId}' has no valid DefinitionId ('{device.DefinitionId}').");
        }

        return PollAsync(device, definition, cancellationToken);
    }

    public async Task<DevicePollResult> PollAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        if (!IsDefinitionSupported(definition))
        {
            throw new NotSupportedException(
                GetUnsupportedDefinitionMessage(definition)
                ?? $"HTTP definition '{definition.Device.Id}' is not supported.");
        }

        var endpoint = device.TransportPortName?.Trim();
        if (string.IsNullOrWhiteSpace(endpoint))
            throw new InvalidOperationException($"Device '{device.DeviceId}' requires an HTTP host or base URL.");

        var baseUri = BuildBaseUri(endpoint);
        var protocolSettings = definition.Connection.Protocol.Settings ?? new ProtocolSettings();
        var configuredReadTimeoutMs = definition.Connection.Transport.Defaults?.ReadTimeoutMs;
        var readTimeoutMs = configuredReadTimeoutMs is > 0
            ? configuredReadTimeoutMs.Value
            : 1000;
        var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        var client = httpClientFactory.CreateClient();

        foreach (var bank in definition.DataSources)
        {
            using var request = BuildRequest(baseUri, bank, device, protocolSettings);
            using var requestCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            requestCts.CancelAfter(readTimeoutMs);

            try
            {
                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, requestCts.Token);
                if (!response.IsSuccessStatusCode)
                {
                    if (bank.Optional)
                    {
                        logger.LogWarning(
                            "Optional HTTP bank '{BankId}' returned {StatusCode} for device {DeviceId}.",
                            bank.Id,
                            (int)response.StatusCode,
                            device.DeviceId);
                        continue;
                    }

                    throw new HttpRequestException(
                        $"HTTP bank '{bank.Id}' returned {(int)response.StatusCode} ({response.ReasonPhrase}) for device '{device.DeviceId}'.");
                }

                var payload = await response.Content.ReadAsByteArrayAsync(requestCts.Token);
                if (bank.ResponseLayout is not null)
                    payload = ResponseLayoutNormalizer.Normalize(payload, bank.ResponseLayout);

                bankData[bank.Id] = payload;
            }
            catch (Exception ex) when (bank.Optional && ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Optional HTTP bank '{BankId}' read failed for device {DeviceId}.", bank.Id, device.DeviceId);
            }
        }

        return telemetryBuilder.BuildPollResult(definition, bankData, DateTimeOffset.UtcNow);
    }

    private static HttpRequestMessage BuildRequest(
        Uri baseUri,
        DataSourceDefinition bank,
        DeviceConfiguration device,
        ProtocolSettings protocolSettings)
    {
        var requestUri = string.IsNullOrWhiteSpace(bank.RequestPath)
            ? baseUri
            : new Uri(baseUri, bank.RequestPath);
        var method = new HttpMethod(string.IsNullOrWhiteSpace(bank.RequestMethod) ? "GET" : bank.RequestMethod.Trim().ToUpperInvariant());
        var request = new HttpRequestMessage(method, requestUri);

        ApplyBasicAuth(request, device, protocolSettings);
        return request;
    }

    private static void ApplyBasicAuth(HttpRequestMessage request, DeviceConfiguration device, ProtocolSettings protocolSettings)
    {
        var username = !string.IsNullOrWhiteSpace(device.HttpUsername)
            ? device.HttpUsername.Trim()
            : protocolSettings.HttpDefaultUsername?.Trim();
        var password = device.HttpPassword;

        if (string.IsNullOrWhiteSpace(username) && string.IsNullOrWhiteSpace(password))
            return;

        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{username ?? string.Empty}:{password ?? string.Empty}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", token);
    }

    private static Uri BuildBaseUri(string endpoint)
    {
        var normalized = endpoint.Trim();
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out var uri))
        {
            normalized = $"http://{normalized}";
            if (!Uri.TryCreate(normalized, UriKind.Absolute, out uri))
                throw new InvalidOperationException($"HTTP endpoint '{endpoint}' is not a valid URI.");
        }

        if (!uri.AbsoluteUri.EndsWith("/", StringComparison.Ordinal))
            uri = new Uri($"{uri.AbsoluteUri}/", UriKind.Absolute);

        return uri;
    }
}