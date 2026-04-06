using System.IO.Ports;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;

namespace FluxMonitor.Backend.Controllers;

[ApiController]
[Route("api/system")]
public sealed class SystemController(
    SystemUpdateService updateService,
    UpdateProgressBroadcaster updateProgressBroadcaster,
    CloudflareTunnelService cloudflareTunnelService,
    InternetSpeedTestService internetSpeedTestService,
    NetworkManagementService networkManagementService,
    WifiCredentialStore wifiCredentialStore,
    BluetoothManagementService bluetoothManagementService,
    SshManagementService sshManagementService,
    DirectAccessService directAccessService,
    HostServicesCatalogService hostServicesCatalogService,
    ILogger<SystemController> logger) : ControllerBase
{
    private static readonly JsonSerializerOptions UpdateProgressStreamJsonOptions = new(JsonSerializerDefaults.Web);

    [HttpGet("services")]
    public async Task<ActionResult<SystemServicesSnapshot>> GetServices(CancellationToken cancellationToken)
    {
        var result = await hostServicesCatalogService.GetServicesAsync(cancellationToken);
        return Ok(result);
    }

    [HttpGet("packages")]
    public async Task<ActionResult<SystemPackagesSnapshot>> GetPackages(CancellationToken cancellationToken)
    {
        var result = await hostServicesCatalogService.GetPackagesAsync(cancellationToken);
        return Ok(result);
    }

    [HttpGet("services/catalog")]
    public async Task<ActionResult<SystemServicesCatalogSnapshot>> GetServicesCatalog(CancellationToken cancellationToken)
    {
        var result = await hostServicesCatalogService.GetCatalogAsync(cancellationToken);
        return Ok(result);
    }

    [HttpGet("services/insight")]
    public async Task<ActionResult<SystemServiceInsight>> GetServiceInsight(
        [FromQuery] string kind,
        [FromQuery] string id,
        CancellationToken cancellationToken)
    {
        var result = await hostServicesCatalogService.GetInsightAsync(kind, id, cancellationToken);
        return Ok(result);
    }

    [HttpPost("services/stop")]
    public async Task<ActionResult<ServiceCommandResponse>> StopService(
        [FromBody] StopServiceRequest request,
        CancellationToken cancellationToken)
    {
        var result = await hostServicesCatalogService.StopServiceAsync(request.Name, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpGet("connectivity")]
    public async Task<ActionResult<SystemConnectivitySnapshot>> GetConnectivity(CancellationToken cancellationToken)
    {
        var networkTask = networkManagementService.GetSnapshotAsync(cancellationToken);
        var bluetoothTask = bluetoothManagementService.GetSnapshotAsync(cancellationToken);
        var sshTask = sshManagementService.GetSnapshotAsync(cancellationToken);

        await Task.WhenAll(networkTask, bluetoothTask, sshTask);

        var network = await networkTask;
        var bluetooth = await bluetoothTask;
        var ssh = await sshTask;
        var directAccess = await directAccessService.GetSnapshotAsync(network, bluetooth, cancellationToken);

        return Ok(new SystemConnectivitySnapshot
        {
            Network = network,
            Bluetooth = bluetooth,
            Ssh = ssh,
            DirectAccess = directAccess
        });
    }

    [HttpPost("ssh")]
    public async Task<ActionResult<SshServiceCommandResult>> SetSshEnabled(
        [FromBody] SshToggleRequest request,
        CancellationToken cancellationToken)
    {
        var result = await sshManagementService.SetEnabledAsync(request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("direct-access/wifi")]
    public async Task<ActionResult<DirectAccessCommandResult>> SetDirectWifiAccess(
        [FromBody] DirectAccessToggleRequest request,
        CancellationToken cancellationToken)
    {
        var result = await directAccessService.SetWifiEnabledAsync(request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("direct-access/bluetooth")]
    public async Task<ActionResult<DirectAccessCommandResult>> SetDirectBluetoothAccess(
        [FromBody] DirectAccessToggleRequest request,
        CancellationToken cancellationToken)
    {
        var result = await directAccessService.SetBluetoothEnabledAsync(request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("direct-access/settings")]
    public async Task<ActionResult<SaveDirectAccessSettingsResult>> SaveDirectAccessSettings(
        [FromBody] SaveDirectAccessSettingsRequest request,
        CancellationToken cancellationToken)
    {
        var result = await directAccessService.SaveSettingsAsync(
            request.AutoStartMode,
            request.WifiPassword,
            request.HotspotName,
            request.BluetoothDeviceName,
            cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("local-access-mode")]
    public async Task<ActionResult<LocalAccessModeCommandResult>> SetLocalAccessMode(
        [FromBody] LocalAccessModeToggleRequest request,
        CancellationToken cancellationToken)
    {
        var result = await directAccessService.SetLocalAccessModeEnabledAsync(request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("local-access-mode/advanced")]
    public async Task<ActionResult<SaveDirectAccessSettingsResult>> SaveLocalAccessAdvancedSettings(
        [FromBody] SaveLocalAccessAdvancedRequest request,
        CancellationToken cancellationToken)
    {
        var result = await directAccessService.SaveLocalAccessAdvancedSettingsAsync(
            request.WifiPassword,
            request.HotspotName,
            request.BluetoothDeviceName,
            cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpGet("cloudflare-tunnel")]
    public async Task<ActionResult<CloudflareTunnelStatusSnapshot>> GetCloudflareTunnelStatus(CancellationToken cancellationToken)
    {
        var result = await cloudflareTunnelService.GetStatusAsync(cancellationToken);
        return Ok(result);
    }

    [HttpGet("internet-speed")]
    public async Task<ActionResult<InternetSpeedTestSnapshot>> GetInternetSpeedSnapshot(CancellationToken cancellationToken)
    {
        var result = await internetSpeedTestService.GetSnapshotAsync(cancellationToken);
        return Ok(result);
    }

    [HttpPost("internet-speed/run")]
    public async Task<ActionResult<InternetSpeedTestCommandResult>> RunInternetSpeedTest(CancellationToken cancellationToken)
    {
        var result = await internetSpeedTestService.StartAsync(cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("cloudflare-tunnel")]
    public async Task<ActionResult<SaveCloudflareTunnelResponse>> SaveCloudflareTunnel(
        [FromBody] SaveCloudflareTunnelRequest request,
        CancellationToken cancellationToken)
    {
        var result = await cloudflareTunnelService.SaveAsync(request, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpGet("network/wifi/scan")]
    public async Task<ActionResult<WifiScanResult>> ScanWifi(
        [FromQuery] string? interfaceName = null,
        CancellationToken cancellationToken = default)
    {
        var result = await networkManagementService.ScanWifiAsync(interfaceName, cancellationToken);
        return Ok(result);
    }

    [HttpGet("network/wifi/credential")]
    public async Task<ActionResult<WifiStoredCredentialResult>> GetWifiCredential(
        [FromQuery] string ssid,
        CancellationToken cancellationToken = default)
    {
        var result = await wifiCredentialStore.GetCredentialAsync(ssid, cancellationToken);
        return Ok(result);
    }

    [HttpPost("network/wifi/connect")]
    public async Task<ActionResult<WifiConnectResult>> ConnectWifi(
        [FromBody] WifiConnectRequest request,
        CancellationToken cancellationToken)
    {
        var password = request.Password;
        if (string.IsNullOrWhiteSpace(password))
        {
            var storedCredential = await wifiCredentialStore.GetCredentialAsync(request.Ssid, cancellationToken);
            if (storedCredential.HasStoredPassword)
            {
                password = storedCredential.Password;
            }
        }

        var result = await networkManagementService.ConnectWifiAsync(
            request.Ssid,
            password,
            request.InterfaceName,
            request.Bssid,
            cancellationToken);

        if (result.Success)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(request.Password))
                {
                    await wifiCredentialStore.SaveCredentialAsync(request.Ssid, request.Password, request.Bssid, cancellationToken);
                }
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Wi-Fi password storage update failed after a connection attempt.");
            }
        }

        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("network/wifi/power")]
    public async Task<ActionResult<WifiPowerResult>> SetWifiPower(
        [FromBody] WifiPowerRequest request,
        CancellationToken cancellationToken)
    {
        var result = await networkManagementService.SetWifiPowerAsync(request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("network/ethernet/power")]
    public async Task<ActionResult<EthernetPowerResult>> SetEthernetPower(
        [FromBody] EthernetPowerRequest request,
        CancellationToken cancellationToken)
    {
        var result = await networkManagementService.SetEthernetEnabledAsync(request.InterfaceName, request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("network/ethernet/disconnect")]
    public async Task<ActionResult<EthernetDisconnectResult>> DisconnectEthernet(
        [FromBody] EthernetDisconnectRequest request,
        CancellationToken cancellationToken)
    {
        var result = await networkManagementService.DisconnectEthernetAsync(request.InterfaceName, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpPost("bluetooth/power")]
    public async Task<ActionResult<BluetoothPowerResult>> SetBluetoothPower(
        [FromBody] BluetoothPowerRequest request,
        CancellationToken cancellationToken)
    {
        var result = await bluetoothManagementService.SetPowerAsync(request.Enabled, cancellationToken);
        return result.Success ? Ok(result) : BadRequest(result);
    }

    [HttpGet("bluetooth/scan")]
    public async Task<ActionResult<BluetoothScanResult>> ScanBluetooth(
        [FromQuery] int? timeoutMs = null,
        CancellationToken cancellationToken = default)
    {
        var timeout = timeoutMs.HasValue
            ? TimeSpan.FromMilliseconds(Math.Clamp(timeoutMs.Value, 1000, 15000))
            : (TimeSpan?)null;
        var result = await bluetoothManagementService.ScanAsync(timeout, cancellationToken);
        return Ok(result);
    }

    [HttpGet("update/check")]
    public async Task<ActionResult<UpdateCheckResult>> CheckForUpdate(CancellationToken cancellationToken)
    {
        var result = await updateService.CheckForUpdateAsync(cancellationToken);
        return Ok(result);
    }

    [HttpPost("update/channel")]
    public async Task<ActionResult<UpdateChannelPreferenceResult>> SaveUpdateChannel(
        [FromBody] SaveUpdateChannelRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            var result = await updateService.SavePreferredChannelAsync(request.Channel, cancellationToken);
            return Ok(result);
        }
        catch (InvalidOperationException exception)
        {
            return BadRequest(new { error = exception.Message });
        }
    }

    [HttpPost("update/install")]
    public async Task<IActionResult> InstallUpdate(CancellationToken cancellationToken)
    {
        var result = await updateService.StartUpdateAsync(cancellationToken);
        if (!result.Succeeded)
        {
            return BadRequest(new { error = result.Error, progress = result.Progress });
        }

        if (result.Progress is not null)
        {
            return Ok(result.Progress);
        }

        return Ok(new { message = "Update started." });
    }

    [HttpPost("update/cancel")]
    public IActionResult CancelUpdate()
    {
        var result = updateService.CancelUpdate();
        if (!result.Succeeded)
        {
            return BadRequest(new { error = result.Error, progress = result.Progress });
        }

        if (result.Progress is not null)
        {
            return Ok(result.Progress);
        }

        return Ok(new { message = "Update cancellation requested." });
    }

    [HttpGet("update/progress")]
    public ActionResult<UpdateProgress> GetUpdateProgress()
    {
        var progress = updateService.GetProgress();
        if (progress is null) return NoContent();
        return Ok(progress);
    }

    [HttpGet("update/stream")]
    public async Task GetUpdateStream(CancellationToken cancellationToken)
    {
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");
        Response.ContentType = "text/event-stream";

        await using var subscription = updateProgressBroadcaster.Subscribe(updateService.GetProgress());

        try
        {
            await foreach (var progress in subscription.Reader.ReadAllAsync(cancellationToken))
            {
                var payload = SerializeUpdateProgressStream(progress);

                await Response.WriteAsync($"data: {payload}\n\n", cancellationToken);
                await Response.Body.FlushAsync(cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The client disconnected.
        }
    }

    internal static string SerializeUpdateProgressStream(UpdateProgress? progress)
    {
        return JsonSerializer.Serialize(new UpdateProgressStreamEnvelope
        {
            Progress = progress
        }, UpdateProgressStreamJsonOptions);
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

public sealed record WifiConnectRequest(string Ssid, string? Password, string? InterfaceName, string? Bssid);
public sealed record WifiPowerRequest(bool Enabled);
public sealed record EthernetPowerRequest(string InterfaceName, bool Enabled);
public sealed record EthernetDisconnectRequest(string InterfaceName);

public sealed record BluetoothPowerRequest(bool Enabled);
public sealed record SshToggleRequest(bool Enabled);
public sealed record DirectAccessToggleRequest(bool Enabled);
public sealed record SaveDirectAccessSettingsRequest(string AutoStartMode, string? WifiPassword, string? HotspotName, string? BluetoothDeviceName);
public sealed record LocalAccessModeToggleRequest(bool Enabled);
public sealed record SaveLocalAccessAdvancedRequest(string? WifiPassword, string? HotspotName, string? BluetoothDeviceName);
public sealed record StopServiceRequest(string Name);
public sealed record SaveUpdateChannelRequest(string Channel);

file sealed class UpdateProgressStreamEnvelope
{
    public UpdateProgress? Progress { get; set; }
}
