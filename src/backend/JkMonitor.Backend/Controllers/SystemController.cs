using System.IO.Ports;
using JkMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;

namespace JkMonitor.Backend.Controllers;

[ApiController]
[Route("api/system")]
public sealed class SystemController(SystemUpdateService updateService) : ControllerBase
{
    [HttpGet("update/check")]
    public async Task<ActionResult<UpdateCheckResult>> CheckForUpdate(CancellationToken cancellationToken)
    {
        var result = await updateService.CheckForUpdateAsync(cancellationToken);
        return Ok(result);
    }

    [HttpPost("update/install")]
    public IActionResult InstallUpdate()
    {
        var started = updateService.StartUpdate();
        if (!started)
        {
            return BadRequest(new { error = "Update cannot be started. Either already running or not a managed install." });
        }

        return Ok(new { message = "Update started." });
    }

    [HttpGet("update/progress")]
    public ActionResult<UpdateProgress> GetUpdateProgress()
    {
        var progress = updateService.GetProgress();
        return Ok(progress ?? new UpdateProgress { IsRunning = false, Stage = "No update in progress." });
    }

    [HttpGet("interfaces")]
    public ActionResult<SystemInterfacesResponse> GetInterfaces()
    {
        var result = new SystemInterfacesResponse
        {
            SerialPorts = DiscoverSerialPorts(),
            BlockDevices = DiscoverBlockDevices(),
            NetworkInterfaces = DiscoverNetworkInterfaces()
        };

        return Ok(result);
    }

