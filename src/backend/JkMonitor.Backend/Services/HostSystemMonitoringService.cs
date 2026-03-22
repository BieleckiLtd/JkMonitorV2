using System.Diagnostics;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using JkMonitor.Contracts.Status;
using Microsoft.Win32;

namespace JkMonitor.Backend.Services;

public sealed class HostSystemMonitoringService(ILogger<HostSystemMonitoringService> logger, IHostEnvironment environment)
{
    private readonly object _sync = new();
    private readonly string _contentRootPath = environment.ContentRootPath;
    private CpuSnapshot? _previousCpuSnapshot = CaptureCpuSnapshot(logger);

    public SystemRuntimeMetrics GetMetrics()
    {
        var memoryInfo = GetMemoryInfo();
        var storageInfo = GetStorageInfo();

        return new SystemRuntimeMetrics
        {
            CpuUtilizationPercent = GetCpuUtilizationPercent(),
            CpuCoreCount = GetCpuCoreCount(),
            CpuMaxClockSpeedMegahertz = GetCpuMaxClockSpeedMegahertz(),
            CpuCurrentClockSpeedMegahertz = GetCpuCurrentClockSpeedMegahertz(),
            ProcessCount = GetProcessCount(),
            SystemUptimeSeconds = GetSystemUptimeSeconds(),
            MemoryAvailableBytes = memoryInfo.availableBytes,
            MemoryUsedBytes = CalculateUsedBytes(memoryInfo.totalBytes, memoryInfo.availableBytes),
            MemoryTotalBytes = memoryInfo.totalBytes,
            StorageUsedBytes = storageInfo.usedBytes,
            StorageTotalBytes = storageInfo.totalBytes,
            MainFanSpeedRpm = GetMainFanSpeedRpm(),
            SystemTemperatureCelsius = GetSystemTemperatureCelsius()
        };
    }

    private static int? GetCpuCoreCount()
    {
        var processorCount = Environment.ProcessorCount;
        return processorCount > 0 ? processorCount : null;
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

    private (long? usedBytes, long? totalBytes) GetStorageInfo()
    {
        try
        {
            var drive = ResolveDriveForPath(_contentRootPath);

            if (drive is null)
            {
                return (null, null);
            }

            var totalBytes = drive.TotalSize;
            var usedBytes = totalBytes - drive.AvailableFreeSpace;

            return (Math.Max(usedBytes, 0L), totalBytes);
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to collect storage info.");
        }

        return (null, null);
    }

    private int? GetCpuMaxClockSpeedMegahertz()
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                return GetLinuxCpuMaxClockSpeedMegahertz();
            }

            if (OperatingSystem.IsWindows())
            {
                return GetWindowsCpuMaxClockSpeedMegahertz();
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to collect CPU max clock speed.");
        }

