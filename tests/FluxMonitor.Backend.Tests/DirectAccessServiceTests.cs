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
    public void BuildWifiSecurityArguments_UsesOpenNetworkWhenPasswordIsBlank()
    {
        var arguments = DirectAccessService.BuildWifiSecurityArguments(string.Empty);

        Assert.Empty(arguments);
    }

    [Fact]
    public void BuildWifiSecurityArguments_UsesWpaPskForStandardPasswords()
    {
        var arguments = DirectAccessService.BuildWifiSecurityArguments("password1");

        Assert.Equal(
            [
                "802-11-wireless-security.key-mgmt",
                "wpa-psk",
                "802-11-wireless-security.psk",
                "password1"
            ],
            arguments);
    }

    [Fact]
    public void BuildWifiSecurityArguments_UsesSaeForShortPasswords()
    {
        var arguments = DirectAccessService.BuildWifiSecurityArguments("abc");

        Assert.Equal(
            [
                "802-11-wireless-security.key-mgmt",
                "sae",
                "802-11-wireless-security.psk",
                "abc"
            ],
            arguments);
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

    [Fact]
    public void NormalizeWifiPassword_PreservesWhitespaceOnlyPassword()
    {
        Assert.Equal("   ", DirectAccessStore.NormalizeWifiPassword("   "));
    }

    [Fact]
    public void BuildSettingsSavedMessage_ReportsRestartWhenPasswordChangesAndWifiIsActive()
    {
        var message = DirectAccessService.BuildSettingsSavedMessage(
            new DirectAccessStore.DirectAccessSettings(true, DirectAccessStore.AutoStartModeWhenWifiNotConnected, null, null, null),
            new DirectAccessStore.DirectAccessSettings(true, DirectAccessStore.AutoStartModeWhenWifiNotConnected, "abc", null, null),
            directWifiActive: true);

        Assert.Equal("Fallback local access settings were saved. Changes apply the next time fallback local access starts.", message);
    }
}
