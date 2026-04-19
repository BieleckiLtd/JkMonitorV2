using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DeviceDefinitionLoaderTests : IDisposable
{
    private readonly string _tempRoot = Path.Combine(Path.GetTempPath(), $"fluxmonitor-loader-{Guid.NewGuid():N}");

    [Fact]
    public void ResolveDefinitionsPath_UsesConfiguredDirectoryWhenItExists()
    {
        var configuredDirectory = Path.Combine(_tempRoot, "custom-definitions");
        Directory.CreateDirectory(configuredDirectory);

        var resolved = DeviceDefinitionLoader.ResolveDefinitionsPath("custom-definitions", _tempRoot);

        Assert.Equal(Path.GetFullPath(configuredDirectory), resolved);
    }

    [Fact]
    public void ResolveDefinitionsPath_ReturnsConfiguredDirectoryEvenWhenItDoesNotExist()
    {
        var resolved = DeviceDefinitionLoader.ResolveDefinitionsPath("custom-definitions", _tempRoot);

        Assert.Equal(Path.GetFullPath(Path.Combine(_tempRoot, "custom-definitions")), resolved);
    }

    [Fact]
    public void LoadFromJson_CachesDefinitionWithoutWritingToDisk()
    {
        var definitionsDirectory = Path.Combine(_tempRoot, "custom-definitions");
        var loader = new DeviceDefinitionLoader(
            "custom-definitions",
            _tempRoot,
            new SimpleHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);

        var definition = loader.LoadFromJson("""
            {
              "version": "1",
              "device": {
                "id": "test-device",
                "name": "Test Device"
              },
              "connection": {
                "transport": {
                  "type": "serial"
                },
                "protocol": {
                  "type": "modbus-rtu"
                }
              },
              "dataSources": [],
              "pollGroups": {},
              "entities": []
            }
            """);

        Assert.Equal("test-device", definition.Device.Id);
        Assert.True(loader.TryGet("test-device", out var cached));
        Assert.NotNull(cached);
        Assert.False(Directory.Exists(definitionsDirectory));
    }

    [Fact]
    public void LoadAll_AnenjiOutputSettingsAreWritable()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..", "..")),
            new SimpleHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);

        loader.LoadAll();

        Assert.True(loader.TryGet("anenji-inverter-rs232", out var definition));
        Assert.NotNull(definition);

        var outputVoltage = Assert.Single(definition!.Entities, entity => entity.Id == "output_voltage_setting");
        var outputFrequency = Assert.Single(definition.Entities, entity => entity.Id == "output_frequency_setting");

        Assert.True(outputVoltage.Writable);
        Assert.NotNull(outputVoltage.Write);
        Assert.Equal(606, outputVoltage.Write!.Address);
        Assert.True(outputFrequency.Writable);
        Assert.NotNull(outputFrequency.Write);
        Assert.Equal(607, outputFrequency.Write!.Address);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempRoot))
        {
            Directory.Delete(_tempRoot, recursive: true);
        }
    }

    private sealed class SimpleHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}





