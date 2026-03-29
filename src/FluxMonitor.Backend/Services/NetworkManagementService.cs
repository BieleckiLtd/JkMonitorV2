using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;
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
            logger.LogWarning("Wi-Fi scan failed while collecting access points.");
            return new WifiScanResult
            {
                Supported = false,
                StatusMessage = message
            };
        }

        logger.LogInformation(
            "Wi-Fi scan returned {AccessPointCount} access points.",
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
        string? bssid,
        CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "Wi-Fi access point changes are supported on Linux hosts with NetworkManager.",
                InterfaceName = interfaceName?.Trim()
            };
        }

        if (string.IsNullOrWhiteSpace(ssid))
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "An SSID is required.",
                InterfaceName = interfaceName?.Trim()
            };
        }

        if (await GetWifiRadioEnabledAsync(cancellationToken) == false)
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "Wi-Fi is turned off.",
                InterfaceName = interfaceName?.Trim()
            };
        }

        var resolvedInterfaceName = await ResolveWifiInterfaceNameAsync(interfaceName, cancellationToken);
        if (resolvedInterfaceName is null)
        {
            return new WifiConnectResult
            {
                Success = false,
                Message = "No wireless interface was detected on this host.",
                InterfaceName = interfaceName?.Trim()
            };
        }

        var trimmedSsid = ssid.Trim();
        var trimmedBssid = string.IsNullOrWhiteSpace(bssid) ? null : bssid.Trim().ToUpperInvariant();
        logger.LogInformation(
            "Connecting Wi-Fi. PasswordProvided={PasswordProvided}, BssidProvided={BssidProvided}.",
            !string.IsNullOrWhiteSpace(password),
            trimmedBssid is not null);

        var result = await ConnectWifiWithProfileRecoveryAsync(
            resolvedInterfaceName,
            trimmedSsid,
            password,
            trimmedBssid,
            cancellationToken);
        if (!result.Succeeded)
        {
            var observation = await ObserveWifiConnectionStateAsync(resolvedInterfaceName, trimmedSsid, trimmedBssid, attempts: 1, cancellationToken);
            var message = BuildWifiConnectFailureMessage(trimmedSsid, result, observation);
            logger.LogWarning(
                "Wi-Fi connect failed. ExitCode={ExitCode}. HasObservationState={HasObservationState}. HasObservedSsid={HasObservedSsid}. HasObservedBssid={HasObservedBssid}. HasInternetAccess={HasInternetAccess}.",
                result.ExitCode,
                !string.IsNullOrWhiteSpace(observation.ConnectionState),
                !string.IsNullOrWhiteSpace(observation.ConnectedSsid),
                !string.IsNullOrWhiteSpace(observation.ConnectedBssid),
                observation.HasInternetAccess);
            return new WifiConnectResult
            {
                Success = false,
                Message = message,
                InterfaceName = resolvedInterfaceName,
                ConnectedSsid = observation.ConnectedSsid,
                HasInternetAccess = observation.HasInternetAccess
            };
        }

        var verification = await ObserveWifiConnectionStateAsync(resolvedInterfaceName, trimmedSsid, trimmedBssid, attempts: 12, cancellationToken);
        if (!verification.IsConnectedToTarget)
        {
            var message = BuildWifiConnectUnverifiedMessage(trimmedSsid, verification, result);
            logger.LogWarning(
                "Wi-Fi connect command succeeded, but the connection could not be verified. ExitCode={ExitCode}. HasObservationState={HasObservationState}. HasObservedSsid={HasObservedSsid}. HasObservedBssid={HasObservedBssid}. HasInternetAccess={HasInternetAccess}.",
                result.ExitCode,
                !string.IsNullOrWhiteSpace(verification.ConnectionState),
                !string.IsNullOrWhiteSpace(verification.ConnectedSsid),
                !string.IsNullOrWhiteSpace(verification.ConnectedBssid),
                verification.HasInternetAccess);

            return new WifiConnectResult
            {
                Success = false,
                Message = message,
                InterfaceName = resolvedInterfaceName,
                ConnectedSsid = verification.ConnectedSsid,
                HasInternetAccess = verification.HasInternetAccess
            };
        }

        return new WifiConnectResult
        {
            Success = true,
            Message = BuildWifiConnectSuccessMessage(trimmedSsid, verification.HasInternetAccess, result),
            InterfaceName = resolvedInterfaceName,
            ConnectedSsid = verification.ConnectedSsid,
            HasInternetAccess = verification.HasInternetAccess
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

        logger.LogInformation("Disconnecting Ethernet interface.");

        var result = await RunNmcliAsync(["device", "disconnect", resolvedInterfaceName], cancellationToken);
        if (!result.Succeeded)
        {
            var message = BuildCommandFailureMessage(result, $"Unable to disconnect Ethernet interface '{resolvedInterfaceName}'.");
            logger.LogWarning("Failed to disconnect Ethernet interface.");

            return new EthernetDisconnectResult
            {
                Success = false,
                InterfaceName = resolvedInterfaceName,
                Message = message
            };
        }

        logger.LogInformation("Ethernet interface disconnected successfully.");
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

    internal static List<string> BuildWifiConnectArguments(
        string interfaceName,
        string ssid,
        string? password,
        string? bssid)
    {
        var arguments = new List<string>
        {
            "--wait",
            "20",
            "device",
            "wifi",
            "connect",
            ssid,
            "ifname",
            interfaceName
        };

        if (!string.IsNullOrWhiteSpace(bssid))
        {
            arguments.Add("bssid");
            arguments.Add(bssid);
        }

        if (!string.IsNullOrWhiteSpace(password))
        {
            arguments.Add("password");
            arguments.Add(password);
        }

        return arguments;
    }

    internal static bool IsMissingWifiSecurityKeyManagementMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        return message.Contains("802-11-wireless-security.key-mgmt", StringComparison.OrdinalIgnoreCase)
            && message.Contains("property is missing", StringComparison.OrdinalIgnoreCase);
    }

    internal static string[] FindSavedWifiConnectionProfileUuids(string output, string ssid)
    {
        if (string.IsNullOrWhiteSpace(output) || string.IsNullOrWhiteSpace(ssid))
        {
            return [];
        }

        return output
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(SplitNmcliFields)
            .Where(fields => fields.Length >= 3)
            .Select(fields => new
            {
                Name = NormalizeNmcliValue(fields[0]),
                Uuid = NormalizeNmcliValue(fields[1]),
                Type = NormalizeNmcliValue(fields[2])
            })
            .Where(connection =>
                !string.IsNullOrWhiteSpace(connection.Uuid)
                && string.Equals(connection.Name, ssid, StringComparison.Ordinal)
                && IsWifiConnectionProfileType(connection.Type))
            .Select(connection => connection.Uuid!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static bool IsWifiConnectionProfileType(string? value)
        => string.Equals(value, "802-11-wireless", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "wifi", StringComparison.OrdinalIgnoreCase);

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

    private async Task<ProcessResult> ConnectWifiWithProfileRecoveryAsync(
        string interfaceName,
        string ssid,
        string? password,
        string? bssid,
        CancellationToken cancellationToken)
    {
        var arguments = BuildWifiConnectArguments(interfaceName, ssid, password, bssid);
        var result = await RunNmcliAsync(arguments, cancellationToken);
        if (result.Succeeded || !IsMissingWifiSecurityKeyManagementMessage(BuildCommandFailureMessage(result, string.Empty)))
        {
            return result;
        }

        var deletedProfiles = await DeleteSavedWifiConnectionProfilesAsync(ssid, cancellationToken);
        if (deletedProfiles == 0)
        {
            return result;
        }

        logger.LogWarning(
            "Recovered from an invalid saved Wi-Fi profile by deleting {ProfileCount} saved profile(s) before retrying the connection.",
            deletedProfiles);

        return await RunNmcliAsync(arguments, cancellationToken);
    }

    private async Task<int> DeleteSavedWifiConnectionProfilesAsync(string ssid, CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(
            ["--terse", "--escape", "yes", "--fields", "NAME,UUID,TYPE", "connection", "show"],
            cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogWarning("Unable to inspect saved Wi-Fi profiles before retrying the connection.");
            return 0;
        }

        var matchingProfileUuids = FindSavedWifiConnectionProfileUuids(result.StandardOutput, ssid);
        var deletedProfiles = 0;
        foreach (var profileUuid in matchingProfileUuids)
        {
            var deleteResult = await RunNmcliAsync(["connection", "delete", "uuid", profileUuid], cancellationToken);
            if (!deleteResult.Succeeded)
            {
                logger.LogWarning(
                    "Unable to delete a saved Wi-Fi profile while recovering the connection. ExitCode={ExitCode}.",
                    deleteResult.ExitCode);
                continue;
            }

            deletedProfiles++;
        }

        return deletedProfiles;
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
                "Unable to read the current Wi-Fi access point. ExitCode={ExitCode}.",
                result.ExitCode);
            return null;
        }

        return ParseWifiAccessPoints(result.StandardOutput, interfaceName)
            .FirstOrDefault(accessPoint => accessPoint.IsActive);
    }

    private async Task<WifiConnectionObservation> ObserveWifiConnectionStateAsync(
        string interfaceName,
        string targetSsid,
        string? targetBssid,
        int attempts,
        CancellationToken cancellationToken)
    {
        WifiConnectionObservation lastObservation = new(
            interfaceName,
            ConnectionState: null,
            ConnectedSsid: null,
            ConnectedBssid: null,
            HasInternetAccess: null,
            IsConnectedToTarget: false);

        var totalAttempts = Math.Max(1, attempts);
        for (var attempt = 0; attempt < totalAttempts; attempt++)
        {
            var deviceStatuses = await GetDeviceStatusesAsync(cancellationToken);
            deviceStatuses.TryGetValue(interfaceName, out var deviceStatus);

            var currentAccessPoint = await TryGetCurrentAccessPointAsync(interfaceName, cancellationToken);
            var connectedSsid = currentAccessPoint?.Ssid;
            var connectedBssid = currentAccessPoint?.Bssid;
            var matchesSsid = string.Equals(connectedSsid, targetSsid, StringComparison.Ordinal);
            var matchesBssid = string.IsNullOrWhiteSpace(targetBssid)
                || string.Equals(connectedBssid, targetBssid, StringComparison.OrdinalIgnoreCase);
            var isConnectedToTarget = matchesSsid && matchesBssid;
            bool? hasInternetAccess = null;
            if (isConnectedToTarget)
            {
                hasInternetAccess = await GetInternetAccessAsync(cancellationToken);
            }

            lastObservation = new WifiConnectionObservation(
                interfaceName,
                deviceStatus?.State,
                connectedSsid,
                connectedBssid,
                hasInternetAccess,
                isConnectedToTarget);

            if (isConnectedToTarget)
            {
                return lastObservation;
            }

            if (attempt + 1 < totalAttempts)
            {
                await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
            }
        }

        return lastObservation;
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
        WifiAccessPointInfo[] bestAccessPoints = [];

        for (var attempt = 0; attempt < 5; attempt++)
        {
            lastResult = await ListWifiAccessPointsAsync(interfaceName, cancellationToken);
            if (!lastResult.Succeeded)
            {
                return bestAccessPoints.Length > 0
                    ? new WifiAccessPointCollectionResult(lastResult, bestAccessPoints)
                    : new WifiAccessPointCollectionResult(lastResult, []);
            }

            lastAccessPoints = ParseWifiAccessPoints(lastResult.StandardOutput, interfaceName);
            if (IsBetterWifiAccessPointRead(lastAccessPoints, bestAccessPoints))
            {
                bestAccessPoints = lastAccessPoints;
            }

            if (!ShouldRetryWifiAccessPointRead(bestAccessPoints, attempt))
            {
                break;
            }

            await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken);
        }

        if (CountVisibleWifiNetworks(bestAccessPoints) <= 1)
        {
            var fallbackResult = await ListWifiAccessPointsWithIwAsync(interfaceName, cancellationToken);
            if (fallbackResult.Succeeded && IsBetterWifiAccessPointRead(fallbackResult.AccessPoints, bestAccessPoints))
            {
                logger.LogInformation(
                    "Using iw fallback for Wi-Fi scan. nmcli visible networks={NmcliVisibleCount}, iw visible networks={IwVisibleCount}.",
                    CountVisibleWifiNetworks(bestAccessPoints),
                    CountVisibleWifiNetworks(fallbackResult.AccessPoints));
                return fallbackResult;
            }
        }

        return new WifiAccessPointCollectionResult(
            lastResult ?? new ProcessResult(false, string.Empty, string.Empty, null),
            bestAccessPoints.Length > 0 ? bestAccessPoints : lastAccessPoints);
    }

    private async Task RequestWifiRescanAsync(string interfaceName, CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(
            ["--wait", "10", "device", "wifi", "rescan", "ifname", interfaceName],
            cancellationToken);

        if (!result.Succeeded)
        {
            logger.LogDebug("Explicit Wi-Fi rescan request failed. ExitCode={ExitCode}.", result.ExitCode);
        }
    }

    private async Task<ProcessResult> ListWifiAccessPointsAsync(string interfaceName, CancellationToken cancellationToken)
    {
        return await RunNmcliAsync(
            ["--terse", "--fields", "IN-USE,BSSID,SSID,SIGNAL,SECURITY,BARS", "device", "wifi", "list", "ifname", interfaceName, "--rescan", "no"],
            cancellationToken);
    }

    private async Task<WifiAccessPointCollectionResult> ListWifiAccessPointsWithIwAsync(
        string interfaceName,
        CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(
            "sudo",
            ["-n", "iw", "dev", interfaceName, "scan", "ap-force"],
            cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug("iw Wi-Fi scan fallback failed. ExitCode={ExitCode}.", result.ExitCode);
            return new WifiAccessPointCollectionResult(result, []);
        }

        return new WifiAccessPointCollectionResult(result, ParseIwAccessPoints(result.StandardOutput, interfaceName));
    }

    internal static bool ShouldRetryWifiAccessPointRead(IReadOnlyList<WifiAccessPointInfo> accessPoints, int attempt)
    {
        if (attempt >= 4)
        {
            return false;
        }

        return CountVisibleWifiNetworks(accessPoints) <= 1;
    }

    internal static int CountVisibleWifiNetworks(IReadOnlyList<WifiAccessPointInfo> accessPoints)
    {
        return accessPoints
            .Where(accessPoint => !string.IsNullOrWhiteSpace(accessPoint.Ssid)
                && !string.Equals(accessPoint.Ssid, "<hidden>", StringComparison.OrdinalIgnoreCase))
            .Select(accessPoint => accessPoint.Ssid)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Count();
    }

    internal static bool IsBetterWifiAccessPointRead(
        IReadOnlyList<WifiAccessPointInfo> candidateAccessPoints,
        IReadOnlyList<WifiAccessPointInfo> currentBestAccessPoints)
    {
        var candidateVisibleCount = CountVisibleWifiNetworks(candidateAccessPoints);
        var currentVisibleCount = CountVisibleWifiNetworks(currentBestAccessPoints);
        if (candidateVisibleCount != currentVisibleCount)
        {
            return candidateVisibleCount > currentVisibleCount;
        }

        if (candidateAccessPoints.Count != currentBestAccessPoints.Count)
        {
            return candidateAccessPoints.Count > currentBestAccessPoints.Count;
        }

        return false;
    }

    internal static WifiAccessPointInfo[] ParseIwAccessPoints(string output, string interfaceName)
    {
        if (string.IsNullOrWhiteSpace(output))
        {
            return [];
        }

        var accessPoints = new List<WifiAccessPointInfo>();
        var blocks = Regex.Split(output.Trim(), @"(?=^BSS\s+)", RegexOptions.Multiline);
        foreach (var block in blocks)
        {
            var accessPoint = ParseIwAccessPointBlock(block, interfaceName);
            if (accessPoint is not null)
            {
                accessPoints.Add(accessPoint);
            }
        }

        return accessPoints
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

    internal static WifiAccessPointInfo? ParseIwAccessPointBlock(string block, string interfaceName)
    {
        if (string.IsNullOrWhiteSpace(block))
        {
            return null;
        }

        var lines = block
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length == 0 || !lines[0].StartsWith("BSS ", StringComparison.Ordinal))
        {
            return null;
        }

        var headerMatch = Regex.Match(lines[0], @"^BSS\s+(?<bssid>[0-9a-f:]{17})\b(?<rest>.*)$", RegexOptions.IgnoreCase);
        if (!headerMatch.Success)
        {
            return null;
        }

        var signalLine = lines.FirstOrDefault(line => line.StartsWith("signal:", StringComparison.Ordinal));
        var ssidLine = lines.FirstOrDefault(line => line.StartsWith("SSID:", StringComparison.Ordinal));

        var signalDbm = TryParseIwSignal(signalLine);
        var security = InferIwSecurity(lines);

        return new WifiAccessPointInfo
        {
            InterfaceName = interfaceName,
            Ssid = ssidLine is null
                ? "<hidden>"
                : string.IsNullOrWhiteSpace(ssidLine["SSID:".Length..]) ? "<hidden>" : ssidLine["SSID:".Length..].Trim(),
            Bssid = headerMatch.Groups["bssid"].Value.ToUpperInvariant(),
            SignalPercent = signalDbm is null ? null : ConvertSignalDbmToPercent(signalDbm.Value),
            Security = security,
            SignalBars = signalDbm is null ? null : ConvertSignalPercentToBars(ConvertSignalDbmToPercent(signalDbm.Value)),
            IsActive = headerMatch.Groups["rest"].Value.Contains("associated", StringComparison.OrdinalIgnoreCase)
        };
    }

    internal static double? TryParseIwSignal(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        var match = Regex.Match(line, @"signal:\s*(?<signal>-?\d+(?:\.\d+)?)\s*dBm", RegexOptions.IgnoreCase);
        return match.Success && double.TryParse(match.Groups["signal"].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
    }

    internal static int ConvertSignalDbmToPercent(double signalDbm)
    {
        return Math.Clamp((int)Math.Round((signalDbm + 100d) * 2d, MidpointRounding.AwayFromZero), 0, 100);
    }

    internal static string ConvertSignalPercentToBars(int signalPercent)
    {
        return signalPercent switch
        {
            >= 75 => "▂▄▆█",
            >= 50 => "▂▄▆_",
            >= 25 => "▂▄__",
            > 0 => "▂___",
            _ => "____"
        };
    }

    internal static string? InferIwSecurity(IReadOnlyList<string> lines)
    {
        var hasRsn = lines.Any(line => line.StartsWith("RSN:", StringComparison.Ordinal));
        var hasWpa = lines.Any(line => line.StartsWith("WPA:", StringComparison.Ordinal));
        var hasSae = lines.Any(line => line.Contains("Authentication suites: SAE", StringComparison.Ordinal));
        var hasPrivacy = lines.Any(line => line.Contains("Privacy", StringComparison.Ordinal));

        if (hasRsn && hasSae)
        {
            return "WPA2 WPA3";
        }

        if (hasRsn && hasWpa)
        {
            return "WPA WPA2";
        }

        if (hasRsn)
        {
            return "WPA2";
        }

        if (hasWpa)
        {
            return "WPA";
        }

        if (hasPrivacy)
        {
            return "WEP";
        }

        return null;
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
        var result = await RunProcessAsync("nmcli", arguments, cancellationToken);
        if (result.Succeeded
            || !ShouldRetryNmcliWithSudo(result)
            || ContainsSensitiveWifiSecrets(arguments))
        {
            return result;
        }

        logger.LogInformation("Retrying NetworkManager command through sudo after authorization failure.");
        var elevatedResult = await RunProcessAsync("sudo", ["-n", "nmcli", .. arguments], cancellationToken);

        return IsSudoPasswordPromptResult(elevatedResult)
            ? result
            : elevatedResult;
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

    internal static string BuildWifiConnectFailureMessage(
        string ssid,
        ProcessResult result,
        WifiConnectionObservation? observation = null)
    {
        var message = BuildCommandFailureMessage(result, $"Unable to connect to Wi-Fi network '{ssid}'.");
        if (IsWrongWifiPasswordMessage(message))
        {
            return $"Incorrect Wi-Fi password for '{ssid}'.";
        }

        if (message.Contains("No network with SSID", StringComparison.OrdinalIgnoreCase))
        {
            return $"Wi-Fi network '{ssid}' is no longer in range.";
        }

        if (observation is not null
            && !string.IsNullOrWhiteSpace(observation.ConnectedSsid)
            && !string.Equals(observation.ConnectedSsid, ssid, StringComparison.Ordinal))
        {
            return $"Unable to connect to '{ssid}'. NetworkManager reported: {message} The adapter is still on '{observation.ConnectedSsid}'.";
        }

        return message;
    }

    internal static string BuildWifiConnectSuccessMessage(string ssid, bool? hasInternetAccess, ProcessResult result)
    {
        if (hasInternetAccess == false)
        {
            return $"Connected to '{ssid}', but internet access is unavailable.";
        }

        if (hasInternetAccess == true)
        {
            return $"Connected to '{ssid}'. Internet access is available.";
        }

        return string.IsNullOrWhiteSpace(result.StandardOutput)
            ? $"Connected to '{ssid}'."
            : result.StandardOutput.Trim();
    }

    internal static string BuildWifiConnectUnverifiedMessage(
        string ssid,
        WifiConnectionObservation observation,
        ProcessResult result)
    {
        if (!string.IsNullOrWhiteSpace(observation.ConnectedSsid)
            && !string.Equals(observation.ConnectedSsid, ssid, StringComparison.Ordinal))
        {
            var baseMessage = BuildCommandFailureMessage(result, $"Unable to confirm a connection to '{ssid}'.");
            return $"Unable to connect to '{ssid}'. NetworkManager reported: {baseMessage} The adapter is still on '{observation.ConnectedSsid}'.";
        }

        if (string.Equals(observation.ConnectionState, "disconnected", StringComparison.OrdinalIgnoreCase))
        {
            return $"Unable to connect to '{ssid}'. The wireless adapter reported a disconnected state.";
        }

        if (!string.IsNullOrWhiteSpace(observation.ConnectionState))
        {
            return $"Unable to confirm a connection to '{ssid}'. Current adapter state: {observation.ConnectionState}.";
        }

        return BuildCommandFailureMessage(result, $"Unable to confirm a connection to '{ssid}'.");
    }

    internal static bool IsWrongWifiPasswordMessage(string message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        return message.Contains("Secrets were required, but not provided", StringComparison.OrdinalIgnoreCase)
            || message.Contains("wrong password", StringComparison.OrdinalIgnoreCase)
            || message.Contains("bad password", StringComparison.OrdinalIgnoreCase)
            || message.Contains("invalid secrets", StringComparison.OrdinalIgnoreCase);
    }

    internal static bool ShouldRetryNmcliWithSudo(ProcessResult result)
    {
        if (result.Succeeded)
        {
            return false;
        }

        var message = BuildCommandFailureMessage(result, string.Empty);
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        return message.Contains("Not authorized to control networking", StringComparison.OrdinalIgnoreCase)
            || message.Contains("insufficient privileges", StringComparison.OrdinalIgnoreCase)
            || message.Contains("authorization failed", StringComparison.OrdinalIgnoreCase);
    }

    internal static bool IsSudoPasswordPromptResult(ProcessResult result)
    {
        if (result.Succeeded)
        {
            return false;
        }

        var message = BuildCommandFailureMessage(result, string.Empty);
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        return message.Contains("a password is required", StringComparison.OrdinalIgnoreCase)
            || message.Contains("password is required", StringComparison.OrdinalIgnoreCase)
            || message.Contains("a terminal is required", StringComparison.OrdinalIgnoreCase)
            || message.Contains("must have a tty", StringComparison.OrdinalIgnoreCase);
    }

    internal static bool ContainsSensitiveWifiSecrets(IReadOnlyList<string> arguments)
    {
        for (var index = 0; index < arguments.Count - 1; index++)
        {
            if (string.Equals(arguments[index], "password", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(arguments[index + 1]))
            {
                return true;
            }
        }

        return false;
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

    internal sealed record ProcessResult(
        bool Succeeded,
        string StandardOutput,
        string ErrorOutput,
        int? ExitCode);

    internal sealed record WifiConnectionObservation(
        string InterfaceName,
        string? ConnectionState,
        string? ConnectedSsid,
        string? ConnectedBssid,
        bool? HasInternetAccess,
        bool IsConnectedToTarget);

    private sealed record WifiAccessPointCollectionResult(
        ProcessResult Result,
        WifiAccessPointInfo[] AccessPoints)
    {
        public bool Succeeded => Result.Succeeded;
    }
}
