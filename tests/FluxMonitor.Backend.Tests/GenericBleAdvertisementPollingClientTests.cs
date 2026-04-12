using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class GenericBleAdvertisementPollingClientTests
{
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
