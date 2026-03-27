using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using Microsoft.Extensions.Logging.Abstractions;
using System.Net.Http;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DevicePollingIntervalResolverTests
{
    [Fact]
    public void Resolve_UsesFastestPollGroupInterval()
    {
        var definition = new DeviceDefinition
        {
            Version = "1.0",
            Device = new DeviceMetadata
            {
                Id = "test-device",
                Name = "Test Device"
            },
            Connection = new ConnectionDefinition
            {
                Transport = new TransportDefinition
                {
                    Type = "serial"
                },
                Protocol = new ProtocolDefinition
                {
                    Type = "modbus"
                }
            },
            DataSources = [],
            PollGroups = new Dictionary<string, PollGroupDefinition>
            {
                ["slow"] = new() { IntervalMs = 30_000 },
                ["fast"] = new() { IntervalMs = 1_000 },
                ["medium"] = new() { IntervalMs = 5_000 }
            },
            Entities = []
        };

        var resolved = DevicePollingIntervalResolver.Resolve(definition);

        Assert.Equal(1_000, resolved);
    }

    [Fact]
    public void Normalize_ReplacesConfiguredIntervalWithDefinitionInterval()
    {
        var definitionLoader = new DeviceDefinitionLoader(
            "devices",
            Directory.GetCurrentDirectory(),
            new StubHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        definitionLoader.LoadAll();

        var device = new DeviceConfiguration
        {
            DeviceId = "device-01",
            DisplayName = "Device 01",
            DefinitionId = "jk-inverter-bms",
            PollIntervalMilliseconds = 9_999
        };

        var normalized = DevicePollingIntervalResolver.Normalize(device, definitionLoader);

        Assert.Equal(1_000, normalized.PollIntervalMilliseconds);
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
