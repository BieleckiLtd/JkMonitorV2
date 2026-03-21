using System.Globalization;
using System.Runtime.InteropServices;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

public sealed class HostSystemMonitoringService(ILogger<HostSystemMonitoringService> logger)
{
    private readonly object _sync = new();
    private CpuSnapshot? _previousCpuSnapshot = CaptureCpuSnapshot(logger);

    public SystemRuntimeMetrics GetMetrics()
    {
        return new SystemRuntimeMetrics
        {
            CpuUtilizationPercent = GetCpuUtilizationPercent(),
            MemoryAvailableBytes = GetMemoryInfo().availableBytes,
            MemoryTotalBytes = GetMemoryInfo().totalBytes,
            SystemTemperatureCelsius = GetSystemTemperatureCelsius()
        };
    }

    private double? GetCpuUtilizationPercent()
    {
        lock (_sync)
        {
            var currentSnapshot = CaptureCpuSnapshot(logger);

            if (currentSnapshot is null)
            {
                return null;
            }

            var current = currentSnapshot.Value;

            if (_previousCpuSnapshot is not { } previous)
            {
                _previousCpuSnapshot = current;
                return null;
            }

            _previousCpuSnapshot = current;

            var totalDelta = current.TotalTime - previous.TotalTime;
            var idleDelta = current.IdleTime - previous.IdleTime;

            if (totalDelta <= 0)
            {
                return null;
            }

            var busyRatio = 1d - (double)idleDelta / totalDelta;
            return Math.Clamp(busyRatio * 100d, 0d, 100d);
        }
    }

    private static CpuSnapshot? CaptureCpuSnapshot(ILogger logger)
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                return CaptureLinuxCpuSnapshot();
            }

            if (OperatingSystem.IsWindows())
            {
                return CaptureWindowsCpuSnapshot();
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to capture CPU snapshot.");
        }

        return null;
    }

    private static CpuSnapshot? CaptureLinuxCpuSnapshot()
    {
        const string cpuStatPath = "/proc/stat";

        if (!File.Exists(cpuStatPath))
        {
            return null;
        }

        var firstLine = File.ReadLines(cpuStatPath).FirstOrDefault();

        if (string.IsNullOrWhiteSpace(firstLine))
        {
            return null;
        }

        var segments = firstLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length < 5 || !string.Equals(segments[0], "cpu", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var values = new ulong[segments.Length - 1];

        for (var index = 1; index < segments.Length; index += 1)
        {
            if (!ulong.TryParse(segments[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out values[index - 1]))
            {
                return null;
            }
        }

        var idleTime = values.ElementAtOrDefault(3) + values.ElementAtOrDefault(4);
        ulong totalTime = 0;

        foreach (var value in values)
        {
            totalTime += value;
        }

        return new CpuSnapshot(idleTime, totalTime);
    }

    private static CpuSnapshot? CaptureWindowsCpuSnapshot()
    {
        if (!GetSystemTimes(out var idleTime, out var kernelTime, out var userTime))
        {
            return null;
        }

        return new CpuSnapshot(idleTime.ToUInt64(), kernelTime.ToUInt64() + userTime.ToUInt64());
    }

    private (long? availableBytes, long? totalBytes) GetMemoryInfo()
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                return GetLinuxMemoryInfo();
            }

            if (OperatingSystem.IsWindows())
            {
                return GetWindowsMemoryInfo();
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to collect memory info.");
        }

        return (null, null);
    }

    private static (long? availableBytes, long? totalBytes) GetLinuxMemoryInfo()
    {
        const string memInfoPath = "/proc/meminfo";

        if (!File.Exists(memInfoPath))
        {
            return (null, null);
        }

        long? totalBytes = null;
        long? availableBytes = null;

        foreach (var line in File.ReadLines(memInfoPath))
        {
            if (line.StartsWith("MemTotal:", StringComparison.OrdinalIgnoreCase))
            {
                totalBytes = ParseLinuxMemoryValue(line);
            }
            else if (line.StartsWith("MemAvailable:", StringComparison.OrdinalIgnoreCase))
            {
                availableBytes = ParseLinuxMemoryValue(line);
            }

            if (totalBytes.HasValue && availableBytes.HasValue)
            {
                break;
            }
        }

        return (availableBytes, totalBytes);
    }

    private static long? ParseLinuxMemoryValue(string line)
    {
        var segments = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        if (segments.Length < 2 || !long.TryParse(segments[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var kilobytes))
        {
            return null;
        }

        return kilobytes * 1024;
    }

    private static (long? availableBytes, long? totalBytes) GetWindowsMemoryInfo()
    {
        var memoryStatus = new MemoryStatusEx();
        memoryStatus.dwLength = (uint)Marshal.SizeOf<MemoryStatusEx>();

        if (!GlobalMemoryStatusEx(ref memoryStatus))
        {
            return (null, null);
        }

        return ((long)memoryStatus.ullAvailPhys, (long)memoryStatus.ullTotalPhys);
    }

    private double? GetSystemTemperatureCelsius()
    {
        try
        {
            if (!OperatingSystem.IsLinux())
            {
                return null;
            }

            foreach (var path in GetLinuxTemperatureSensorPaths())
            {
                var rawValue = File.ReadAllText(path).Trim();

                if (!double.TryParse(rawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var temperature))
                {
                    continue;
                }

                return temperature > 1000d ? temperature / 1000d : temperature;
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to read system temperature.");
        }

        return null;
    }

    private static IEnumerable<string> GetLinuxTemperatureSensorPaths()
    {
        const string thermalRoot = "/sys/class/thermal";

        if (!Directory.Exists(thermalRoot))
        {
            yield break;
        }

        var preferredPath = Path.Combine(thermalRoot, "thermal_zone0", "temp");

        if (File.Exists(preferredPath))
        {
            yield return preferredPath;
        }

        foreach (var directory in Directory.GetDirectories(thermalRoot, "thermal_zone*"))
        {
            var tempPath = Path.Combine(directory, "temp");

            if (File.Exists(tempPath) && !string.Equals(tempPath, preferredPath, StringComparison.OrdinalIgnoreCase))
            {
                yield return tempPath;
            }
        }
    }

    private readonly record struct CpuSnapshot(ulong IdleTime, ulong TotalTime);

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;

        public ulong ToUInt64()
        {
            return ((ulong)dwHighDateTime << 32) | dwLowDateTime;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MemoryStatusEx
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out FileTime idleTime, out FileTime kernelTime, out FileTime userTime);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx memoryStatus);
}