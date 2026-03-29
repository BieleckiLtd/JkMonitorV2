using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using System.Net.NetworkInformation;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class NetworkManagementServiceTests
{
    [Fact]
    public void SplitNmcliFields_UnescapesColonsAndBackslashes()
    {
        var fields = NetworkManagementService.SplitNmcliFields(@"*:AA\:BB\:CC\:DD\:EE\:FF:My\\WiFi:78:WPA2:▂▄▆_");

        Assert.Equal(6, fields.Length);
        Assert.Equal("*", fields[0]);
        Assert.Equal("AA:BB:CC:DD:EE:FF", fields[1]);
        Assert.Equal(@"My\WiFi", fields[2]);
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

    [Fact]
    public void ParseWifiAccessPoints_KeepsDistinctNetworksAndDeduplicatesByBssidAndSsid()
    {
        var output = string.Join('\n', [
            @":AA\:AA\:AA\:AA\:AA\:AA:FIVE_EXT:34:WPA2:▂▄__",
            @":BB\:BB\:BB\:BB\:BB\:BB:FIVE:71:WPA2:▂___",
            @"*:CC\:CC\:CC\:CC\:CC\:CC:FIVE_5G_EXT:36:WPA2:▂▄▆_",
            @":DD\:DD\:DD\:DD\:DD\:DD:FIVE_5G:57:WPA2:▂▄▆_",
            @":DD\:DD\:DD\:DD\:DD\:DD:FIVE_5G:43:WPA2:▂▄__"
        ]);

        var accessPoints = NetworkManagementService.ParseWifiAccessPoints(output, "wlan0");

        Assert.Collection(
            accessPoints,
            accessPoint =>
            {
                Assert.Equal("FIVE", accessPoint.Ssid);
                Assert.Equal(71, accessPoint.SignalPercent);
            },
            accessPoint =>
            {
                Assert.Equal("FIVE_5G", accessPoint.Ssid);
                Assert.Equal("DD:DD:DD:DD:DD:DD", accessPoint.Bssid);
                Assert.Equal(57, accessPoint.SignalPercent);
            },
            accessPoint =>
            {
                Assert.Equal("FIVE_5G_EXT", accessPoint.Ssid);
                Assert.True(accessPoint.IsActive);
                Assert.Equal(36, accessPoint.SignalPercent);
            },
            accessPoint =>
            {
                Assert.Equal("FIVE_EXT", accessPoint.Ssid);
                Assert.Equal(34, accessPoint.SignalPercent);
            });
    }

    [Fact]
    public void CountVisibleWifiNetworks_IgnoresHiddenEntriesAndDeduplicatesBySsid()
    {
        var accessPoints = new[]
        {
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_EXT", Bssid = "AA:AA:AA:AA:AA:AA" },
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_5G", Bssid = "BB:BB:BB:BB:BB:BB" },
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_5G", Bssid = "CC:CC:CC:CC:CC:CC" },
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "<hidden>", Bssid = "DD:DD:DD:DD:DD:DD" }
        };

        Assert.Equal(2, NetworkManagementService.CountVisibleWifiNetworks(accessPoints));
    }

    [Fact]
    public void ShouldRetryWifiAccessPointRead_RetriesWhenOnlyOneVisibleNetworkIsPresent()
    {
        var accessPoints = new[]
        {
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_EXT", Bssid = "AA:AA:AA:AA:AA:AA" },
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "<hidden>", Bssid = "BB:BB:BB:BB:BB:BB" }
        };

        Assert.True(NetworkManagementService.ShouldRetryWifiAccessPointRead(accessPoints, attempt: 0));
        Assert.False(NetworkManagementService.ShouldRetryWifiAccessPointRead(accessPoints, attempt: 4));
    }

    [Fact]
    public void IsBetterWifiAccessPointRead_PrefersMoreVisibleNetworksOverPartialRead()
    {
        var partialRead = new[]
        {
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_EXT", Bssid = "AA:AA:AA:AA:AA:AA", IsActive = true }
        };

        var fullerRead = new[]
        {
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_EXT", Bssid = "AA:AA:AA:AA:AA:AA", IsActive = true },
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "FIVE_5G_EXT", Bssid = "BB:BB:BB:BB:BB:BB" },
            new WifiAccessPointInfo { InterfaceName = "wlan0", Ssid = "TeslaPW_EWJRDG", Bssid = "CC:CC:CC:CC:CC:CC" }
        };

        Assert.True(NetworkManagementService.IsBetterWifiAccessPointRead(fullerRead, partialRead));
        Assert.False(NetworkManagementService.IsBetterWifiAccessPointRead(partialRead, fullerRead));
    }

    [Fact]
    public void ParseIwAccessPoints_ParsesVisibleAndHiddenNetworks()
    {
        var output = """
            BSS 90:9a:4a:16:de:b4(on wlan0) -- associated
            	signal: -34.00 dBm
            	SSID: FIVE_EXT
            	RSN:
            		 * Version: 1
            		 * Authentication suites: PSK
            BSS 16:11:32:ab:4f:fe(on wlan0)
            	signal: -70.00 dBm
            	capability: ESS Privacy ShortPreamble (0x0031)
            BSS 92:03:71:45:57:31(on wlan0)
            	signal: -67.00 dBm
            	SSID: TeslaPW_EWJRDG
            	WPA:
            		 * Version: 1
            """;

        var accessPoints = NetworkManagementService.ParseIwAccessPoints(output, "wlan0");

        Assert.Collection(
            accessPoints,
            accessPoint =>
            {
                Assert.Equal("FIVE_EXT", accessPoint.Ssid);
                Assert.Equal("90:9A:4A:16:DE:B4", accessPoint.Bssid);
                Assert.True(accessPoint.IsActive);
                Assert.Equal("WPA2", accessPoint.Security);
                Assert.Equal("▂▄▆█", accessPoint.SignalBars);
            },
            accessPoint =>
            {
                Assert.Equal("TeslaPW_EWJRDG", accessPoint.Ssid);
                Assert.Equal("WPA", accessPoint.Security);
                Assert.False(accessPoint.IsActive);
            },
            accessPoint =>
            {
                Assert.Equal("<hidden>", accessPoint.Ssid);
                Assert.Equal("WEP", accessPoint.Security);
                Assert.False(accessPoint.IsActive);
            });
    }

    [Theory]
    [InlineData(-34, 100)]
    [InlineData(-67, 66)]
    [InlineData(-80, 40)]
    public void ConvertSignalDbmToPercent_MapsExpectedRanges(double signalDbm, int expected)
    {
        Assert.Equal(expected, NetworkManagementService.ConvertSignalDbmToPercent(signalDbm));
    }

    [Fact]
    public void ResolveInterfaceKind_UsesInterfaceNameHeuristicsForWifi()
    {
        var kind = NetworkManagementService.ResolveInterfaceKind(
            "wlan0",
            "wlan0",
            NetworkInterfaceType.Unknown,
            networkManagerType: null);

        Assert.Equal("wifi", kind);
    }

    [Fact]
    public void ResolveInterfaceKind_PrefersNetworkManagerType()
    {
        var kind = NetworkManagementService.ResolveInterfaceKind(
            "eth0",
            "Ethernet controller",
            NetworkInterfaceType.Ethernet,
            networkManagerType: "wifi");

        Assert.Equal("wifi", kind);
    }

    [Theory]
    [InlineData("enabled", true)]
    [InlineData("disabled", false)]
    [InlineData("on", true)]
    [InlineData("off", false)]
    public void ParseWifiRadioState_ParsesExpectedValues(string value, bool expected)
    {
        Assert.Equal(expected, NetworkManagementService.ParseWifiRadioState(value));
    }

    [Theory]
    [InlineData("full", true)]
    [InlineData("limited", false)]
    [InlineData("portal", false)]
    [InlineData("none", false)]
    [InlineData("unknown", null)]
    public void ParseInternetAccessState_ParsesExpectedValues(string value, bool? expected)
    {
        Assert.Equal(expected, NetworkManagementService.ParseInternetAccessState(value));
    }

    [Theory]
    [InlineData("Error: Connection activation failed: Secrets were required, but not provided.", true)]
    [InlineData("Error: Connection activation failed: invalid secrets.", true)]
    [InlineData("Error: No network with SSID 'missing' found.", false)]
    public void IsWrongWifiPasswordMessage_DetectsExpectedErrors(string message, bool expected)
    {
        Assert.Equal(expected, NetworkManagementService.IsWrongWifiPasswordMessage(message));
    }

    [Fact]
    public void BuildWifiConnectFailureMessage_MapsWrongPasswordToFriendlyText()
    {
        var result = new NetworkManagementService.ProcessResult(
            Succeeded: false,
            StandardOutput: string.Empty,
            ErrorOutput: "Error: Connection activation failed: Secrets were required, but not provided.",
            ExitCode: 10);

        var message = NetworkManagementService.BuildWifiConnectFailureMessage("Home WiFi", result);

        Assert.Equal("Incorrect Wi-Fi password for 'Home WiFi'.", message);
    }

    [Fact]
    public void BuildWifiConnectSuccessMessage_ReportsNoInternet()
    {
        var result = new NetworkManagementService.ProcessResult(
            Succeeded: true,
            StandardOutput: "Device 'wlan0' successfully activated.",
            ErrorOutput: string.Empty,
            ExitCode: 0);

        var message = NetworkManagementService.BuildWifiConnectSuccessMessage("Home WiFi", false, result);

        Assert.Equal("Connected to 'Home WiFi', but internet access is unavailable.", message);
    }
}
