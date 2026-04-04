using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class DirectAccessService(
    ICommandRunner commandRunner,
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

    public async Task<DirectAccessSnapshot> GetSnapshotAsync(
        NetworkConnectivitySnapshot network,
        BluetoothRuntimeSnapshot bluetooth,
        CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return BuildUnsupportedSnapshot("Direct access is supported on Linux hosts with NetworkManager.", bluetooth);
        }

        var toolCheck = await RunNmcliAsync(["--version"], cancellationToken);
        if (!toolCheck.Succeeded)
        {
            logger.LogDebug(
                "Direct access snapshot could not check nmcli availability. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                toolCheck.StandardOutput,
                toolCheck.ErrorOutput);
            return BuildUnsupportedSnapshot("NetworkManager command-line tools are not available on this host.", bluetooth);
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        var wifiTask = BuildWifiSnapshotAsync(network, activeConnections, cancellationToken);
        var bluetoothTask = BuildBluetoothSnapshotAsync(bluetooth, activeConnections, cancellationToken);

        await Task.WhenAll(wifiTask, bluetoothTask);

        return new DirectAccessSnapshot
        {
            Wifi = await wifiTask,
            Bluetooth = await bluetoothTask
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
                Message = "Direct Wi-Fi is supported on Linux hosts with NetworkManager."
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
                Message = "No Wi-Fi interface is available for direct access."
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

            var settings = await GetWifiProfileSettingsAsync(cancellationToken);
            var profileExists = await ConnectionProfileExistsAsync(WifiProfileName, cancellationToken);
            var result = profileExists
                ? await RunNmcliAsync(["connection", "up", "id", WifiProfileName, "ifname", interfaceName], cancellationToken)
                : await RunNmcliAsync(
                    [
                        "device",
                        "wifi",
                        "hotspot",
                        "ifname",
                        interfaceName,
                        "con-name",
                        WifiProfileName,
                        "ssid",
                        settings.Ssid,
                        "password",
                        settings.Password
                    ],
                    cancellationToken);

            if (!result.Succeeded)
            {
                return new DirectAccessCommandResult
                {
                    Success = false,
                    Enabled = false,
                    Message = BuildCommandFailureMessage(result, "Direct Wi-Fi could not be turned on.")
                };
            }

            await TrySetConnectionAutoconnectAsync(WifiProfileName, enabled: false, cancellationToken);

            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = true,
                Message = $"Direct Wi-Fi is on. Join '{settings.Ssid}' to reach this Raspberry Pi without the home router."
            };
        }

        var activeConnections = await GetActiveConnectionsAsync(cancellationToken);
        if (!IsConnectionActive(activeConnections, WifiProfileName))
        {
            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = false,
                Message = "Direct Wi-Fi is already off."
            };
        }

        var downResult = await RunNmcliAsync(["connection", "down", "id", WifiProfileName], cancellationToken);
        if (!downResult.Succeeded)
        {
            return new DirectAccessCommandResult
            {
                Success = false,
                Enabled = true,
                Message = BuildCommandFailureMessage(downResult, "Direct Wi-Fi could not be turned off.")
            };
        }

        return new DirectAccessCommandResult
        {
            Success = true,
            Enabled = false,
            Message = "Direct Wi-Fi is off."
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
                Message = "Direct Bluetooth access is supported on Linux hosts with BlueZ and NetworkManager."
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
                Message = bluetoothState.StatusMessage ?? "No Bluetooth adapter is available for direct access."
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

            var profileExists = await ConnectionProfileExistsAsync(BluetoothProfileName, cancellationToken);
            if (!profileExists)
            {
                var addResult = await RunNmcliAsync(
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

                if (!addResult.Succeeded)
                {
                    return new DirectAccessCommandResult
                    {
                        Success = false,
                        Enabled = false,
                        Message = BuildCommandFailureMessage(addResult, "Bluetooth direct mode could not be created.")
                    };
                }
            }

            await TrySetConnectionAutoconnectAsync(BluetoothProfileName, enabled: false, cancellationToken);

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
                    Message = BuildCommandFailureMessage(upResult, "Bluetooth direct mode could not be turned on.")
                };
            }

            var adapterState = await bluetoothManagementService.GetDirectAccessStateAsync(cancellationToken);
            return new DirectAccessCommandResult
            {
                Success = true,
                Enabled = true,
                Message = $"Bluetooth direct mode is on. Pair with '{adapterState.Alias ?? Environment.MachineName}' and join the PAN connection to reach this Raspberry Pi."
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
                Message = BuildCommandFailureMessage(downResult, "Bluetooth direct mode could not be turned off.")
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
            Message = "Bluetooth direct mode is off."
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

    internal static string BuildDefaultWifiPassword(string stableIdentity)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"FluxMonitorDirectWifi::{stableIdentity}"));
        return $"Flux{Convert.ToHexString(hash)[..12]}";
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

    private static DirectAccessSnapshot BuildUnsupportedSnapshot(string message, BluetoothRuntimeSnapshot bluetooth)
    {
        return new DirectAccessSnapshot
        {
            Wifi = new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = message
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
        CancellationToken cancellationToken)
    {
        var interfaceName = ResolveWifiInterfaceName(network);
        var enabled = IsConnectionActive(activeConnections, WifiProfileName);
        var currentWifi = network.WifiInterfaces.FirstOrDefault(wifiInterface => !string.IsNullOrWhiteSpace(wifiInterface.ConnectedSsid));
        var currentNetworkName = enabled ? null : currentWifi?.ConnectedSsid;
        var settings = await GetWifiProfileSettingsAsync(cancellationToken);

        if (!network.Supported)
        {
            return new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = network.StatusMessage ?? "Wi-Fi direct access is unavailable on this host.",
                Ssid = settings.Ssid,
                Password = settings.Password
            };
        }

        if (string.IsNullOrWhiteSpace(interfaceName))
        {
            return new WifiDirectAccessSnapshot
            {
                Supported = false,
                Enabled = false,
                StatusMessage = "No Wi-Fi interface is available for direct access.",
                Ssid = settings.Ssid,
                Password = settings.Password
            };
        }

        return new WifiDirectAccessSnapshot
        {
            Supported = true,
            Enabled = enabled,
            StatusMessage = enabled
                ? "Direct Wi-Fi is on. Devices can join the Raspberry Pi directly over its hotspot."
                : network.WifiPowered == false
                    ? "Turning this on powers the Wi-Fi radio and starts a dedicated hotspot on the Raspberry Pi."
                    : !string.IsNullOrWhiteSpace(currentNetworkName)
                        ? $"Turning this on will disconnect '{currentNetworkName}' and move the Raspberry Pi onto its own hotspot."
                        : "Creates a local Wi-Fi hotspot directly on the Raspberry Pi.",
            InterfaceName = interfaceName,
            CurrentNetworkName = currentNetworkName,
            DisconnectsCurrentWifi = !enabled && !string.IsNullOrWhiteSpace(currentNetworkName),
            Ssid = settings.Ssid,
            Password = settings.Password,
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
                StatusMessage = adapterState.StatusMessage ?? bluetooth.StatusMessage ?? "Bluetooth direct access is unavailable on this host.",
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
                ? "Bluetooth direct mode is on. Pair from your device settings and join the PAN connection."
                : !adapterState.Powered
                    ? "Turning this on powers Bluetooth, makes the Raspberry Pi discoverable, and starts a Bluetooth PAN."
                    : "Keeps the Raspberry Pi on its current network while nearby devices connect over Bluetooth PAN. Your phone or laptop must support Bluetooth PAN.",
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
                "Direct access could not list active NetworkManager connections. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
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

    private async Task<bool> ConnectionProfileExistsAsync(string profileName, CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(["--terse", "--fields", "NAME", "connection", "show"], cancellationToken);
        if (!result.Succeeded)
        {
            return false;
        }

        return result.StandardOutput
            .Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Any(name => string.Equals(name, profileName, StringComparison.OrdinalIgnoreCase));
    }

    private async Task<WifiProfileSettings> GetWifiProfileSettingsAsync(CancellationToken cancellationToken)
    {
        var fallback = BuildDefaultWifiProfileSettings();
        var result = await RunNmcliAsync(
            ["--show-secrets", "--get-values", "802-11-wireless.ssid,802-11-wireless-security.psk", "connection", "show", WifiProfileName],
            cancellationToken);

        if (!result.Succeeded)
        {
            return fallback;
        }

        var values = result.StandardOutput
            .Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.TrimEntries);

        return new WifiProfileSettings(
            Ssid: string.IsNullOrWhiteSpace(values.ElementAtOrDefault(0)) ? fallback.Ssid : values[0].Trim(),
            Password: string.IsNullOrWhiteSpace(values.ElementAtOrDefault(1)) ? fallback.Password : values[1].Trim());
    }

    private static WifiProfileSettings BuildDefaultWifiProfileSettings()
    {
        var stableIdentity = ReadStableDeviceIdentity();
        return new WifiProfileSettings(
            Ssid: BuildDefaultWifiSsid(Environment.MachineName),
            Password: BuildDefaultWifiPassword(stableIdentity));
    }

    private static string ReadStableDeviceIdentity()
    {
        foreach (var path in new[] { "/etc/machine-id", "/var/lib/dbus/machine-id" })
        {
            if (!File.Exists(path))
            {
                continue;
            }

            var value = File.ReadAllText(path).Trim();
            if (!string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        var macAddress = NetworkInterface.GetAllNetworkInterfaces()
            .Select(networkInterface => networkInterface.GetPhysicalAddress()?.ToString())
            .FirstOrDefault(address => !string.IsNullOrWhiteSpace(address));

        return string.IsNullOrWhiteSpace(macAddress)
            ? Environment.MachineName
            : macAddress;
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

    private async Task TrySetConnectionAutoconnectAsync(string profileName, bool enabled, CancellationToken cancellationToken)
    {
        var result = await RunNmcliAsync(
            ["connection", "modify", profileName, "connection.autoconnect", enabled ? "yes" : "no"],
            cancellationToken);

        if (!result.Succeeded)
        {
            logger.LogDebug(
                "Direct access profile autoconnect update failed. Profile={ProfileName}. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                profileName,
                result.StandardOutput,
                result.ErrorOutput);
        }
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

    private sealed record WifiProfileSettings(string Ssid, string Password);
}
