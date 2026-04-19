using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class ModbusScannerServiceTests
{
    [Fact]
    public void CreatePortOpenException_IncludesBusyHintForBusyPorts()
    {
        var exception = new UnauthorizedAccessException(
            "Access to the port '/dev/ttyUSB0' is denied.",
            new IOException("Device or resource busy"));

        var result = ModbusScannerService.CreatePortOpenException("/dev/ttyUSB0", exception);

        Assert.Contains("Port '/dev/ttyUSB0' is busy.", result.Message);
        Assert.Contains("active Flux Monitor device poller", result.Message);
        Assert.Contains("System detail: Device or resource busy", result.Message);
    }

    [Fact]
    public void CreatePortOpenException_UsesFallbackMessageForNonBusyFailures()
    {
        var exception = new IOException("Permission denied");

        var result = ModbusScannerService.CreatePortOpenException("/dev/ttyUSB0", exception);

        Assert.Contains("Port '/dev/ttyUSB0' could not be opened.", result.Message);
        Assert.Contains("System detail: Permission denied", result.Message);
    }
}
