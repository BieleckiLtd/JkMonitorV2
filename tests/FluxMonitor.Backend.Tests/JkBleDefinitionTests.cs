using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class JkBleDefinitionTests
{
    private static readonly string RepositoryRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void JkBleLiveBank_RemainsCommandDriven()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            RepositoryRoot,
            new HttpClientFactoryStub(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        loader.LoadFromJson(File.ReadAllText(Path.Combine(RepositoryRoot, "devices", "jk-inverter-bms-ble.json")));

        var definition = loader.Get("jk-inverter-bms-ble");
        var liveBank = Assert.Single(definition.DataSources, bank => bank.Id == "live");

        Assert.Equal("request-response", liveBank.ReadMode);
    }

    private sealed class HttpClientFactoryStub : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