        return null;
    }

    private int? GetCpuCurrentClockSpeedMegahertz()
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                return GetLinuxCpuCurrentClockSpeedMegahertz();
            }

            if (OperatingSystem.IsWindows())
            {
                return GetWindowsCpuCurrentClockSpeedMegahertz();
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to collect current CPU clock speed.");
        }

        return null;
    }

    private int? GetProcessCount()
    {
        Process[]? processes = null;

        try
        {
            processes = Process.GetProcesses();
            return processes.Length;
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to collect process count.");
            return null;
        }
        finally
        {
            if (processes != null)
            {
                foreach (var process in processes)
                {
                    process.Dispose();
                }
            }
        }
    }

    private static long GetSystemUptimeSeconds()
    {
        return Environment.TickCount64 / 1000;
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

    private static DriveInfo? ResolveDriveForPath(string path)
    {
        var fullPath = Path.GetFullPath(path);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

        return DriveInfo.GetDrives()
            .Where(drive => drive.IsReady)
            .OrderByDescending(drive => drive.RootDirectory.FullName.Length)
            .FirstOrDefault(drive => fullPath.StartsWith(drive.RootDirectory.FullName, comparison));
    }

    private static long? CalculateUsedBytes(long? totalBytes, long? availableBytes)
    {
        if (!totalBytes.HasValue || !availableBytes.HasValue)
        {
            return null;
        }

        return Math.Max(totalBytes.Value - availableBytes.Value, 0L);
    }

    private static int? GetLinuxCpuMaxClockSpeedMegahertz()
    {
        const string cpuRoot = "/sys/devices/system/cpu";
        const string cpuPolicyRoot = "/sys/devices/system/cpu/cpufreq";

        if (!Directory.Exists(cpuRoot) && !Directory.Exists(cpuPolicyRoot))
        {
            return null;
        }

        long maxKilohertz = 0;

        if (Directory.Exists(cpuPolicyRoot))
        {
            foreach (var policyDirectory in Directory.GetDirectories(cpuPolicyRoot, "policy*"))
            {
                var kilohertz = ReadLinuxFrequencyKilohertz(Path.Combine(policyDirectory, "cpuinfo_max_freq"))
                    ?? ReadLinuxFrequencyKilohertz(Path.Combine(policyDirectory, "scaling_max_freq"))
                    ?? ReadLinuxFrequencyKilohertz(Path.Combine(policyDirectory, "base_frequency"));

                if (kilohertz is > 0 && kilohertz.Value > maxKilohertz)
                {
                    maxKilohertz = kilohertz.Value;
                }
            }
        }

        if (!Directory.Exists(cpuRoot))
        {
            return maxKilohertz > 0 ? (int)Math.Round(maxKilohertz / 1000d) : null;
        }

        foreach (var cpuDirectory in Directory.GetDirectories(cpuRoot, "cpu[0-9]*"))
        {
            var kilohertz = ReadLinuxFrequencyKilohertz(Path.Combine(cpuDirectory, "cpufreq", "cpuinfo_max_freq"))
                ?? ReadLinuxFrequencyKilohertz(Path.Combine(cpuDirectory, "cpufreq", "scaling_max_freq"))
                ?? ReadLinuxFrequencyKilohertz(Path.Combine(cpuDirectory, "cpufreq", "base_frequency"));

            if (kilohertz is > 0 && kilohertz.Value > maxKilohertz)
            {
                maxKilohertz = kilohertz.Value;
            }
        }

        return maxKilohertz > 0 ? (int)Math.Round(maxKilohertz / 1000d) : null;
    }

    private static long? ReadLinuxFrequencyKilohertz(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var rawValue = File.ReadAllText(path).Trim();

        if (!long.TryParse(rawValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out var kilohertz))
        {
            return null;
        }

        return kilohertz > 0 ? kilohertz : null;
    }

    [SupportedOSPlatform("windows")]
    private static int? GetWindowsCpuMaxClockSpeedMegahertz()
    {
        const string cpuRegistryPath = @"HARDWARE\DESCRIPTION\System\CentralProcessor\0";

        using var cpuKey = Registry.LocalMachine.OpenSubKey(cpuRegistryPath);

        return ParseWindowsCpuSpeed(cpuKey?.GetValue("~MHz"));
    }

    private static int? ParseWindowsCpuSpeed(object? rawValue)
    {
        return rawValue switch
        {
            int value when value > 0 => value,
            long value when value > 0 && value <= int.MaxValue => (int)value,
            string value when int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedValue) && parsedValue > 0 => parsedValue,
            _ => null
        };
    }

    [SupportedOSPlatform("windows")]
    private static int? GetWindowsCpuCurrentClockSpeedMegahertz()
    {
        var processorCount = Environment.ProcessorCount;

        if (processorCount <= 0)
        {
            return null;
        }

        var structSize = Marshal.SizeOf<ProcessorPowerInformation>();
        var bufferSize = structSize * processorCount;
        var buffer = Marshal.AllocHGlobal(bufferSize);

        try
        {
            const int processorInformation = 11;
            var status = CallNtPowerInformation(processorInformation, IntPtr.Zero, 0, buffer, (uint)bufferSize);

            if (status != 0)
            {
                return null;
            }

            uint maxCurrentMhz = 0;

            for (var i = 0; i < processorCount; i++)
            {
                var info = Marshal.PtrToStructure<ProcessorPowerInformation>(buffer + i * structSize);

                if (info.CurrentMhz > maxCurrentMhz)
                {
                    maxCurrentMhz = info.CurrentMhz;
                }
            }

            return maxCurrentMhz > 0 ? (int)maxCurrentMhz : null;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static int? GetLinuxCpuCurrentClockSpeedMegahertz()
    {
        const string cpuRoot = "/sys/devices/system/cpu";
        const string cpuPolicyRoot = "/sys/devices/system/cpu/cpufreq";

        long maxKilohertz = 0;

        if (Directory.Exists(cpuPolicyRoot))
        {
            foreach (var policyDirectory in Directory.GetDirectories(cpuPolicyRoot, "policy*"))
            {
                var kilohertz = ReadLinuxFrequencyKilohertz(Path.Combine(policyDirectory, "scaling_cur_freq"));

                if (kilohertz is > 0 && kilohertz.Value > maxKilohertz)
                {
                    maxKilohertz = kilohertz.Value;
                }
            }
        }

        if (Directory.Exists(cpuRoot))
        {
            foreach (var cpuDirectory in Directory.GetDirectories(cpuRoot, "cpu[0-9]*"))
            {
                var kilohertz = ReadLinuxFrequencyKilohertz(Path.Combine(cpuDirectory, "cpufreq", "scaling_cur_freq"));

                if (kilohertz is > 0 && kilohertz.Value > maxKilohertz)
                {
                    maxKilohertz = kilohertz.Value;
                }
            }
        }

        return maxKilohertz > 0 ? (int)Math.Round(maxKilohertz / 1000d) : null;
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

    private int? GetMainFanSpeedRpm()
    {
        try
        {
            if (OperatingSystem.IsLinux())
            {
                return GetLinuxMainFanSpeedRpm();
            }

            if (OperatingSystem.IsWindows())
            {
                return GetWindowsMainFanSpeedRpm();
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to read main fan speed.");
        }

        return null;
    }

    private static int? GetLinuxMainFanSpeedRpm()
    {
        FanSpeedReading? bestReading = null;

        foreach (var sensor in GetLinuxFanSensors())
        {
            var rpm = ReadLinuxFanSpeedRpm(sensor.InputPath);

            if (rpm is null)
            {
                continue;
            }

            if (bestReading is null
                || sensor.Priority > bestReading.Value.Priority
                || (sensor.Priority == bestReading.Value.Priority && rpm.Value > bestReading.Value.SpeedRpm))
            {
                bestReading = new FanSpeedReading(rpm.Value, sensor.Priority);
            }
        }

        return bestReading?.SpeedRpm;
    }

    [SupportedOSPlatform("windows")]
    private static int? GetWindowsMainFanSpeedRpm()
    {
        using var searcher = new ManagementObjectSearcher("SELECT DesiredSpeed FROM Win32_Fan");

        foreach (ManagementBaseObject obj in searcher.Get())
        {
            if (obj["DesiredSpeed"] is ulong speed and > 0)
            {
                return speed <= int.MaxValue ? (int)speed : int.MaxValue;
            }
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

    private static IEnumerable<FanSensor> GetLinuxFanSensors()
    {
        const string hwmonRoot = "/sys/class/hwmon";

        if (!Directory.Exists(hwmonRoot))
        {
            yield break;
        }

        foreach (var hwmonDirectory in Directory.GetDirectories(hwmonRoot, "hwmon*"))
        {
            foreach (var inputPath in Directory.GetFiles(hwmonDirectory, "fan*_input"))
            {
                yield return new FanSensor(inputPath, GetLinuxFanSensorPriority(hwmonDirectory, inputPath));
            }
        }
    }

    private static int GetLinuxFanSensorPriority(string hwmonDirectory, string inputPath)
    {
        var score = 0;
        var inputFileName = Path.GetFileName(inputPath);

        if (string.Equals(inputFileName, "fan1_input", StringComparison.OrdinalIgnoreCase))
        {
            score += 10;
        }

        var labelPath = inputPath.Replace("_input", "_label", StringComparison.OrdinalIgnoreCase);
        var label = ReadLinuxSensorText(labelPath);

        if (!string.IsNullOrWhiteSpace(label))
        {
            score += GetLinuxFanLabelPriority(label);
        }

        var deviceName = ReadLinuxSensorText(Path.Combine(hwmonDirectory, "name"));

        if (!string.IsNullOrWhiteSpace(deviceName))
        {
            var normalizedDeviceName = deviceName.Trim().ToLowerInvariant();

            if (normalizedDeviceName.Contains("fan", StringComparison.Ordinal))
            {
                score += 5;
            }

            if (normalizedDeviceName.Contains("emc", StringComparison.Ordinal))
            {
                score += 5;
            }
        }

        return score;
    }

    private static int GetLinuxFanLabelPriority(string label)
    {
        var normalizedLabel = label.Trim().ToLowerInvariant();
        var score = 0;

        if (normalizedLabel.Contains("main", StringComparison.Ordinal))
        {
            score += 100;
        }

        if (normalizedLabel.Contains("cpu", StringComparison.Ordinal))
        {
            score += 90;
        }

        if (normalizedLabel.Contains("system", StringComparison.Ordinal)
            || normalizedLabel.Contains("chassis", StringComparison.Ordinal)
            || normalizedLabel.Contains("case", StringComparison.Ordinal))
        {
            score += 80;
        }

        return score;
    }

    private static string? ReadLinuxSensorText(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var value = File.ReadAllText(path).Trim();
        return value.Length > 0 ? value : null;
    }

    private static int? ReadLinuxFanSpeedRpm(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        var rawValue = File.ReadAllText(path).Trim();

        if (!int.TryParse(rawValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out var rpm) || rpm < 0)
        {
            return null;
        }

        return rpm;
    }

    private readonly record struct CpuSnapshot(ulong IdleTime, ulong TotalTime);

    private readonly record struct FanSensor(string InputPath, int Priority);

    private readonly record struct FanSpeedReading(int SpeedRpm, int Priority);

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

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessorPowerInformation
    {
        public uint Number;
        public uint MaxMhz;
        public uint CurrentMhz;
        public uint MhzLimit;
        public uint MaxIdleState;
        public uint CurrentIdleState;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemTimes(out FileTime idleTime, out FileTime kernelTime, out FileTime userTime);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx memoryStatus);

    [DllImport("powrprof.dll")]
    private static extern uint CallNtPowerInformation(
        int informationLevel,
        IntPtr inputBuffer,
        uint inputBufferLength,
        IntPtr outputBuffer,
        uint outputBufferLength);
}