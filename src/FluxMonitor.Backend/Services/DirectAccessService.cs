using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class DirectAccessService(
    ICommandRunner commandRunner,
    DirectAccessStore directAccessStore,
    NetworkManagementService networkManagementService,
    BluetoothManagementService bluetoothManagementService,
    ILogger<DirectAccessService> logger)
{
    internal const string WifiProfileName = "fluxmonitor-direct-wifi";
    internal const string BluetoothProfileName = "fluxmonitor-direct-bluetooth";
    internal const string BluetoothInterfaceName = "btnap0";

    private static readonly Regex UnsafeSsidCharacterRegex = new(
        @"[^A-Za-z0-9_-]+",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await directAccessStore.InitializeAsync(cancellationToken);
        await ReconcileDesiredStateAsync(cancellationToken);
    }

    public async Task<DirectAccessSnapshot> GetSnapshotAsync(
        NetworkConnectivitySnapshot network,
        BluetoothRuntimeSnapshot bluetooth,
        CancellationToken cancellationToken = default)
    {
        var settings = await directAccessStore.GetSettingsAsync(cancellationToken);

        if (!OperatingSystem.IsLinux())
        {
            return BuildUnsupportedSnapshot(
                "Fallback local access is supported on Linux hosts with NetworkManager.",
                settings,
                bluetooth);
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            logger.LogDebug(
                "Local access snapshot could not check nmcli availability. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                toolCheck.StandardOutput,
                toolCheck.ErrorOutput);
            return BuildUnsupportedSnapshot(
                "Fallback local access is unavailable because NetworkManager tools are not available on this host.",
                settings,
                bluetooth);
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        var wifiTask = BuildWifiSnapshotAsync(network, activeConnections, settings, cancellationToken);
        var bluetoothTask = BuildBluetoothSnapshotAsync(bluetooth, activeConnections, settings, cancellationToken);

        await Task.WhenAll(wifiTask, bluetoothTask);

        var wifi = await wifiTask;
        var bluetoothAccess = await bluetoothTask;

        return new DirectAccessSnapshot
        {
            Settings = ToSettingsSnapshot(settings),
            Mode = BuildLocalAccessModeSnapshot(settings, wifi, bluetoothAccess),
            Wifi = wifi,
            Bluetooth = bluetoothAccess
        };
    }

    public async Task<LocalAccessModeCommandResult> SetLocalAccessModeEnabledAsync(
        bool enabled,
        CancellationToken cancellationToken = default)
    {
        var currentSettings = await directAccessStore.GetSettingsAsync(cancellationToken);

        try
        {
            await directAccessStore.SaveSettingsAsync(
                enabled ? DirectAccessStore.AutoStartModeWhenWifiNotConnected : DirectAccessStore.AutoStartModeOff,
                currentSettings.WifiPassword,
                currentSettings.HotspotNameOverride,
                currentSettings.BluetoothDeviceNameOverride,
                cancellationToken);
        }
        catch (Exception exception) when (exception is InvalidOperationException or ArgumentException)
        {
            return new LocalAccessModeCommandResult
            {
                Success = false,
                Enabled = currentSettings.AutoStartMode != DirectAccessStore.AutoStartModeOff,
                Active = await IsLocalAccessActiveAsync(cancellationToken),
                Message = exception.Message
            };
        }

        await ReconcileDesiredStateAsync(cancellationToken);

        var network = await networkManagementService.GetSnapshotAsync(cancellationToken);
        var bluetooth = await bluetoothManagementService.GetSnapshotAsync(cancellationToken);
        var snapshot = await GetSnapshotAsync(network, bluetooth, cancellationToken);

        return new LocalAccessModeCommandResult
        {
            Success = true,
            Enabled = snapshot.Mode.Enabled,
            Active = snapshot.Mode.Active,
            Message = enabled
                ? BuildLocalAccessModeEnabledMessage(snapshot.Mode.HotspotName, snapshot.Bluetooth.DeviceName)
                : "Fallback local access is off."
        };
    }

    public async Task<SaveDirectAccessSettingsResult> SaveLocalAccessAdvancedSettingsAsync(
        string? wifiPassword,
        string? hotspotName,
        string? bluetoothDeviceName,
        CancellationToken cancellationToken = default)
    {
        var currentSettings = await directAccessStore.GetSettingsAsync(cancellationToken);
        return await SaveSettingsAsync(
            currentSettings.AutoStartMode,
            wifiPassword,
            hotspotName,
            bluetoothDeviceName,
            cancellationToken);
    }

    public async Task<SaveDirectAccessSettingsResult> SaveSettingsAsync(
        string? autoStartMode,
        string? wifiPassword,
        string? hotspotName,
        string? bluetoothDeviceName,
        CancellationToken cancellationToken = default)
    {
        var currentSettings = await directAccessStore.GetSettingsAsync(cancellationToken);

        try
        {
            await directAccessStore.SaveSettingsAsync(autoStartMode, wifiPassword, hotspotName, bluetoothDeviceName, cancellationToken);
        }
        catch (Exception exception) when (exception is InvalidOperationException or ArgumentException)
        {
            return new SaveDirectAccessSettingsResult
            {
                Success = false,
                Message = exception.Message,
                Settings = ToSettingsSnapshot(currentSettings)
            };
        }

        var updatedSettings = await directAccessStore.GetSettingsAsync(cancellationToken);
        await bluetoothManagementService.SetDirectAccessAliasAsync(GetEffectiveBluetoothDeviceName(updatedSettings), cancellationToken);
        var directWifiActive = await IsDirectWifiActiveAsync(cancellationToken);

        return new SaveDirectAccessSettingsResult
        {
            Success = true,
            Message = BuildSettingsSavedMessage(currentSettings, updatedSettings, directWifiActive),
            Settings = ToSettingsSnapshot(updatedSettings)
        };
    }

    public async Task<DirectAccessCommandResult> SetWifiEnabledAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = "Local access hotspot is supported on Linux hosts with NetworkManager."
            };
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = "NetworkManager command-line tools are not available on this host."
            };
        }

        var network = await networkManagementService.GetSnapshotAsync(cancellationToken);
        var interfaceName = ResolveWifiInterfaceName(network);
        if (string.IsNullOrWhiteSpace(interfaceName))
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = "No Wi-Fi interface is available for local access."
            };
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);

        if (enabled)
        {
            if (IsConnectionActive(activeConnections, WifiProfileName))
            {
                return new DirectAccessCommandResult
                {
                    Success = true,
                    Enabled = true,
                    Message = "Local access hotspot is already on."
                };
            }

            if (network.WifiPowered == false)
            {
                var powerResult = await networkManagementService.SetWifiPowerAsync(enabled: true, cancellationToken);
                if (!powerResult.Success)
                {
                    return new DirectAccessCommandResult
                    {
                        Success = false,
                        Enabled = false,
                        Message = powerResult.Message
                    };
                }
            }

            var settings = await directAccessStore.GetSettingsAsync(cancellationToken);
            var configureResult = await EnsureWifiProfileAsync(interfaceName, settings, cancellationToken);
            if (!configureResult.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(configureResult, "Local access hotspot could not be configured.")
                };
            }

            var upResult = await RunNmcliAsync(["connection", "up", "id", WifiProfileName, "ifname", interfaceName], cancellationToken);
            if (!upResult.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(upResult, "Local access hotspot could not be turned on.")
                };
            }

            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = true,
                Message = BuildWifiEnabledMessage(settings)
            };
        }

        if (!IsConnectionActive(activeConnections, WifiProfileName))
        {
            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = false,
                Message = "Local access hotspot is already off."
            };
        }

        var downResult = await RunNmcliAsync(["connection", "down", "id", WifiProfileName], cancellationToken);
        if (!downResult.Succeeded)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = true,
                Message = BuildCommandFailureMessage(downResult, "Local access hotspot could not be turned off.")
            };
        }

        return new DirectAccessCommandResult
        {
            Success = true,
            Enabled = false,
            Message = "Local access hotspot is off."
        };
    }

    public async Task<DirectAccessCommandResult> SetBluetoothEnabledAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = "Local access Bluetooth is supported on Linux hosts with BlueZ and NetworkManager."
            };
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = "NetworkManager command-line tools are not available on this host."
            };
        }

        var bluetoothState = await bluetoothManagementService.GetDirectAccessStateAsync(cancellationToken);
        if (!bluetoothState.Supported)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = bluetoothState.StatusMessage ?? "No Bluetooth adapter is available for local access."
            };
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);

        if (enabled)
        {
            if (IsConnectionActive(activeConnections, BluetoothProfileName))
            {
                return new DirectAccessCommandResult
                {
                    Success = true,
                    Enabled = true,
                    Message = "Local access Bluetooth is already on."
                };
            }

            if (!bluetoothState.Powered)
            {
                var powerResult = await bluetoothManagementService.SetPowerAsync(enabled: true, cancellationToken);
                if (!powerResult.Success)
                {
                    return new DirectAccessCommandResult
                    {
                        Success = false,
                        Enabled = false,
                        Message = powerResult.Message
                    };
                }
            }

            var settings = await directAccessStore.GetSettingsAsync(cancellationToken);
            await bluetoothManagementService.SetDirectAccessAliasAsync(GetEffectiveBluetoothDeviceName(settings), cancellationToken);

            var configureResult = await EnsureBluetoothProfileAsync(cancellationToken);
            if (!configureResult.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(configureResult, "Local access Bluetooth could not be configured.")
                };
            }

            var visibilityResult = await bluetoothManagementService.SetDirectAccessVisibilityAsync(enabled: true, cancellationToken);
            if (!visibilityResult.Success)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = visibilityResult.Message
                };
            }

            var upResult = await RunNmcliAsync(["connection", "up", "id", BluetoothProfileName], cancellationToken);
            if (!upResult.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(upResult, "Local access Bluetooth could not be turned on.")
                };
            }

            var adapterState = await bluetoothManagementService.GetDirectAccessStateAsync(cancellationToken);
            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = true,
                Message = $"Local access Bluetooth is on. Pair with '{adapterState.Alias ?? Environment.MachineName}' and join the PAN connection."
            };
        }

        var downResult = IsConnectionActive(activeConnections, BluetoothProfileName)
            ? await RunNmcliAsync(["connection", "down", "id", BluetoothProfileName], cancellationToken)
            : new NetworkManagementService.ProcessResult(true, string.Empty, string.Empty, 0);

        var visibilityOffResult = await bluetoothManagementService.SetDirectAccessVisibilityAsync(enabled: false, cancellationToken);
        if (!downResult.Succeeded)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = true,
                Message = BuildCommandFailureMessage(downResult, "Local access Bluetooth could not be turned off.")
            };
        }

        if (!visibilityOffResult.Success && (visibilityOffResult.Discoverable || visibilityOffResult.Pairable))
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = false,
                Message = visibilityOffResult.Message
            };
        }

        return new DirectAccessCommandResult
        {
            Success = true,
            Enabled = false,
            Message = "Local access Bluetooth is off."
        };
    }

    internal static string BuildDefaultWifiSsid(string hostName)
    {
        var normalizedHostName = UnsafeSsidCharacterRegex
            .Replace(hostName.Trim(), "-")
            .Trim('-');

        if (string.IsNullOrWhiteSpace(normalizedHostName))
        {
            normalizedHostName = "Pi";
        }

        const string prefix = "FluxMonitor-";
        var maxSuffixLength = 32 - prefix.Length;
        if (normalizedHostName.Length > maxSuffixLength)
        {
            normalizedHostName = normalizedHostName[..maxSuffixLength];
        }

        return $"{prefix}{normalizedHostName}";
    }

    internal static ActiveConnectionInfo? ParseActiveConnectionLine(string line)
    {
        var fields = NetworkManagementService.SplitNmcliFields(line);
        if (fields.Length < 3)
        {
            return null;
        }

        return new ActiveConnectionInfo(
            Name: fields[0].Trim(),
            Type: fields[1].Trim(),
            Device: fields[2].Trim());
    }

    internal static string BuildSettingsSavedMessage(
        DirectAccessStore.DirectAccessSettings previousSettings,
        DirectAccessStore.DirectAccessSettings updatedSettings,
        bool directWifiActive)
    {
        var hotspotSettingsChanged = !string.Equals(
            GetEffectiveHotspotName(previousSettings),
            GetEffectiveHotspotName(updatedSettings),
            StringComparison.Ordinal)
            || !string.Equals(
            previousSettings.WifiPassword,
            updatedSettings.WifiPassword,
            StringComparison.Ordinal);

        if (hotspotSettingsChanged && directWifiActive)
        {
            return "Fallback local access settings were saved. Changes apply the next time fallback local access starts.";
        }

        return "Fallback local access settings were saved.";
    }

    internal static IReadOnlyList<string> BuildWifiSecurityArguments(string? wifiPassword)
    {
        if (string.IsNullOrEmpty(wifiPassword))
        {
            return [];
        }

        return ShouldUseWpaPskSecurity(wifiPassword)
            ? [
                "802-11-wireless-security.key-mgmt",
                "wpa-psk",
                "802-11-wireless-security.psk",
                wifiPassword
            ]
            : [
                "802-11-wireless-security.key-mgmt",
                "sae",
                "802-11-wireless-security.psk",
                wifiPassword
            ];
    }

    public async Task ReconcileDesiredStateAsync(CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            logger.LogDebug(
                "Skipping local access reconciliation because nmcli is unavailable. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                toolCheck.StandardOutput,
                toolCheck.ErrorOutput);
            return;
        }

        var settings = await directAccessStore.GetSettingsAsync(cancellationToken);
        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);

        if (string.Equals(
            settings.AutoStartMode,
            DirectAccessStore.AutoStartModeOff,
            StringComparison.Ordinal))
        {
            await DisableLocalAccessIfActiveAsync(activeConnections, cancellationToken);
            return;
        }

        var network = await networkManagementService.GetSnapshotAsync(cancellationToken);
        if (IsWifiConnected(network))
        {
            await DisableLocalAccessIfActiveAsync(activeConnections, cancellationToken);
            return;
        }

        if (IsConnectionActive(activeConnections, WifiProfileName))
        {
            logger.LogDebug("Wi-Fi is not connected and local access hotspot is already active.");
        }
        else
        {
            logger.LogInformation("Wi-Fi is not connected. Enabling local access hotspot.");

            var wifiResult = await SetWifiEnabledAsync(enabled: true, cancellationToken);
            if (!wifiResult.Success)
            {
                logger.LogWarning("Local access could not enable hotspot Wi-Fi. Message={Message}", wifiResult.Message);
            }
        }

        if (IsConnectionActive(activeConnections, BluetoothProfileName))
        {
            logger.LogDebug("Wi-Fi is not connected and local access Bluetooth is already active.");
        }
        else
        {
            logger.LogInformation("Wi-Fi is not connected. Enabling local access Bluetooth.");

            var bluetoothResult = await SetBluetoothEnabledAsync(enabled: true, cancellationToken);
            if (!bluetoothResult.Success)
            {
                logger.LogWarning("Local access could not enable Bluetooth fallback. Message={Message}", bluetoothResult.Message);
            }
        }
    }

    private static DirectAccessSnapshot BuildUnsupportedSnapshot(
        string message,
        DirectAccessStore.DirectAccessSettings settings,
        BluetoothRuntimeSnapshot bluetooth)
    {
        return new DirectAccessSnapshot
        {
            Settings = ToSettingsSnapshot(settings),
            Mode = BuildLocalAccessModeSnapshot(
                settings,
                new WifiDirectAccessSnapshot
                {
                    Supported = false,
                    Enabled = false,
                    StatusMessage = message,
                    Ssid = GetEffectiveHotspotName(settings)
                },
                new BluetoothDirectAccessSnapshot
                {
                    Supported = false,
                    Enabled = false,
                    DeviceName = bluetooth.Supported ? GetEffectiveBluetoothDeviceName(settings) : null,
                    RequiresPairing = true,
                    StatusMessage = message
                }),
            Wifi = new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = message,
                Ssid = GetEffectiveHotspotName(settings)
            },
            Bluetooth = new BluetoothDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                DeviceName = bluetooth.Supported ? GetEffectiveBluetoothDeviceName(settings) : null,
                RequiresPairing = true,
                StatusMessage = message
            }
        };
    }

    private static LocalAccessModeSnapshot BuildLocalAccessModeSnapshot(
        DirectAccessStore.DirectAccessSettings settings,
        WifiDirectAccessSnapshot wifi,
        BluetoothDirectAccessSnapshot bluetooth)
    {
        var enabled = !string.Equals(settings.AutoStartMode, DirectAccessStore.AutoStartModeOff, StringComparison.Ordinal);
        var supported = wifi.Supported || bluetooth.Supported;
        var active = wifi.Enabled || bluetooth.Enabled;

        var addresses = wifi.Addresses
            .Concat(bluetooth.Addresses)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(address => address.Contains(':') ? 1 : 0)
            .ThenBy(address => address, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        return new LocalAccessModeSnapshot
        {
            Supported = supported,
            Enabled = enabled,
            Active = active,
            HostName = Environment.MachineName,
            StatusMessage = !supported
                ? "Fallback local access is unavailable on this host."
                : !enabled
                    ? "Fallback local access is off."
                    : BuildLocalAccessModeEnabledMessage(wifi.Ssid, bluetooth.DeviceName),
            HotspotName = wifi.Ssid,
            HotspotPassword = settings.WifiPassword,
            Addresses = addresses
        };
    }

    private static string BuildLocalAccessModeEnabledMessage(string? hotspotName, string? bluetoothDeviceName)
    {
        var details = new List<string>();
        var formattedHotspotName = FormatLocalAccessHotspotName(hotspotName);
        var formattedBluetoothDeviceName = FormatLocalAccessBluetoothDeviceName(bluetoothDeviceName);

        if (!string.IsNullOrWhiteSpace(formattedHotspotName))
        {
            details.Add($"Hotspot SSID: {formattedHotspotName}");
        }

        if (!string.IsNullOrWhiteSpace(formattedBluetoothDeviceName))
        {
            details.Add($"Bluetooth name: {formattedBluetoothDeviceName}");
        }

        return details.Count switch
        {
            0 => "Fallback local access is on.",
            1 => $"Fallback local access is on. {details[0]}.",
            _ => $"Fallback local access is on. {details[0]}. {details[1]}."
        };
    }

    private static string FormatLocalAccessHotspotName(string? hotspotName)
    {
        if (string.IsNullOrWhiteSpace(hotspotName))
        {
            return string.Empty;
        }

        return hotspotName.Trim();
    }

    private static string FormatLocalAccessBluetoothDeviceName(string? bluetoothDeviceName)
    {
        return string.IsNullOrWhiteSpace(bluetoothDeviceName) ? string.Empty : bluetoothDeviceName.Trim();
    }

    private async Task<WifiDirectAccessSnapshot> BuildWifiSnapshotAsync(
        NetworkConnectivitySnapshot network,
        IReadOnlyList<ActiveConnectionInfo> activeConnections,
        DirectAccessStore.DirectAccessSettings settings,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var interfaceName = ResolveWifiInterfaceName(network);
        var enabled = IsConnectionActive(activeConnections, WifiProfileName);
        var currentWifi = network.WifiInterfaces.FirstOrDefault(wifiInterface => !string.IsNullOrWhiteSpace(wifiInterface.ConnectedSsid));
        var currentNetworkName = enabled ? null : currentWifi?.ConnectedSsid;

        if (!network.Supported)
        {
            return new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = network.StatusMessage ?? "Local access hotspot is unavailable on this host.",
                Ssid = GetEffectiveHotspotName(settings)
            };
        }

        if (string.IsNullOrWhiteSpace(interfaceName))
        {
            return new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = "No Wi-Fi interface is available for local access.",
                Ssid = GetEffectiveHotspotName(settings)
            };
        }

        return new WifiDirectAccessSnapshot
        {
            Supported = true,
            Enabled = enabled,
            StatusMessage = enabled
                ? string.IsNullOrEmpty(settings.WifiPassword)
                    ? "Local access hotspot is on with no password."
                    : "Local access hotspot is on with a password."
                : network.WifiPowered == false
                    ? "Turning this on powers the Wi-Fi radio and starts the local access hotspot."
                    : !string.IsNullOrWhiteSpace(currentNetworkName)
                        ? $"Turning this on will disconnect '{currentNetworkName}' and move Wi-Fi onto the local access hotspot."
                        : "Creates a local Wi-Fi hotspot directly on the device.",
            InterfaceName = interfaceName,
            CurrentNetworkName = currentNetworkName,
            DisconnectsCurrentWifi = !enabled && !string.IsNullOrWhiteSpace(currentNetworkName),
            Ssid = GetEffectiveHotspotName(settings),
            Addresses = enabled ? GetInterfaceAddresses(interfaceName) : []
        };
    }

    private async Task<BluetoothDirectAccessSnapshot> BuildBluetoothSnapshotAsync(
        BluetoothRuntimeSnapshot bluetooth,
        IReadOnlyList<ActiveConnectionInfo> activeConnections,
        DirectAccessStore.DirectAccessSettings settings,
        CancellationToken cancellationToken)
    {
        var adapterState = await bluetoothManagementService.GetDirectAccessStateAsync(cancellationToken);
        var enabled = IsConnectionActive(activeConnections, BluetoothProfileName);
        var deviceName = GetEffectiveBluetoothDeviceName(settings);

        if (!adapterState.Supported)
        {
            return new BluetoothDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = adapterState.StatusMessage ?? bluetooth.StatusMessage ?? "Local access Bluetooth is unavailable on this host.",
                DeviceName = deviceName,
                RequiresPairing = true,
                Discoverable = false,
                Pairable = false
            };
        }

        return new BluetoothDirectAccessSnapshot
        {
            Supported = true,
            Enabled = enabled,
            StatusMessage = enabled
                ? "Local access Bluetooth is on. Pair from your device settings and join the PAN connection."
                : !adapterState.Powered
                    ? "Turning this on powers Bluetooth, makes the device discoverable, and starts a Bluetooth PAN."
                    : "Keeps the device reachable over Bluetooth PAN when your phone or laptop supports it.",
            InterfaceName = BluetoothInterfaceName,
            DeviceName = deviceName,
            RequiresPairing = true,
            Discoverable = adapterState.Discoverable,
            Pairable = adapterState.Pairable,
            Addresses = enabled ? GetInterfaceAddresses(BluetoothInterfaceName) : []
        };
    }

    private async Task<IReadOnlyList<ActiveConnectionInfo>> GetActiveConnectionsAsync(CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(["--terse", "--fields", "NAME,TYPE,DEVICE", "connection", "show", "--active"], cancellationToken);
        if (!result.Succeeded)
        {
            logger.LogDebug(
                "Local access could not list active NetworkManager connections. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                result.StandardOutput,
                result.ErrorOutput);
            return [];
        }

        return result.StandardOutput
            .Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(ParseActiveConnectionLine)
            .Where(connection => connection is not null)
            .Cast<ActiveConnectionInfo>()
            .ToArray();
    }

    private async Task<bool> IsDirectWifiActiveAsync(CancellationToken cancellationToken)
    {
        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        return IsConnectionActive(activeConnections, WifiProfileName);
    }

    private async Task<bool> IsLocalAccessActiveAsync(CancellationToken cancellationToken)
    {
        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        return IsConnectionActive(activeConnections, WifiProfileName)
            || IsConnectionActive(activeConnections, BluetoothProfileName);
    }

    private async Task DisableLocalAccessIfActiveAsync(
        IReadOnlyList<ActiveConnectionInfo> activeConnections,
        CancellationToken cancellationToken)
    {
        if (IsConnectionActive(activeConnections, WifiProfileName))
        {
            var wifiResult = await SetWifiEnabledAsync(enabled: false, cancellationToken);
            if (!wifiResult.Success)
            {
                logger.LogWarning("Local access could not disable hotspot Wi-Fi. Message={Message}", wifiResult.Message);
            }
        }

        if (IsConnectionActive(activeConnections, BluetoothProfileName))
        {
            var bluetoothResult = await SetBluetoothEnabledAsync(enabled: false, cancellationToken);
            if (!bluetoothResult.Success)
            {
                logger.LogWarning("Local access could not disable Bluetooth fallback. Message={Message}", bluetoothResult.Message);
            }
        }
    }

    private async Task<NetworkManagementService.ProcessResult> EnsureWifiProfileAsync(
        string interfaceName,
        DirectAccessStore.DirectAccessSettings settings,
        CancellationToken cancellationToken)
    {
        var deleteResult = await DeleteConnectionProfileIfExistsAsync(WifiProfileName, cancellationToken);
        if (!deleteResult.Succeeded)
        {
            return deleteResult;
        }

        var arguments = new List<string>
        {
            "connection",
            "add",
            "type",
            "wifi",
            "ifname",
            interfaceName,
            "con-name",
            WifiProfileName,
            "autoconnect",
            "no",
            "802-11-wireless.ssid",
            GetEffectiveHotspotName(settings),
            "802-11-wireless.mode",
            "ap",
            "ipv4.method",
            "shared",
            "ipv6.method",
            "shared"
        };

        arguments.AddRange(BuildWifiSecurityArguments(settings.WifiPassword));

        return await RunNmcliAsync(arguments, cancellationToken);
    }

    private async Task<NetworkManagementService.ProcessResult> EnsureBluetoothProfileAsync(CancellationToken cancellationToken)
    {
        var deleteResult = await DeleteConnectionProfileIfExistsAsync(BluetoothProfileName, cancellationToken);
        if (!deleteResult.Succeeded)
        {
            return deleteResult;
        }

        return await RunNmcliAsync(
            [
                "connection",
                "add",
                "type",
                "bluetooth",
                "con-name",
                BluetoothProfileName,
                "autoconnect",
                "no",
                "ifname",
                BluetoothInterfaceName,
                "bluetooth.type",
                "nap",
                "ipv4.method",
                "shared",
                "ipv6.method",
                "shared"
            ],
            cancellationToken);
    }

    private async Task<NetworkManagementService.ProcessResult> DeleteConnectionProfileIfExistsAsync(
        string profileName,
        CancellationToken cancellationToken)
    {
        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        if (IsConnectionActive(activeConnections, profileName))
        {
            var downResult = await RunNmcliAsync(["connection", "down", "id", profileName], cancellationToken);
            if (!downResult.Succeeded)
            {
                return downResult;
            }
        }

        var result = await RunNmcliAsync(["--terse", "--fields", "NAME", "connection", "show"], cancellationToken);
        if (!result.Succeeded)
        {
            return result;
        }

        var exists = result.StandardOutput
            .Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(name => string.Equals(name, profileName, StringComparison.OrdinalIgnoreCase));

        if (!exists)
        {
            return new NetworkManagementService.ProcessResult(true, string.Empty, string.Empty, 0);
        }

        return await RunNmcliAsync(["connection", "delete", "id", profileName], cancellationToken);
    }

    private static DirectAccessSettingsSnapshot ToSettingsSnapshot(DirectAccessStore.DirectAccessSettings settings)
    {
        return new DirectAccessSettingsSnapshot
        {
            StorageAvailable = settings.StorageAvailable,
            AutoStartMode = settings.AutoStartMode,
            WifiPassword = settings.WifiPassword,
            HotspotName = GetEffectiveHotspotName(settings),
            BluetoothDeviceName = GetEffectiveBluetoothDeviceName(settings)
        };
    }

    private static string BuildWifiEnabledMessage(DirectAccessStore.DirectAccessSettings settings)
    {
        var ssid = GetEffectiveHotspotName(settings);
        return string.IsNullOrEmpty(settings.WifiPassword)
            ? $"Local access hotspot is on. Join '{ssid}' with no password."
            : $"Local access hotspot is on. Join '{ssid}' with the configured password.";
    }

    private static string GetEffectiveHotspotName(DirectAccessStore.DirectAccessSettings settings)
    {
        return string.IsNullOrWhiteSpace(settings.HotspotNameOverride)
            ? BuildDefaultWifiSsid(Environment.MachineName)
            : settings.HotspotNameOverride.Trim();
    }

    private static string GetEffectiveBluetoothDeviceName(DirectAccessStore.DirectAccessSettings settings)
    {
        return string.IsNullOrWhiteSpace(settings.BluetoothDeviceNameOverride)
            ? Environment.MachineName
            : settings.BluetoothDeviceNameOverride.Trim();
    }

    private static bool IsWifiConnected(NetworkConnectivitySnapshot network)
    {
        return network.WifiInterfaces.Any(wifiInterface => !string.IsNullOrWhiteSpace(wifiInterface.ConnectedSsid));
    }

    private static string? ResolveWifiInterfaceName(NetworkConnectivitySnapshot network)
    {
        return network.WifiInterfaces
            .Select(wifiInterface => wifiInterface.Name)
            .FirstOrDefault(name => !string.IsNullOrWhiteSpace(name));
    }

    private static bool IsConnectionActive(IReadOnlyList<ActiveConnectionInfo> activeConnections, string profileName)
    {
        return activeConnections.Any(connection => string.Equals(connection.Name, profileName, StringComparison.OrdinalIgnoreCase));
    }

    private static bool ShouldUseWpaPskSecurity(string wifiPassword)
    {
        return (wifiPassword.Length >= 8 && wifiPassword.Length <= 63)
            || (wifiPassword.Length == 64 && wifiPassword.All(Uri.IsHexDigit));
    }

    private static IReadOnlyList<string> GetInterfaceAddresses(string interfaceName)
    {
        return NetworkInterface.GetAllNetworkInterfaces()
            .Where(networkInterface => string.Equals(networkInterface.Name, interfaceName, StringComparison.Ordinal))
            .SelectMany(networkInterface => networkInterface.GetIPProperties().UnicastAddresses)
            .Select(unicastAddress => unicastAddress.Address)
            .Where(address =>
                address.AddressFamily is AddressFamily.InterNetwork or AddressFamily.InterNetworkV6
                && !IPAddress.IsLoopback(address))
            .Select(address => address.ToString())
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(address => address.Contains(':') ? 1 : 0)
            .ThenBy(address => address, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private async Task<NetworkManagementService.ProcessResult> RunNmcliAsync(IReadOnlyList<string> arguments, CancellationToken cancellationToken)
    {
        var result = await RunCommandAsync("nmcli", arguments, cancellationToken);
        if (result.Succeeded || !NetworkManagementService.ShouldRetryNmcliWithSudo(result))
        {
            return result;
        }

        var elevatedResult = await RunCommandAsync("sudo", ["-n", "nmcli", .. arguments], cancellationToken);
        if (NetworkManagementService.IsSudoPasswordPromptResult(elevatedResult))
        {
            elevatedResult = await RunCommandAsync(
                "sudo",
                ["-n", NetworkManagementService.ManagedElevationHelperPath, "nmcli", .. arguments],
                cancellationToken);
        }

        if (NetworkManagementService.IsSudoPasswordPromptResult(elevatedResult))
        {
            return result;
        }

        return elevatedResult;
    }

    private async Task<NetworkManagementService.ProcessResult> RunCommandAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        var result = await commandRunner.RunAsync(fileName, arguments, cancellationToken);
        return new NetworkManagementService.ProcessResult(
            result.Succeeded,
            result.StandardOutput,
            result.StandardError,
            result.ExitCode);
    }

    private static string BuildCommandFailureMessage(NetworkManagementService.ProcessResult result, string fallbackMessage)
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

    internal sealed record ActiveConnectionInfo(string Name, string Type, string Device);
}