    private static List<SerialPortInfo> DiscoverSerialPorts()
    {
        var ports = new List<SerialPortInfo>();

        try
        {
            foreach (var name in SerialPort.GetPortNames())
            {
                if (!string.IsNullOrWhiteSpace(name))
                {
                    ports.Add(new SerialPortInfo { Name = name, Description = ClassifySerialPort(name) });
                }
            }
        }
        catch
        {
            // SerialPort.GetPortNames may throw on some platforms.
        }

        if (OperatingSystem.IsLinux())
        {
            AddLinuxSerialPorts(ports);
        }

        // Deduplicate by name
        return ports
            .GroupBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static void AddLinuxSerialPorts(List<SerialPortInfo> ports)
    {
        var existingNames = new HashSet<string>(ports.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);

        foreach (var pattern in new[] { "ttyUSB*", "ttyACM*", "ttyAMA*" })
        {
            if (!Directory.Exists("/dev")) continue;

            foreach (var path in Directory.GetFiles("/dev", pattern))
            {
                if (!existingNames.Contains(path))
                {
                    ports.Add(new SerialPortInfo { Name = path, Description = ClassifySerialPort(path) });
                    existingNames.Add(path);
                }
            }
        }

        var byIdPath = "/dev/serial/by-id";
        if (Directory.Exists(byIdPath))
        {
            foreach (var path in Directory.GetFiles(byIdPath))
            {
                var info = new FileInfo(path);
                string? target = null;
                try { target = info.LinkTarget ?? Path.GetFullPath(Path.Combine(byIdPath, System.IO.File.ReadAllText(path).Trim())); } catch { }

                ports.Add(new SerialPortInfo
                {
                    Name = path,
                    Description = target is not null ? $"Symlink → {target}" : "USB serial device"
                });
            }
        }
    }

    private static string ClassifySerialPort(string name)
    {
        if (name.Contains("ttyUSB", StringComparison.OrdinalIgnoreCase)) return "USB-Serial adapter";
        if (name.Contains("ttyACM", StringComparison.OrdinalIgnoreCase)) return "USB CDC/ACM device";
        if (name.Contains("ttyAMA", StringComparison.OrdinalIgnoreCase)) return "UART (hardware)";
        if (name.Contains("ttyS", StringComparison.OrdinalIgnoreCase)) return "Standard serial port";
        if (name.StartsWith("COM", StringComparison.OrdinalIgnoreCase)) return "COM port";
        return "Serial device";
    }

    private static List<BlockDeviceInfo> DiscoverBlockDevices()
    {
        var devices = new List<BlockDeviceInfo>();

        if (!OperatingSystem.IsLinux()) return devices;

        try
        {
            var sysBlockPath = "/sys/block";
            if (!Directory.Exists(sysBlockPath)) return devices;

            foreach (var dir in Directory.GetDirectories(sysBlockPath))
            {
                var name = Path.GetFileName(dir);
                if (name.StartsWith("loop") || name.StartsWith("ram")) continue;

                var sizePath = Path.Combine(dir, "size");
                long sizeBytes = 0;
                if (System.IO.File.Exists(sizePath) && long.TryParse(System.IO.File.ReadAllText(sizePath).Trim(), out var sectors))
                {
                    sizeBytes = sectors * 512;
                }

                var modelPath = Path.Combine(dir, "device", "model");
                var model = System.IO.File.Exists(modelPath) ? System.IO.File.ReadAllText(modelPath).Trim() : null;

                var roPath = Path.Combine(dir, "ro");
                var readOnly = System.IO.File.Exists(roPath) && System.IO.File.ReadAllText(roPath).Trim() == "1";

                devices.Add(new BlockDeviceInfo
                {
                    Name = $"/dev/{name}",
                    Model = model,
                    SizeBytes = sizeBytes,
                    SizeFormatted = FormatBytes(sizeBytes),
                    ReadOnly = readOnly
                });
            }
        }
        catch
        {
            // Best-effort discovery.
        }

        return devices.OrderBy(d => d.Name).ToList();
    }

    private static List<NetworkInterfaceInfo> DiscoverNetworkInterfaces()
    {
        var interfaces = new List<NetworkInterfaceInfo>();

        try
        {
            foreach (var ni in System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.NetworkInterfaceType == System.Net.NetworkInformation.NetworkInterfaceType.Loopback) continue;

                var ipProps = ni.GetIPProperties();
                var addresses = ipProps.UnicastAddresses
                    .Where(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork
                             || a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
                    .Select(a => a.Address.ToString())
                    .ToList();

                interfaces.Add(new NetworkInterfaceInfo
                {
                    Name = ni.Name,
                    Description = ni.Description,
                    Type = ni.NetworkInterfaceType.ToString(),
                    Status = ni.OperationalStatus.ToString(),
                    MacAddress = ni.GetPhysicalAddress().ToString(),
                    Addresses = addresses,
                    SpeedMbps = ni.Speed > 0 ? ni.Speed / 1_000_000 : null
                });
            }
        }
        catch
        {
            // Best-effort.
        }

        return interfaces.OrderBy(i => i.Name).ToList();
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var idx = 0;
        var value = (double)bytes;
        while (value >= 1024 && idx < units.Length - 1) { value /= 1024; idx++; }
        return $"{value:F1} {units[idx]}";
    }
}

public sealed class SystemInterfacesResponse
{
    public List<SerialPortInfo> SerialPorts { get; set; } = [];
    public List<BlockDeviceInfo> BlockDevices { get; set; } = [];
    public List<NetworkInterfaceInfo> NetworkInterfaces { get; set; } = [];
}

public sealed class SerialPortInfo
{
    public required string Name { get; set; }
    public string? Description { get; set; }
}

public sealed class BlockDeviceInfo
{
    public required string Name { get; set; }
    public string? Model { get; set; }
    public long SizeBytes { get; set; }
    public string? SizeFormatted { get; set; }
    public bool ReadOnly { get; set; }
}

public sealed class NetworkInterfaceInfo
{
    public required string Name { get; set; }
    public string? Description { get; set; }
    public string? Type { get; set; }
    public string? Status { get; set; }
    public string? MacAddress { get; set; }
    public List<string> Addresses { get; set; } = [];
    public long? SpeedMbps { get; set; }
}
