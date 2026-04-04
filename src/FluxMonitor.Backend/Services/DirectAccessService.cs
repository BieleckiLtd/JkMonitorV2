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
        await ReconcileStartupStateAsync(cancellationToken);
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
                "Direct AP is supported on Linux hosts with NetworkManager.",
                settings,
                bluetooth);
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            logger.LogDebug(
                "Direct AP snapshot could not check nmcli availability. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                toolCheck.StandardOutput,
                toolCheck.ErrorOutput);
            return BuildUnsupportedSnapshot(
                "NetworkManager command-line tools are not available on this host.",
                settings,
                bluetooth);
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        var wifiTask = BuildWifiSnapshotAsync(network, activeConnections, settings, cancellationToken);
        var bluetoothTask = BuildBluetoothSnapshotAsync(bluetooth, activeConnections, cancellationToken);

        await Task.WhenAll(wifiTask, bluetoothTask);

        return new DirectAccessSnapshot
        {
            Settings = ToSettingsSnapshot(settings),
            Wifi = await wifiTask,
            Bluetooth = await bluetoothTask
        };
    }

    public async Task<SaveDirectAccessSettingsResult> SaveSettingsAsync(
        string? autoStartMode,
        string? wifiPassword,
        CancellationToken cancellationToken = default)
    {
        var currentSettings = await directAccessStore.GetSettingsAsync(cancellationToken);

        try
        {
            await directAccessStore.SaveSettingsAsync(autoStartMode, wifiPassword, cancellationToken);
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
                Message = "Direct AP Wi-Fi is supported on Linux hosts with NetworkManager."
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
                Message = "No Wi-Fi interface is available for Direct AP."
            };
        }

        if (enabled)
        {
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
                    Message = BuildCommandFailureMessage(configureResult, "Direct AP Wi-Fi could not be configured.")
                };
            }

            var upResult = await RunNmcliAsync(["connection", "up", "id", WifiProfileName, "ifname", interfaceName], cancellationToken);
            if (!upResult.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(upResult, "Direct AP Wi-Fi could not be turned on.")
                };
            }

            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = true,
                Message = BuildWifiEnabledMessage(settings)
            };
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        if (!IsConnectionActive(activeConnections, WifiProfileName))
        {
            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = false,
                Message = "Direct AP Wi-Fi is already off."
            };
        }

        var downResult = await RunNmcliAsync(["connection", "down", "id", WifiProfileName], cancellationToken);
        if (!downResult.Succeeded)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = true,
                Message = BuildCommandFailureMessage(downResult, "Direct AP Wi-Fi could not be turned off.")
            };
        }

        return new DirectAccessCommandResult
        {
            Success = true,
            Enabled = false,
            Message = "Direct AP Wi-Fi is off."
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
                Message = "Direct AP Bluetooth is supported on Linux hosts with BlueZ and NetworkManager."
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
                Message = bluetoothState.StatusMessage ?? "No Bluetooth adapter is available for Direct AP."
            };
        }

        if (enabled)
        {
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

            var configureResult = await EnsureBluetoothProfileAsync(cancellationToken);
            if (!configureResult.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(configureResult, "Direct AP Bluetooth could not be configured.")
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
                    Message = BuildCommandFailureMessage(upResult, "Direct AP Bluetooth could not be turned on.")
                };
            }

            var adapterState = await bluetoothManagementService.GetDirectAccessStateAsync(cancellationToken);
            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = true,
                Message = $"Direct AP Bluetooth is on. Pair with '{adapterState.Alias ?? Environment.MachineName}' and join the PAN connection."
            };
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
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
                Message = BuildCommandFailureMessage(downResult, "Direct AP Bluetooth could not be turned off.")
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
            Message = "Direct AP Bluetooth is off."
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
        var passwordChanged = !string.Equals(
            previousSettings.WifiPassword,
            updatedSettings.WifiPassword,
            StringComparison.Ordinal);

        if (passwordChanged && directWifiActive)
        {
            return "Direct AP settings were saved. Restart Direct AP Wi-Fi before the new password takes effect.";
        }

        return "Direct AP settings were saved.";
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

    private async Task ReconcileStartupStateAsync(CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            logger.LogDebug(
                "Skipping Direct AP startup reconciliation because nmcli is unavailable. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                toolCheck.StandardOutput,
                toolCheck.ErrorOutput);
            return;
        }

        var settings = await directAccessStore.GetSettingsAsync(cancellationToken);
        if (!string.Equals(
            settings.AutoStartMode,
            DirectAccessStore.AutoStartModeWhenWifiNotConnected,
            StringComparison.Ordinal))
        {
            logger.LogDebug("Direct AP startup reconciliation skipped because auto-start mode is {AutoStartMode}.", settings.AutoStartMode);
            return;
        }

        var network = await networkManagementService.GetSnapshotAsync(cancellationToken);
        if (IsWifiConnected(network))
        {
            logger.LogInformation("Direct AP startup reconciliation skipped because Wi-Fi is already connected.");
            return;
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);

        if (IsConnectionActive(activeConnections, WifiProfileName))
        {
            logger.LogInformation("Wi-Fi is not connected at startup, but Direct AP Wi-Fi is already active.");
        }
        else
        {
            logger.LogInformation("Wi-Fi is not connected at startup. Enabling Direct AP Wi-Fi.");

            var wifiResult = await SetWifiEnabledAsync(enabled: true, cancellationToken);
            if (!wifiResult.Success)
            {
                logger.LogWarning("Direct AP startup could not enable Wi-Fi. Message={Message}", wifiResult.Message);
            }
        }

        if (IsConnectionActive(activeConnections, BluetoothProfileName))
        {
            logger.LogInformation("Wi-Fi is not connected at startup, but Direct AP Bluetooth is already active.");
        }
        else
        {
            logger.LogInformation("Wi-Fi is not connected at startup. Enabling Direct AP Bluetooth.");

            var bluetoothResult = await SetBluetoothEnabledAsync(enabled: true, cancellationToken);
            if (!bluetoothResult.Success)
            {
                logger.LogWarning("Direct AP startup could not enable Bluetooth. Message={Message}", bluetoothResult.Message);
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
            Wifi = new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = message,
                Ssid = BuildDefaultWifiSsid(Environment.MachineName)
            },
            Bluetooth = new BluetoothDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                DeviceName = bluetooth.Supported ? Environment.MachineName : null,
                RequiresPairing = true,
                StatusMessage = message
            }
        };
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
                StatusMessage = network.StatusMessage ?? "Direct AP Wi-Fi is unavailable on this host.",
                Ssid = BuildDefaultWifiSsid(Environment.MachineName)
            };
        }

        if (string.IsNullOrWhiteSpace(interfaceName))
        {
            return new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = "No Wi-Fi interface is available for Direct AP.",
                Ssid = BuildDefaultWifiSsid(Environment.MachineName)
            };
        }

        return new WifiDirectAccessSnapshot
        {
            Supported = true,
            Enabled = enabled,
            StatusMessage = enabled
                ? string.IsNullOrEmpty(settings.WifiPassword)
                    ? "Direct AP Wi-Fi is on with no password."
                    : "Direct AP Wi-Fi is on with a password."
                : network.WifiPowered == false
                    ? "Turning this on powers the Wi-Fi radio and starts the Raspberry Pi hotspot."
                    : !string.IsNullOrWhiteSpace(currentNetworkName)
                        ? $"Turning this on will disconnect '{currentNetworkName}' and move Wi-Fi onto the Raspberry Pi hotspot."
                        : "Creates a local Wi-Fi hotspot directly on the Raspberry Pi.",
            InterfaceName = interfaceName,
            CurrentNetworkName = currentNetworkName,
            DisconnectsCurrentWifi = !enabled && !string.IsNullOrWhiteSpace(currentNetworkName),
            Ssid = BuildDefaultWifiSsid(Environment.MachineName),
            Addresses = enabled ? GetInterfaceAddresses(interfaceName) : []
        };
    }

    private async Task<BluetoothDirectAccessSnapshot> BuildBluetoothSnapshotAsync(
        BluetoothRuntimeSnapshot bluetooth,
        IReadOnlyList<ActiveConnectionInfo> activeConnections,
        CancellationToken cancellationToken)
    {
        var adapterState = await bluetoothManagementService.GetDirectAccessStateAsync(cancellationToken);
        var enabled = IsConnectionActive(activeConnections, BluetoothProfileName);
        var deviceName = adapterState.Alias ?? Environment.MachineName;

        if (!adapterState.Supported)
        {
            return new BluetoothDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = adapterState.StatusMessage ?? bluetooth.StatusMessage ?? "Direct AP Bluetooth is unavailable on this host.",
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
                ? "Direct AP Bluetooth is on. Pair from your device settings and join the PAN connection."
                : !adapterState.Powered
                    ? "Turning this on powers Bluetooth, makes the Raspberry Pi discoverable, and starts a Bluetooth PAN."
                    : "Keeps the Raspberry Pi reachable over Bluetooth PAN when your phone or laptop supports it.",
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
                "Direct AP could not list active NetworkManager connections. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
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
            BuildDefaultWifiSsid(Environment.MachineName),
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
            WifiPassword = settings.WifiPassword
        };
    }

    private static string BuildWifiEnabledMessage(DirectAccessStore.DirectAccessSettings settings)
    {
        var ssid = BuildDefaultWifiSsid(Environment.MachineName);
        return string.IsNullOrEmpty(settings.WifiPassword)
            ? $"Direct AP Wi-Fi is on. Join '{ssid}' with no password."
            : $"Direct AP Wi-Fi is on. Join '{ssid}' with the configured password.";
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
