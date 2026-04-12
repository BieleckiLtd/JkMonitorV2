using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class GenericBleAdvertisementPollingClientTests
{
    [Fact]
    public void TryDecodeGoveeH5075Payload_DecodesPrefixedPayloadAndMasksBattery()
    {
        var ok = GenericBleAdvertisementPollingClient.TryDecodeGoveeH5075Payload(
            [0x00, 0x03, 0x45, 0xB5, 0xE4, 0x00],
            out var buffer);

        Assert.True(ok);
        Assert.NotNull(buffer);
        Assert.Equal(new byte[] { 0x00, 0xD6, 0x01, 0xC5, 0x64 }, buffer);
    }

    [Fact]
    public void TryDecodeGoveeH5075Payload_DecodesCompactPayloadAndMasksBattery()
    {
        var ok = GenericBleAdvertisementPollingClient.TryDecodeGoveeH5075Payload(
            [0x80, 0x5B, 0xA1, 0xE3],
            out var buffer);

        Assert.True(ok);
        Assert.NotNull(buffer);
        Assert.Equal(new byte[] { 0xFF, 0xE9, 0x01, 0xC9, 0x63 }, buffer);
    }

    [Theory]
    [InlineData(-45, 100)]
    [InlineData(-70, 50)]
    [InlineData(-95, 0)]
    [InlineData(-105, 0)]
    [InlineData(-30, 100)]
    public void ConvertRssiToSignalStrengthPercent_ClampsIntoExpectedRange(int rssi, int expectedPercent)
    {
        var percent = GenericBleAdvertisementPollingClient.ConvertRssiToSignalStrengthPercent(rssi);

        Assert.Equal(expectedPercent, percent);
    }

    [Fact]
    public void ConvertRssiToSignalStrengthPercent_ReturnsNullWhenRssiMissing()
    {
        var percent = GenericBleAdvertisementPollingClient.ConvertRssiToSignalStrengthPercent(null);

        Assert.Null(percent);
    }
}
