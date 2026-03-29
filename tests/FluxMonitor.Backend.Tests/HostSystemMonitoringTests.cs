using Xunit;
using FluxMonitor.Backend.Services;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FluxMonitor.Backend.Tests;

public class HostSystemMonitoringTests
{
    private readonly HostSystemMonitoringService _service = new(
        NullLogger<HostSystemMonitoringService>.Instance,
        new TestHostEnvironment());

    [Fact]
    public void GetMetrics_ReturnsNonNull()
    {
        var metrics = _service.GetMetrics();

        Assert.NotNull(metrics);
    }

    [Fact]
    public void GetMetrics_CpuCurrentClockSpeed_ReturnsPositiveValueOnWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var metrics = _service.GetMetrics();

        Assert.NotNull(metrics.CpuCurrentClockSpeedMegahertz);
        Assert.InRange(metrics.CpuCurrentClockSpeedMegahertz.Value, 1, 10_000);
    }

    [Fact]
    public void GetMetrics_CpuCurrentClockSpeed_DoesNotExceedMaxSpeed()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var metrics = _service.GetMetrics();

        if (metrics.CpuCurrentClockSpeedMegahertz.HasValue && metrics.CpuMaxClockSpeedMegahertz.HasValue)
        {
            // Current may exceed base due to turbo boost, but should be within 2x
            Assert.True(
                metrics.CpuCurrentClockSpeedMegahertz.Value <= metrics.CpuMaxClockSpeedMegahertz.Value * 2,
                $"Current {metrics.CpuCurrentClockSpeedMegahertz} MHz seems unreasonably high vs max {metrics.CpuMaxClockSpeedMegahertz} MHz");
        }
    }

    [Fact]
    public void GetMetrics_MainFanSpeedRpm_DoesNotThrowOnWindows()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var metrics = _service.GetMetrics();

        // Fan speed may be null on systems where WMI Win32_Fan is not populated
        if (metrics.MainFanSpeedRpm.HasValue)
        {
            Assert.InRange(metrics.MainFanSpeedRpm.Value, 0, 50_000);
        }
    }

    private sealed class TestHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "FluxMonitor.Backend.Tests";
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
