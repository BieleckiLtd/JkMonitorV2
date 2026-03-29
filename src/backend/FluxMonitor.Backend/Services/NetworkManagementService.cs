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
        var ethernetInterfaces = BuildEthernetInterfaces(interfaces, deviceStatuses: null);
        var wifiInterfaces = BuildWifiInterfaces(interfaces, deviceStatuses: null);

        if (!OperatingSystem.IsLinux())
        {
            return new NetworkConnectivitySnapshot
            {
                Supported = false,
                StatusMessage = "Wi-Fi access point management is supported on Linux hosts with NetworkManager.",
                WifiPowered = null,
                HasInternetAccess = null,
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
                WifiPowered = null,
                HasInternetAccess = null,
                EthernetInterfaces = ethernetInterfaces,
                WifiInterfaces = wifiInterfaces
            };
        }

        var deviceStatuses = await GetDeviceStatusesAsync(cancellationToken);
        var wifiPowered = await GetWifiRadioEnabledAsync(cancellationToken);
        var hasInternetAccess = await GetInternetAccessAsync(cancellationToken);
        ethernetInterfaces = BuildEthernetInterfaces(interfaces, deviceStatuses);
        wifiInterfaces = await BuildWifiInterfacesAsync(interfaces, deviceStatuses, wifiPowered != false, cancellationToken);

        return new NetworkConnectivitySnapshot
        {
            Supported = true,
            WifiPowered = wifiPowered,
            HasInternetAccess = hasInternetAccess,
            EthernetInterfaces = ethernetInterfaces,
            WifiInterfaces = wifiInterfaces
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

        if (await GetWifiRadioEnabledAsync(cancellationToken) == false)
        {
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = "Wi-Fi is turned off."
            };
        }

        var resolvedInterfaceName = await ResolveWifiInterfaceNameAsync(interfaceName, cancellationToken);
        if (resolvedInterfaceName is null)
        {
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = "No wireless interface was detected on this host."
            };
        }

        var accessPointsResult = await GetWifiAccessPointsAsync(resolvedInterfaceName, requestRescan: true, cancellationToken);
        if (!accessPointsResult.Succeeded)
        {
            var message = BuildCommandFailureMessage(accessPointsResult.Result, "Unable to scan for Wi-Fi access points.");
            logger.LogWarning(
                "Wi-Fi scan failed for interface {InterfaceName}: {ErrorMessage}",
                resolvedInterfaceName,
                message);
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = message
            };
        }

        logger.LogInformation(
            "Wi-Fi scan for interface {InterfaceName} returned {AccessPointCount} access points.",
            resolvedInterfaceName,
            accessPointsResult.AccessPoints.Length);

        return new WifiScanResult
        {
            Supported = true,
            AccessPoints = accessPointsResult.AccessPoints
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

        if (await GetWifiRadioEnabledAsync(cancellationToken) == false)
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "Wi-Fi is turned off."
            };
        }

        var resolvedInterfaceName = await ResolveWifiInterfaceNameAsync(interfaceName, cancellationToken);
        if (resolvedInterfaceName is null)
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "No wireless interface was detected on this host."
            };
        }

        var trimmedSsid = ssid.Trim();
        logger.LogInformation(
            "Connecting Wi-Fi interface {InterfaceName} to SSID {Ssid}.",
            resolvedInterfaceName,
            trimmedSsid);

        var arguments = new List<string>
        {
            "device",
            "wifi",
            "connect",
            trimmedSsid,
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
            var message = BuildCommandFailureMessage(result, $"Unable to connect to Wi-Fi network '{trimmedSsid}'.");
            logger.LogWarning(
                "Wi-Fi connect failed for interface {InterfaceName} and SSID {Ssid}: {ErrorMessage}",
                resolvedInterfaceName,
                trimmedSsid,
                message);
            return new WifiConnectResult
            {
                Success = false,
                Message = message
            };
        }

        return new WifiConnectResult
        {
            Success = true,
            Message = string.IsNullOrWhiteSpace(result.StandardOutput)
                ? $"Connected to '{trimmedSsid}'."
                : result.StandardOutput.Trim()
        };
    }

    public async Task<WifiPowerResult> SetWifiPowerAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new WifiPowerResult
            {
                Success = false,
                Powered = false,
                Message = "Wi-Fi radio controls are supported on Linux hosts with NetworkManager."
            };
        }

        logger.LogInformation("Setting Wi-Fi power state to {Enabled}.", enabled);

        var result = await RunNmcliAsync(["radio", "wifi", enabled ? "on" : "off"], cancellationToken);
        if (!result.Succeeded)
        {
            var message = BuildCommandFailureMessage(result, "Unable to change Wi-Fi power state.");
            logger.LogWarning(
                "Failed to set Wi-Fi power state to {Enabled}: {ErrorMessage}",
                enabled,
                message);

            return new WifiPowerResult
            {
                Success = false,
                Powered = await GetWifiRadioEnabledAsync(cancellationToken) ?? false,
                Message = message
            };
        }

        var powered = await GetWifiRadioEnabledAsync(cancellationToken) ?? enabled;
        var success = powered == enabled;
        if (success)
        {
            logger.LogInformation("Wi-Fi power state changed successfully. Powered={Powered}.", powered);
        }
        else
        {
            logger.LogWarning(
                "Wi-Fi power state did not change as requested. Requested={Requested}, Actual={Actual}.",
                enabled,
                powered);
        }

        return new WifiPowerResult
        {
            Success = success,
            Powered = powered,
            Message = success
                ? enabled ? "Wi-Fi turned on." : "Wi-Fi turned off."
                : $"Wi-Fi state did not change as requested. Current state: {(powered ? "on" : "off")}."
        };
    }

    public async Task<EthernetDisconnectResult> DisconnectEthernetAsync(string? interfaceName, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new EthernetDisconnectResult
            {
                Success = false,
                InterfaceName = interfaceName?.Trim() ?? string.Empty,
                Message = "Ethernet disconnect is supported on Linux hosts with NetworkManager."
            };
        }

        var resolvedInterfaceName = await ResolveEthernetInterfaceNameAsync(interfaceName, cancellationToken);
        if (resolvedInterfaceName is null)
        {
            return new EthernetDisconnectResult
            {
                Success = false,
                InterfaceName = interfaceName?.Trim() ?? string.Empty,
                Message = "No Ethernet interface was detected on this host."
            };
        }

        logger.LogInformation("Disconnecting Ethernet interface {InterfaceName}.", resolvedInterfaceName);

        var result = await RunNmcliAsync(["device", "disconnect", resolvedInterfaceName], cancellationToken);
        if (!result.Succeeded)
        {
            var message = BuildCommandFailureMessage(result, $"Unable to disconnect Ethernet interface '{resolvedInterfaceName}'.");
            logger.LogWarning(
                "Failed to disconnect Ethernet interface {InterfaceName}: {ErrorMessage}",
                resolvedInterfaceName,
                message);

            return new EthernetDisconnectResult
            {
                Success = false,
                InterfaceName = resolvedInterfaceName,
                Message = message
            };
        }

        logger.LogInformation("Ethernet interface {InterfaceName} disconnected successfully.", resolvedInterfaceName);
        return new EthernetDisconnectResult
        {
            Success = true,
            InterfaceName = resolvedInterfaceName,
            Message = string.IsNullOrWhiteSpace(result.StandardOutput)
                ? $"Disconnected '{resolvedInterfaceName}'."
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

    internal static WifiAccessPointInfo[] ParseWifiAccessPoints(string output, string interfaceName)
    {
        return output
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line => ParseWifiAccessPointLine(line, interfaceName))
            .Where(accessPoint => accessPoint is not null)
            .Cast<WifiAccessPointInfo>()
            .GroupBy(accessPoint => $"{accessPoint.Bssid}|{accessPoint.Ssid}", StringComparer.OrdinalIgnoreCase)
            .Select(group => group
                .OrderByDescending(accessPoint => accessPoint.SignalPercent ?? int.MinValue)
                .ThenByDescending(accessPoint => accessPoint.IsActive)
                .First())
            .OrderByDescending(accessPoint => accessPoint.SignalPercent ?? int.MinValue)
            .ThenByDescending(accessPoint => accessPoint.IsActive)
            .ThenBy(accessPoint => accessPoint.Ssid, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    internal static string? ResolveInterfaceKind(
        string name,
        string? description,
        NetworkInterfaceType interfaceType,
        string? networkManagerType)
    {
        if (IsWifiDeviceType(networkManagerType))
        {
            return "wifi";
        }

        if (IsEthernetDeviceType(networkManagerType))
        {
            return "ethernet";
        }

        return interfaceType switch
        {
            NetworkInterfaceType.Wireless80211 => "wifi",
            NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet or NetworkInterfaceType.FastEthernetFx or NetworkInterfaceType.FastEthernetT => "ethernet",
            _ => InferInterfaceKindFromName(name, description)
        };
    }

    internal static bool? ParseWifiRadioState(string? value)
    {
        var normalized = NormalizeNmcliValue(value);
        if (normalized is null)
        {
            return null;
        }

        if (string.Equals(normalized, "enabled", StringComparison.OrdinalIgnoreCase)
            || string.Equals(normalized, "on", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (string.Equals(normalized, "disabled", StringComparison.OrdinalIgnoreCase)
            || string.Equals(normalized, "off", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return null;
    }

    internal static bool? ParseInternetAccessState(string? value)
    {
        var normalized = NormalizeNmcliValue(value);
        if (normalized is null)
        {
            return null;
        }

        return normalized.ToLowerInvariant() switch
        {
            "full" => true,
            "limited" or "portal" or "none" => false,
            "unknown" => null,
            _ => null
        };
    }

    private static EthernetInterfaceSnapshot[] BuildEthernetInterfaces(
        IReadOnlyList<BaseInterfaceInfo> interfaces,
        IReadOnlyDictionary<string, NetworkManagerDeviceStatus>? deviceStatuses)
    {
        return interfaces
            .Where(@interface => string.Equals(ResolveInterfaceKind(@interface, deviceStatuses), "ethernet", StringComparison.Ordinal))
            .Select(@interface =>
            {
                var snapshot = new EthernetInterfaceSnapshot
                {
                    Name = @interface.Name,
                    Description = @interface.Description,
                    Status = @interface.Status,
                    MacAddress = @interface.MacAddress,
                    Addresses = @interface.Addresses,
                    SpeedMbps = @interface.SpeedMbps
                };

                return deviceStatuses is null
                    ? snapshot
                    : ApplyDeviceStatus(snapshot, deviceStatuses);
            })
            .ToArray();
    }

    private async Task<WifiInterfaceSnapshot[]> BuildWifiInterfacesAsync(
        IReadOnlyList<BaseInterfaceInfo> interfaces,
        IReadOnlyDictionary<string, NetworkManagerDeviceStatus>? deviceStatuses,
        bool includeCurrentAccessPoint,
        CancellationToken cancellationToken)
    {
        var snapshots = BuildWifiInterfaces(interfaces, deviceStatuses);
        if (!includeCurrentAccessPoint)
        {
            return snapshots;
        }

        var detailedSnapshots = new List<WifiInterfaceSnapshot>(snapshots.Length);

        foreach (var @interface in snapshots)
        {
            var currentAccessPoint = await TryGetCurrentAccessPointAsync(@interface.Name, cancellationToken);
            detailedSnapshots.Add(@interface with
            {
                ConnectedSsid = currentAccessPoint?.Ssid,
                ConnectedBssid = currentAccessPoint?.Bssid,
                SignalPercent = currentAccessPoint?.SignalPercent,
                Security = currentAccessPoint?.Security,
                SignalBars = currentAccessPoint?.SignalBars
            });
        }

        return detailedSnapshots.ToArray();
    }

    private static WifiInterfaceSnapshot[] BuildWifiInterfaces(
        IReadOnlyList<BaseInterfaceInfo> interfaces,
        IReadOnlyDictionary<string, NetworkManagerDeviceStatus>? deviceStatuses)
    {
        return interfaces
            .Where(@interface => string.Equals(ResolveInterfaceKind(@interface, deviceStatuses), "wifi", StringComparison.Ordinal))
            .Select(@interface =>
            {
                var snapshot = new WifiInterfaceSnapshot
                {
                    Name = @interface.Name,
                    Description = @interface.Description,
                    Status = @interface.Status,
                    MacAddress = @interface.MacAddress,
                    Addresses = @interface.Addresses,
                    SpeedMbps = @interface.SpeedMbps
                };

                return deviceStatuses is null
                    ? snapshot
                    : ApplyDeviceStatus(snapshot, deviceStatuses);
            })
            .ToArray();
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

    private async Task<bool?> GetWifiRadioEnabledAsync(CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(["--terse", "radio", "wifi"], cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug("Unable to read Wi-Fi radio state: {ErrorOutput}", result.ErrorOutput);
            return null;
        }

        var powered = ParseWifiRadioState(result.StandardOutput);
        if (powered is null)
        {
            logger.LogDebug("Unexpected Wi-Fi radio state output: {Output}", result.StandardOutput);
        }

        return powered;
    }

    private async Task<bool?> GetInternetAccessAsync(CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(["--terse", "networking", "connectivity"], cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug("Unable to read internet access state: {ErrorOutput}", result.ErrorOutput);
            return null;
        }

        var hasInternetAccess = ParseInternetAccessState(result.StandardOutput);
        if (hasInternetAccess is null)
        {
            logger.LogDebug("Unexpected internet access state output: {Output}", result.StandardOutput);
        }

        return hasInternetAccess;
    }

    private async Task<WifiAccessPointInfo?> TryGetCurrentAccessPointAsync(string interfaceName, CancellationToken cancellationToken)
    {
        var result = await ListWifiAccessPointsAsync(interfaceName, cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug(
                "Unable to read current Wi-Fi access point for interface {InterfaceName}: {ErrorOutput}",
                interfaceName,
                result.ErrorOutput);
            return null;
        }

        return ParseWifiAccessPoints(result.StandardOutput, interfaceName)
            .FirstOrDefault(accessPoint => accessPoint.IsActive);
    }

    private async Task<WifiAccessPointCollectionResult> GetWifiAccessPointsAsync(
        string interfaceName,
        bool requestRescan,
        CancellationToken cancellationToken)
    {
        if (requestRescan)
        {
            await RequestWifiRescanAsync(interfaceName, cancellationToken);
        }

        ProcessResult? lastResult = null;
        WifiAccessPointInfo[] lastAccessPoints = [];

        for (var attempt = 0; attempt < 3; attempt++)
        {
            lastResult = await ListWifiAccessPointsAsync(interfaceName, cancellationToken);
            if (!lastResult.Succeeded)
            {
                return new WifiAccessPointCollectionResult(lastResult, []);
            }

            lastAccessPoints = ParseWifiAccessPoints(lastResult.StandardOutput, interfaceName);
            if (!ShouldRetryWifiAccessPointRead(lastAccessPoints, attempt))
            {
                return new WifiAccessPointCollectionResult(lastResult, lastAccessPoints);
            }

            await Task.Delay(TimeSpan.FromMilliseconds(750), cancellationToken);
        }

        return new WifiAccessPointCollectionResult(lastResult ?? new ProcessResult(false, string.Empty, string.Empty, null), lastAccessPoints);
    }

    private async Task RequestWifiRescanAsync(string interfaceName, CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(
            ["--wait", "10", "device", "wifi", "rescan", "ifname", interfaceName],
            cancellationToken);

        if (!result.Succeeded)
        {
            logger.LogDebug(
                "Explicit Wi-Fi rescan request failed for interface {InterfaceName}: {ErrorOutput}",
                interfaceName,
                result.ErrorOutput ?? result.StandardOutput);
        }
    }

    private async Task<ProcessResult> ListWifiAccessPointsAsync(string interfaceName, CancellationToken cancellationToken)
    {
        return await RunNmcliAsync(
            ["--terse", "--fields", "IN-USE,BSSID,SSID,SIGNAL,SECURITY,BARS", "device", "wifi", "list", "ifname", interfaceName, "--rescan", "no"],
            cancellationToken);
    }

    private static bool ShouldRetryWifiAccessPointRead(IReadOnlyList<WifiAccessPointInfo> accessPoints, int attempt)
    {
        if (attempt >= 2)
        {
            return false;
        }

        return accessPoints.Count <= 1;
    }

    private async Task<string?> ResolveWifiInterfaceNameAsync(string? interfaceName, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(interfaceName))
        {
            return interfaceName.Trim();
        }

        var deviceStatuses = await GetDeviceStatusesAsync(cancellationToken);
        var fromNetworkManager = deviceStatuses.Values
            .Where(deviceStatus => IsWifiDeviceType(deviceStatus.Type))
            .Select(deviceStatus => deviceStatus.DeviceName)
            .FirstOrDefault(deviceName => !string.IsNullOrWhiteSpace(deviceName));
        if (!string.IsNullOrWhiteSpace(fromNetworkManager))
        {
            return fromNetworkManager.Trim();
        }

        return GetBaseInterfaces()
            .FirstOrDefault(@interface => string.Equals(ResolveInterfaceKind(@interface, deviceStatuses: null), "wifi", StringComparison.Ordinal))
            ?.Name;
    }

    private async Task<string?> ResolveEthernetInterfaceNameAsync(string? interfaceName, CancellationToken cancellationToken)
    {
        var deviceStatuses = await GetDeviceStatusesAsync(cancellationToken);
        var ethernetInterfaces = GetBaseInterfaces()
            .Where(@interface => string.Equals(ResolveInterfaceKind(@interface, deviceStatuses), "ethernet", StringComparison.Ordinal))
            .Select(@interface => @interface.Name)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        if (!string.IsNullOrWhiteSpace(interfaceName))
        {
            var trimmed = interfaceName.Trim();
            return ethernetInterfaces.Contains(trimmed) ? trimmed : null;
        }

        var activeEthernet = deviceStatuses.Values
            .Where(deviceStatus => IsEthernetDeviceType(deviceStatus.Type))
            .FirstOrDefault(deviceStatus => string.Equals(deviceStatus.State, "connected", StringComparison.OrdinalIgnoreCase));
        if (!string.IsNullOrWhiteSpace(activeEthernet?.DeviceName))
        {
            return activeEthernet.DeviceName.Trim();
        }

        return ethernetInterfaces.FirstOrDefault();
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
                networkInterface.NetworkInterfaceType));
        }

        return interfaces
            .OrderBy(@interface => @interface.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static string? ResolveInterfaceKind(
        BaseInterfaceInfo @interface,
        IReadOnlyDictionary<string, NetworkManagerDeviceStatus>? deviceStatuses)
    {
        var networkManagerType = deviceStatuses is not null && deviceStatuses.TryGetValue(@interface.Name, out var deviceStatus)
            ? deviceStatus.Type
            : null;

        return ResolveInterfaceKind(
            @interface.Name,
            @interface.Description,
            @interface.InterfaceType,
            networkManagerType);
    }

    private static string? InferInterfaceKindFromName(string name, string? description)
    {
        var candidates = new[]
        {
            name,
            description
        }
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => value!.Trim().ToLowerInvariant())
        .ToArray();

        if (candidates.Any(value =>
                value.StartsWith("wl", StringComparison.Ordinal)
                || value.Contains("wlan", StringComparison.Ordinal)
                || value.Contains("wifi", StringComparison.Ordinal)
                || value.Contains("wi-fi", StringComparison.Ordinal)
                || value.Contains("wireless", StringComparison.Ordinal)))
        {
            return "wifi";
        }

        if (candidates.Any(value =>
                value.StartsWith("en", StringComparison.Ordinal)
                || value.StartsWith("eth", StringComparison.Ordinal)
                || value.Contains("ethernet", StringComparison.Ordinal)
                || value.Contains("wired", StringComparison.Ordinal)))
        {
            return "ethernet";
        }

        return null;
    }

    private static bool IsWifiDeviceType(string? value)
        => string.Equals(value, "wifi", StringComparison.OrdinalIgnoreCase);

    private static bool IsEthernetDeviceType(string? value)
        => string.Equals(value, "ethernet", StringComparison.OrdinalIgnoreCase);

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
        NetworkInterfaceType InterfaceType);

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

    private sealed record WifiAccessPointCollectionResult(
        ProcessResult Result,
        WifiAccessPointInfo[] AccessPoints)
    {
        public bool Succeeded => Result.Succeeded;
    }
}
