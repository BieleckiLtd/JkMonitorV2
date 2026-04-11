using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class WebTerminalServiceTests
{
    [Fact]
    public async Task GetSnapshotAsync_ReturnsSupportedSnapshot_WhenLinuxRuntimeIsAvailable()
    {
        var service = new WebTerminalService(
            new StubWebTerminalAccessStore(new WebTerminalAccessStore.WebTerminalAccessSettings(StorageAvailable: true, Enabled: true)),
            NullLogger<WebTerminalService>.Instance,
            () => true,
            fileName => fileName switch
            {
                "script" => "/usr/bin/script",
                "bash" => "/bin/bash",
                _ => null
            });

        var snapshot = await service.GetSnapshotAsync(TestContext.Current.CancellationToken);

        Assert.True(snapshot.Supported);
        Assert.True(snapshot.Enabled);
        Assert.True(snapshot.StorageAvailable);
        Assert.Equal("/bin/bash", snapshot.ShellPath);
        Assert.Equal("pty-via-script", snapshot.Transport);
        Assert.Equal("Web terminal access is enabled.", snapshot.StatusMessage);
    }

    [Fact]
    public async Task SetEnabledAsync_PersistsAndReturnsUpdatedSnapshot()
    {
        var store = new StubWebTerminalAccessStore(new WebTerminalAccessStore.WebTerminalAccessSettings(StorageAvailable: true, Enabled: true));
        var service = new WebTerminalService(
            store,
            NullLogger<WebTerminalService>.Instance,
            () => true,
            fileName => fileName switch
            {
                "script" => "/usr/bin/script",
                "bash" => "/bin/bash",
                _ => null
            });

        var result = await service.SetEnabledAsync(enabled: false, TestContext.Current.CancellationToken);

        Assert.True(result.Success);
        Assert.False(result.Enabled);
        Assert.Equal("Web terminal access was disabled.", result.Message);
        Assert.False(result.Snapshot.Enabled);
        Assert.False(store.Settings.Enabled);
    }

    [Fact]
    public async Task GetSnapshotAsync_ReturnsUnsupported_WhenRequiredRuntimeIsMissing()
    {
        var service = new WebTerminalService(
            new StubWebTerminalAccessStore(new WebTerminalAccessStore.WebTerminalAccessSettings(StorageAvailable: false, Enabled: true)),
            NullLogger<WebTerminalService>.Instance,
            () => true,
            _ => null);

        var snapshot = await service.GetSnapshotAsync(TestContext.Current.CancellationToken);

        Assert.False(snapshot.Supported);
        Assert.True(snapshot.Enabled);
        Assert.Equal("The web terminal is supported on Linux hosts with bash and script installed.", snapshot.StatusMessage);
    }

    private sealed class StubWebTerminalAccessStore(WebTerminalAccessStore.WebTerminalAccessSettings initialSettings) : IWebTerminalAccessStore
    {
        public WebTerminalAccessStore.WebTerminalAccessSettings Settings { get; private set; } = initialSettings;

        public Task InitializeAsync(CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }

        public Task<WebTerminalAccessStore.WebTerminalAccessSettings> GetSettingsAsync(CancellationToken cancellationToken)
        {
            return Task.FromResult(Settings);
        }

        public Task SaveSettingsAsync(bool enabled, CancellationToken cancellationToken)
        {
            Settings = Settings with { Enabled = enabled };
            return Task.CompletedTask;
        }
    }
}
