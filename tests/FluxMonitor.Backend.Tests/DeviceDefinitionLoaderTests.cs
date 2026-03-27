using FluxMonitor.Backend.Services;
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
    public void ResolveDefinitionsPath_FallsBackToBundledDirectoryWhenConfiguredDirectoryIsMissing()
    {
        var bundledDirectory = Path.Combine(_tempRoot, "devices");
        Directory.CreateDirectory(bundledDirectory);

        var resolved = DeviceDefinitionLoader.ResolveDefinitionsPath("../../../devices", _tempRoot);

        Assert.Equal(Path.GetFullPath(bundledDirectory), resolved);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempRoot))
        {
            Directory.Delete(_tempRoot, recursive: true);
        }
    }
}
