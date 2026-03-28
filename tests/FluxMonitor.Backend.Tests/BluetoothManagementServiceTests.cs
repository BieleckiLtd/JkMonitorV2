using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class BluetoothManagementServiceTests
{
    [Fact]
    public void DescribeRfkillBlockState_ReturnsHardBlockedMessage()
    {
        var message = BluetoothManagementService.DescribeRfkillBlockState(softBlocked: false, hardBlocked: true);

        Assert.Equal("Bluetooth is hard-blocked by rfkill.", message);
    }

    [Fact]
    public void DescribeRfkillBlockState_ReturnsSoftBlockedMessage()
    {
        var message = BluetoothManagementService.DescribeRfkillBlockState(softBlocked: true, hardBlocked: false);

        Assert.Equal("Bluetooth is soft-blocked by rfkill.", message);
    }

    [Fact]
    public void DescribeRfkillBlockState_ReturnsNullWhenUnblocked()
    {
        var message = BluetoothManagementService.DescribeRfkillBlockState(softBlocked: false, hardBlocked: false);

        Assert.Null(message);
    }
}
