using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class NetworkManagementService(ILogger<NetworkManagementService> logger)
{
    public async Task<NetworkConnectivitySnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var interfaces = GetBaseInterfaces();
        var ethernetInterfaces = interfaces
            .Where(@interface => @interface.Kind == "ethernet")
            .Select(@interface => new EthernetInterfaceSnapshot
            {
                Name = @interface.Name,
                Description = @interface.Description,
                Status = @interface.Status,
                MacAddress = @interface.MacAddress,
                Addresses = @interface.Addresses,
                SpeedMbps = @interface.SpeedMbps
            })
            .ToArray();
        var wifiInterfaces = interfaces
            .Where(@interface => @interface.Kind == "wifi")
            .Select(@interface => new WifiInterfaceSnapshot
            {
                Name = @interface.Name,
                Description = @interface.Description,
                Status = @interface.Status,
                MacAddress = @interface.MacAddress,
                Addresses = @interface.Addresses,
                SpeedMbps = @interface.SpeedMbps
            })
            .ToArray();

        if (!OperatingSystem.IsLinux())
        {
            return new NetworkConnectivitySnapshot
            {
                Supported = false,
                StatusMessage = "Wi-Fi access point management is supported on Linux hosts with NetworkManager.",
                EthernetInterfaces = ethernetInterfaces,
                WifiInterfaces = wifiInterfaces
            };
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            logger.LogDebug("nmcli was not available: {Error}", toolCheck.ErrorOutput ?? toolCheck.StandardOutput);
            return new NetworkConnectivitySnapshot
            {
                Supported = false,
                StatusMessage = "NetworkManager command-line tools are not available on this host.",
                EthernetInterfaces = ethernetInterfaces,
                WifiInterfaces = wifiInterfaces
            };
        }

        var deviceStatuses = await GetDeviceStatusesAsync(cancellationToken);
        var detailedEthernetInterfaces = ethernetInterfaces
            .Select(@interface => ApplyDeviceStatus(@interface, deviceStatuses))
            .ToArray();
        var detailedWifiInterfaces = new List<WifiInterfaceSnapshot>(wifiInterfaces.Length);

        foreach (var @interface in wifiInterfaces)
        {
            var withStatus = ApplyDeviceStatus(@interface, deviceStatuses);
            var currentAccessPoint = await TryGetCurrentAccessPointAsync(@interface.Name, cancellationToken);

            detailedWifiInterfaces.Add(withStatus with
            {
                ConnectedSsid = currentAccessPoint?.Ssid,
                ConnectedBssid = currentAccessPoint?.Bssid,
                SignalPercent = currentAccessPoint?.SignalPercent,
                Security = currentAccessPoint?.Security,
                SignalBars = currentAccessPoint?.SignalBars
            });
        }

        return new NetworkConnectivitySnapshot
        {
            Supported = true,
            EthernetInterfaces = detailedEthernetInterfaces,
            WifiInterfaces = detailedWifiInterfaces
        };
    }

    public async Task<WifiScanResult> ScanWifiAsync(string? interfaceName, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = "Wi-Fi scanning is supported on Linux hosts with NetworkManager."
            };
        }

        var resolvedInterfaceName = ResolveWifiInterfaceName(interfaceName);
        if (resolvedInterfaceName is null)
        {
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = "No wireless interface was detected on this host."
            };
        }

        var result = await RunNmcliAsync(
            ["--terse", "--fields", "IN-USE,BSSID,SSID,SIGNAL,SECURITY,BARS", "device", "wifi", "list", "ifname", resolvedInterfaceName, "--rescan", "yes"],
            cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogWarning(
                "Wi-Fi scan failed for interface {InterfaceName}. StdErr={ErrorOutput}",
                resolvedInterfaceName,
                result.ErrorOutput);
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = BuildCommandFailureMessage(result, "Unable to scan for Wi-Fi access points.")
            };
        }

        var accessPoints = result.StandardOutput
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line => ParseWifiAccessPointLine(line, resolvedInterfaceName))
            .Where(accessPoint => accessPoint is not null)
            .Cast<WifiAccessPointInfo>()
            .GroupBy(accessPoint => $"{accessPoint.Bssid}|{accessPoint.Ssid}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group
                .OrderByDescending(accessPoint => accessPoint.IsActive)
                .ThenByDescending(accessPoint => accessPoint.SignalPercent ?? int.MinValue)
                .First())
            .OrderByDescending(accessPoint => accessPoint.IsActive)
            .ThenByDescending(accessPoint => accessPoint.SignalPercent ?? int.MinValue)
            .ThenBy(accessPoint => accessPoint.Ssid, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return new WifiScanResult
        {
            Supported = true,
            AccessPoints = accessPoints
        };
    }

    public async Task<WifiConnectResult> ConnectWifiAsync(
        string ssid,
        string? password,
        string? interfaceName,
        CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "Wi-Fi access point changes are supported on Linux hosts with NetworkManager."
            };
        }

        if (string.IsNullOrWhiteSpace(ssid))
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "An SSID is required."
            };
        }

        var resolvedInterfaceName = ResolveWifiInterfaceName(interfaceName);
        if (resolvedInterfaceName is null)
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "No wireless interface was detected on this host."
            };
        }

        var arguments = new List<string>
        {
            "device",
            "wifi",
            "connect",
            ssid.Trim(),
            "ifname",
            resolvedInterfaceName
        };

        if (!string.IsNullOrWhiteSpace(password))
        {
            arguments.Add("password");
            arguments.Add(password);
        }

        var result = await RunNmcliAsync(arguments, cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogWarning(
                "Wi-Fi connect failed for interface {InterfaceName} and SSID {Ssid}. StdErr={ErrorOutput}",
                resolvedInterfaceName,
                ssid,
                result.ErrorOutput);
            return new WifiConnectResult
            {
                Success = false,
                Message = BuildCommandFailureMessage(result, $"Unable to connect to Wi-Fi network '{ssid.Trim()}'.")
            };
        }

        return new WifiConnectResult
        {
            Success = true,
            Message = string.IsNullOrWhiteSpace(result.StandardOutput)
                ? $"Connected to '{ssid.Trim()}'."
                : result.StandardOutput.Trim()
        };
    }

    internal static string[] SplitNmcliFields(string line)
    {
        if (string.IsNullOrEmpty(line))
        {
            return [];
        }

        var fields = new List<string>();
        var current = new System.Text.StringBuilder();
        var escapeNext = false;

        foreach (var character in line)
        {
            if (escapeNext)
            {
                current.Append(character);
                escapeNext = false;
                continue;
            }

            if (character == '\\')
            {
                escapeNext = true;
                continue;
            }

            if (character == ':')
            {
                fields.Add(current.ToString());
                current.Clear();
                continue;
            }

            current.Append(character);
        }

        fields.Add(current.ToString());
        return fields.ToArray();
    }

    internal static WifiAccessPointInfo? ParseWifiAccessPointLine(string line, string interfaceName)
    {
        var fields = SplitNmcliFields(line);
        if (fields.Length < 6)
        {
            return null;
        }

        return new WifiAccessPointInfo
        {
            InterfaceName = interfaceName,
            Ssid = string.IsNullOrWhiteSpace(fields[2]) ? "<hidden>" : fields[2].Trim(),
            Bssid = NormalizeNmcliValue(fields[1]),
            SignalPercent = TryParseInt(fields[3]),
            Security = NormalizeNmcliValue(fields[4]),
            SignalBars = NormalizeNmcliValue(fields[5]),
            IsActive = string.Equals(fields[0].Trim(), "*", StringComparison.Ordinal)
        };
    }

    private static string? NormalizeNmcliValue(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        return string.Equals(trimmed, "--", StringComparison.Ordinal) ? null : trimmed;
    }

    private static int? TryParseInt(string? value)
    {
        return int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)
            ? parsed
            : null;
    }

    private static WifiInterfaceSnapshot ApplyDeviceStatus(
        WifiInterfaceSnapshot @interface,
        IReadOnlyDictionary<string, NetworkManagerDeviceStatus> deviceStatuses)
    {
        if (!deviceStatuses.TryGetValue(@interface.Name, out var deviceStatus))
        {
            return @interface;
        }

        return @interface with
        {
            ConnectionName = deviceStatus.ConnectionName,
            ConnectionState = deviceStatus.State
        };
    }

    private static EthernetInterfaceSnapshot ApplyDeviceStatus(
        EthernetInterfaceSnapshot @interface,
        IReadOnlyDictionary<string, NetworkManagerDeviceStatus> deviceStatuses)
    {
        if (!deviceStatuses.TryGetValue(@interface.Name, out var deviceStatus))
        {
            return @interface;
        }

        return @interface with
        {
            ConnectionName = deviceStatus.ConnectionName,
            ConnectionState = deviceStatus.State
        };
    }

    private async Task<IReadOnlyDictionary<string, NetworkManagerDeviceStatus>> GetDeviceStatusesAsync(CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(
            ["--terse", "--fields", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"],
            cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug("Unable to read nmcli device status: {ErrorOutput}", result.ErrorOutput);
            return new Dictionary<string, NetworkManagerDeviceStatus>(StringComparer.OrdinalIgnoreCase);
        }

        var statuses = new Dictionary<string, NetworkManagerDeviceStatus>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in result.StandardOutput.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            var fields = SplitNmcliFields(line);
            if (fields.Length < 4 || string.IsNullOrWhiteSpace(fields[0]))
            {
                continue;
            }

            statuses[fields[0].Trim()] = new NetworkManagerDeviceStatus(
                fields[0].Trim(),
                NormalizeNmcliValue(fields[1]) ?? string.Empty,
                NormalizeNmcliValue(fields[2]),
                NormalizeNmcliValue(fields[3]));
        }

        return statuses;
    }

    private async Task<WifiAccessPointInfo?> TryGetCurrentAccessPointAsync(string interfaceName, CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(
            ["--terse", "--fields", "IN-USE,BSSID,SSID,SIGNAL,SECURITY,BARS", "device", "wifi", "list", "ifname", interfaceName, "--rescan", "no"],
            cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug(
                "Unable to read current Wi-Fi access point for interface {InterfaceName}: {ErrorOutput}",
                interfaceName,
                result.ErrorOutput);
            return null;
        }

        return result.StandardOutput
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line => ParseWifiAccessPointLine(line, interfaceName))
            .FirstOrDefault(accessPoint => accessPoint?.IsActive == true);
    }

    private string? ResolveWifiInterfaceName(string? interfaceName)
    {
        if (!string.IsNullOrWhiteSpace(interfaceName))
        {
            return interfaceName.Trim();
        }

        return GetBaseInterfaces()
            .FirstOrDefault(@interface => @interface.Kind == "wifi")
            ?.Name;
    }

    private static BaseInterfaceInfo[] GetBaseInterfaces()
    {
        var interfaces = new List<BaseInterfaceInfo>();
        foreach (var networkInterface in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (networkInterface.NetworkInterfaceType == NetworkInterfaceType.Loopback)
            {
                continue;
            }

            var kind = ClassifyInterfaceKind(networkInterface.NetworkInterfaceType);
            if (kind is null)
            {
                continue;
            }

            var addresses = networkInterface.GetIPProperties().UnicastAddresses
                .Where(address => address.Address.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)
                .Select(address => address.Address.ToString())
                .ToArray();

            interfaces.Add(new BaseInterfaceInfo(
                networkInterface.Name,
                networkInterface.Description,
                networkInterface.OperationalStatus.ToString(),
                FormatMacAddress(networkInterface.GetPhysicalAddress()),
                addresses,
                networkInterface.Speed > 0 ? networkInterface.Speed / 1_000_000 : null,
                kind));
        }

        return interfaces
            .OrderBy(@interface => @interface.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static string? ClassifyInterfaceKind(NetworkInterfaceType interfaceType)
    {
        return interfaceType switch
        {
            NetworkInterfaceType.Wireless80211 => "wifi",
            NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetFx or NetworkInterfaceType.FastEthernetT => "ethernet",
            _ => null
        };
    }

    private static string? FormatMacAddress(PhysicalAddress? physicalAddress)
    {
        if (physicalAddress is null)
        {
            return null;
        }

        var bytes = physicalAddress.GetAddressBytes();
        return bytes.Length == 0
            ? null
            : string.Join(':', bytes.Select(b => b.ToString("X2", CultureInfo.InvariantCulture)));
    }

    private async Task<ProcessResult> RunNmcliAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        return await RunProcessAsync("nmcli", arguments, cancellationToken);
    }

    private static string BuildCommandFailureMessage(ProcessResult result, string fallbackMessage)
    {
        if (!string.IsNullOrWhiteSpace(result.ErrorOutput))
        {
            return result.ErrorOutput.Trim();
        }

        if (!string.IsNullOrWhiteSpace(result.StandardOutput))
        {
            return result.StandardOutput.Trim();
        }

        return fallbackMessage;
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        try
        {
            process.Start();
        }
        catch (Exception exception)
        {
            return new ProcessResult(
                false,
                string.Empty,
                exception.Message,
                null);
        }

        try
        {
            var standardOutputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var standardErrorTask = process.StandardError.ReadToEndAsync(cancellationToken);

            await process.WaitForExitAsync(cancellationToken);

            var standardOutput = await standardOutputTask;
            var standardError = await standardErrorTask;

            return new ProcessResult(
                process.ExitCode == 0,
                standardOutput,
                standardError,
                process.ExitCode);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Best effort.
            }

            throw;
        }
    }

    private sealed record BaseInterfaceInfo(
        string Name,
        string? Description,
        string Status,
        string? MacAddress,
        IReadOnlyList<string> Addresses,
        long? SpeedMbps,
        string Kind);

    private sealed record NetworkManagerDeviceStatus(
        string DeviceName,
        string Type,
        string? State,
        string? ConnectionName);

    private sealed record ProcessResult(
        bool Succeeded,
        string StandardOutput,
        string ErrorOutput,
        int? ExitCode);
}
