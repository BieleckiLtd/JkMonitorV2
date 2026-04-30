using System.Net;
using System.Net.Http;
using System.Text.Json;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class ConfiguredDeviceDefinitionExtensionsTests
{
    [Fact]
    public void TryResolveDefinition_PrefersCatalogDefinition_WhenDeviceHasNoOverride()
    {
        var loader = CreateLoader();
        loader.LoadFromJson(CreateDefinitionJson("catalog-v2", "Catalog Definition"));

        var device = new DeviceConfiguration
        {
            DeviceId = "jk1",
            DisplayName = "JK",
            DefinitionId = "jk-test",
            DefinitionJson = CreateDefinitionJson("snapshot-v1", "Stored Snapshot")
        };

        var resolved = device.TryResolveDefinition(loader, out var definition);

        Assert.True(resolved);
        Assert.NotNull(definition);
        Assert.Equal("catalog-v2", definition!.Version);
        Assert.Equal("Catalog Definition", definition.Device.Name);
    }

    [Fact]
    public void TryResolveDefinition_PrefersStoredSnapshot_WhenDeviceHasOverride()
    {
        var loader = CreateLoader();
        loader.LoadFromJson(CreateDefinitionJson("catalog-v2", "Catalog Definition"));

        var device = new DeviceConfiguration
        {
            DeviceId = "jk1",
            DisplayName = "JK",
            DefinitionId = "jk-test",
            HasDefinitionOverride = true,
            DefinitionJson = CreateDefinitionJson("snapshot-v1", "Stored Snapshot")
        };

        var resolved = device.TryResolveDefinition(loader, out var definition);

        Assert.True(resolved);
        Assert.NotNull(definition);
        Assert.Equal("snapshot-v1", definition!.Version);
        Assert.Equal("Stored Snapshot", definition.Device.Name);
    }

    private static DeviceDefinitionLoader CreateLoader()
    {
        return new DeviceDefinitionLoader(
        "devices",
            AppContext.BaseDirectory,
            new StaticHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);
    }

    private static string CreateDefinitionJson(string version, string name)
    {
      var definition = new DeviceDefinition
        {
        Version = version,
        Device = new DeviceMetadata
            {
          Id = "jk-test",
          Name = name
        },
        Connection = new ConnectionDefinition
        {
          Transport = new TransportDefinition { Type = "test" },
          Protocol = new ProtocolDefinition { Type = "test" }
        },
        DataSources = [],
        PollGroups = new Dictionary<string, PollGroupDefinition>(),
        Entities = []
      };

      return JsonSerializer.Serialize(definition);
    }

    private sealed class StaticHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
            => new(new StaticHttpMessageHandler());
    }

    private sealed class StaticHttpMessageHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    }
}