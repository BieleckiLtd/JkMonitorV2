using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DirectAccessServiceTests
{
    [Fact]
    public void BuildDefaultWifiSsid_SanitizesAndLimitsHostName()
    {
        var ssid = DirectAccessService.BuildDefaultWifiSsid("Pi Rack / East Wing #01");

        Assert.Equal("FluxMonitor-Pi-Rack-East-Wing-01", ssid);
        Assert.True(ssid.Length <= 32);
    }

    [Fact]
    public void BuildDefaultWifiPassword_IsStableForTheSameIdentity()
    {
        var first = DirectAccessService.BuildDefaultWifiPassword("device-identity-123");
        var second = DirectAccessService.BuildDefaultWifiPassword("device-identity-123");

        Assert.Equal(first, second);
        Assert.StartsWith("Flux", first, StringComparison.Ordinal);
        Assert.Equal(16, first.Length);
    }

    [Fact]
    public void ParseActiveConnectionLine_UnescapesEscapedNmcliFields()
    {
        var connection = DirectAccessService.ParseActiveConnectionLine(@"FluxMonitor\:Direct:802-11-wireless:wlan0");

        Assert.NotNull(connection);
        Assert.Equal("FluxMonitor:Direct", connection!.Name);
        Assert.Equal("802-11-wireless", connection.Type);
        Assert.Equal("wlan0", connection.Device);
    }
}
