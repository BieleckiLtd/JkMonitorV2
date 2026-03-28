using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class NetworkManagementServiceTests
{
    [Fact]
    public void SplitNmcliFields_UnescapesColonsAndBackslashes()
    {
        var fields = NetworkManagementService.SplitNmcliFields(@"*\:AA\:BB\:CC\:DD\:EE\:FF:My\\:WiFi:78:WPA2:▂▄▆_");

        Assert.Equal(6, fields.Length);
        Assert.Equal("*:AA:BB:CC:DD:EE:FF", fields[0]);
        Assert.Equal("My\\", fields[1]);
        Assert.Equal("WiFi", fields[2]);
        Assert.Equal("78", fields[3]);
        Assert.Equal("WPA2", fields[4]);
    }

    [Fact]
    public void ParseWifiAccessPointLine_MapsActiveNetwork()
    {
        var accessPoint = NetworkManagementService.ParseWifiAccessPointLine(@"*:AA\:BB\:CC\:DD\:EE\:FF:Home WiFi:67:WPA2 WPA3:▂▄▆_", "wlan0");

        Assert.NotNull(accessPoint);
        Assert.Equal("wlan0", accessPoint!.InterfaceName);
        Assert.Equal("Home WiFi", accessPoint.Ssid);
        Assert.Equal("AA:BB:CC:DD:EE:FF", accessPoint.Bssid);
        Assert.Equal(67, accessPoint.SignalPercent);
        Assert.Equal("WPA2 WPA3", accessPoint.Security);
        Assert.True(accessPoint.IsActive);
    }

    [Fact]
    public void ParseWifiAccessPointLine_UsesHiddenLabelForBlankSsid()
    {
        var accessPoint = NetworkManagementService.ParseWifiAccessPointLine(@":11\:22\:33\:44\:55\:66::40:--:▂___", "wlan0");

        Assert.NotNull(accessPoint);
        Assert.Equal("<hidden>", accessPoint!.Ssid);
        Assert.Null(accessPoint.Security);
        Assert.False(accessPoint.IsActive);
    }
}
