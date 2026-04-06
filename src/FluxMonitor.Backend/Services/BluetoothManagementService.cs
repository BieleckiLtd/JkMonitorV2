using System.Collections;
using System.Diagnostics;
using Linux.Bluetooth;
using Linux.Bluetooth.Extensions;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class BluetoothManagementService(ILogger<BluetoothManagementService> logger)
{
    public async Task<BluetoothRuntimeSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new BluetoothRuntimeSnapshot
            {
                Supported = false,
                StatusMessage = "Bluetooth controls are supported on Linux hosts with BlueZ."
            };
        }

        var adapter = await TryGetAdapterAsync();
        if (adapter is null)
        {
            return new BluetoothRuntimeSnapshot
            {
                Supported = false,
                StatusMessage = "No Bluetooth adapter was detected."
            };
        }

        var powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));
        var rfkillState = GetBluetoothRfkillState();
        var devices = await MapDevicesAsync(await adapter.GetDevicesAsync(), cancellationToken);

        return new BluetoothRuntimeSnapshot
        {
            Supported = true,
            StatusMessage = DescribeRfkillBlockState(rfkillState?.SoftBlocked ?? false, rfkillState?.HardBlocked ?? false),
            Powered = powered,
            Devices = devices
        };
    }

    public async Task<BluetoothPowerResult> SetPowerAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new BluetoothPowerResult
            {
                Success = false,
                Powered = false,
                Message = "Bluetooth controls are supported on Linux hosts with BlueZ."
            };
        }

        var adapter = await TryGetAdapterAsync();
        if (adapter is null)
        {
            return new BluetoothPowerResult
            {
                Success = false,
                Powered = false,
                Message = "No Bluetooth adapter was detected."
            };
        }

        try
        {
            if (enabled)
            {
                var rfkillState = GetBluetoothRfkillState();
                if (rfkillState?.HardBlocked == true)
                {
                    return new BluetoothPowerResult
                    {
                        Success = false,
                        Powered = false,
                        Message = DescribeRfkillBlockState(softBlocked: false, hardBlocked: true) ?? "Bluetooth is blocked."
                    };
                }

                if (rfkillState?.SoftBlocked == true)
                {
                    logger.LogInformation("Bluetooth is soft-blocked by rfkill; attempting to clear the block before powering on.");
                    var cleared = await ClearBluetoothSoftBlockAsync(cancellationToken);
                    if (!cleared)
                    {
                        return new BluetoothPowerResult
                        {
                            Success = false,
                            Powered = false,
                            Message = "Bluetooth is soft-blocked by rfkill and could not be cleared automatically."
                        };
                    }
                }
            }

            logger.LogInformation("Setting Bluetooth power state to {Enabled}.", enabled);
            cancellationToken.ThrowIfCancellationRequested();
            await adapter.SetAsync("Powered", enabled);
            var powered = await ObservePowerStateAsync(
                adapter,
                enabled,
                enabled ? TimeSpan.FromSeconds(4) : TimeSpan.FromSeconds(2),
                cancellationToken);

            if (powered == enabled)
            {
                logger.LogInformation("Bluetooth power state changed successfully. Powered={Powered}.", powered);
            }
            else
            {
                if (enabled)
                {
                    powered = await TryRecoverPowerOnAsync(adapter, cancellationToken)
                        ? await ObservePowerStateAsync(adapter, expected: true, timeout: TimeSpan.FromSeconds(2), cancellationToken)
                        : powered;
                }

                if (powered == enabled)
                {
                    logger.LogInformation("Bluetooth power state changed successfully after recovery. Powered={Powered}.", powered);
                }
                else
                {
                    var blockMessage = DescribeRfkillBlockState(
                        GetBluetoothRfkillState()?.SoftBlocked ?? false,
                        GetBluetoothRfkillState()?.HardBlocked ?? false);

                    logger.LogWarning(
                        "Bluetooth power state did not change as requested. Requested={Requested}, Actual={Actual}, BlockState={BlockState}.",
                        enabled,
                        powered,
                        blockMessage ?? "<none>");

                    return new BluetoothPowerResult
                    {
                        Success = false,
                        Powered = powered,
                        Message = blockMessage ?? $"Bluetooth state did not change as requested. Current state: {(powered ? "on" : "off")}."
                    };
                }
            }

            return new BluetoothPowerResult
            {
                Success = true,
                Powered = powered,
                Message = powered == enabled
                    ? enabled ? "Bluetooth turned on." : "Bluetooth turned off."
                    : $"Bluetooth state did not change as requested. Current state: {(powered ? "on" : "off")}."
            };
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            var powered = await ObservePowerStateAsync(
                adapter,
                enabled,
                enabled ? TimeSpan.FromSeconds(4) : TimeSpan.FromSeconds(2),
                cancellationToken);

            if (enabled && !powered && await TryRecoverPowerOnAsync(adapter, cancellationToken))
            {
                powered = await ObservePowerStateAsync(adapter, expected: true, timeout: TimeSpan.FromSeconds(2), cancellationToken);
            }

            if (powered == enabled)
            {
                logger.LogInformation(
                    "Bluetooth power state reached the requested value after transient error. Requested={Requested}, Powered={Powered}, ErrorMessage={ErrorMessage}.",
                    enabled,
                    powered,
                    exception.Message);

                return new BluetoothPowerResult
                {
                    Success = true,
                    Powered = powered,
                    Message = enabled ? "Bluetooth turned on." : "Bluetooth turned off."
                };
            }

            var blockMessage = DescribeRfkillBlockState(
                GetBluetoothRfkillState()?.SoftBlocked ?? false,
                GetBluetoothRfkillState()?.HardBlocked ?? false);

            logger.LogWarning(
                exception,
                "Failed to set Bluetooth power state to {Enabled}: {ErrorMessage}. Current state={Powered}. BlockState={BlockState}.",
                enabled,
                exception.Message,
                powered,
                blockMessage ?? "<none>");

            return new BluetoothPowerResult
            {
                Success = false,
                Powered = powered,
                Message = blockMessage ?? exception.Message
            };
        }
    }

    private async Task<bool> TryRecoverPowerOnAsync(Adapter adapter, CancellationToken cancellationToken)
    {
        var rfkillState = GetBluetoothRfkillState();
        if (rfkillState?.HardBlocked == true)
        {
            logger.LogWarning("Bluetooth is hard-blocked by rfkill; automatic power-on recovery is not possible.");
            return false;
        }

        if (rfkillState?.SoftBlocked == true)
        {
            logger.LogInformation("Bluetooth remained soft-blocked; retrying rfkill clear before fallback power-on.");
            if (!await ClearBluetoothSoftBlockAsync(cancellationToken))
            {
                return false;
            }
        }

        var result = await RunProcessAsync("sudo", ["-n", "btmgmt", "power", "on"], cancellationToken);
        if (!result.Succeeded && !LooksLikeTransientPowerOnResult(result))
        {
            logger.LogWarning(
                "btmgmt power on fallback failed. ExitCode={ExitCode}. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                result.ExitCode,
                result.StandardOutput,
                result.ErrorOutput);
            return false;
        }

        return await ObservePowerStateAsync(adapter, expected: true, timeout: TimeSpan.FromSeconds(4), cancellationToken);
    }

    public async Task<BluetoothScanResult> ScanAsync(TimeSpan? timeout, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new BluetoothScanResult
            {
                Supported = false,
                StatusMessage = "Bluetooth scanning is supported on Linux hosts with BlueZ."
            };
        }

        var adapter = await TryGetAdapterAsync();
        if (adapter is null)
        {
            return new BluetoothScanResult
            {
                Supported = false,
                StatusMessage = "No Bluetooth adapter was detected."
            };
        }

        var powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));
        if (!powered)
        {
            return new BluetoothScanResult
            {
                Supported = true,
                Powered = false,
                StatusMessage = "Bluetooth is powered off."
            };
        }

        var scanDuration = timeout ?? TimeSpan.FromSeconds(6);
        if (scanDuration < TimeSpan.FromSeconds(1))
        {
            scanDuration = TimeSpan.FromSeconds(1);
        }

        var devices = new Dictionary<string, Device>(StringComparer.OrdinalIgnoreCase);

        foreach (var device in await adapter.GetDevicesAsync())
        {
            var key = await GetDeviceKeyAsync(device);
            if (!string.IsNullOrWhiteSpace(key))
            {
                devices[key] = device;
            }
        }

        async Task OnDeviceFoundAsync(Adapter _, DeviceFoundEventArgs args)
        {
            var key = await GetDeviceKeyAsync(args.Device);
            if (!string.IsNullOrWhiteSpace(key))
            {
                devices[key] = args.Device;
            }
        }

        try
        {
            adapter.DeviceFound += OnDeviceFoundAsync;
            try
            {
                logger.LogInformation("Starting Bluetooth discovery for {DurationSeconds} seconds.", scanDuration.TotalSeconds);
                await adapter.StartDiscoveryAsync();
                await Task.Delay(scanDuration, cancellationToken);
            }
            finally
            {
                adapter.DeviceFound -= OnDeviceFoundAsync;
                try
                {
                    await adapter.StopDiscoveryAsync();
                }
                catch
                {
                    // Best effort.
                }
            }
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "Bluetooth discovery failed: {ErrorMessage}", exception.Message);
            return new BluetoothScanResult
            {
                Supported = true,
                Powered = true,
                StatusMessage = exception.Message
            };
        }

        var mappedDevices = await MapDevicesAsync(devices.Values, cancellationToken);
        return new BluetoothScanResult
        {
            Supported = true,
            Powered = true,
            Devices = mappedDevices
        };
    }

    internal async Task<BluetoothAdapterAccessState> GetDirectAccessStateAsync(CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new BluetoothAdapterAccessState(
                Supported: false,
                Powered: false,
                Discoverable: false,
                Pairable: false,
                Alias: null,
                StatusMessage: "Bluetooth direct access is supported on Linux hosts with BlueZ.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        var adapter = await TryGetAdapterAsync();
        if (adapter is null)
        {
            return new BluetoothAdapterAccessState(
                Supported: false,
                Powered: false,
                Discoverable: false,
                Pairable: false,
                Alias: null,
                StatusMessage: "No Bluetooth adapter was detected.");
        }

        var powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));
        var discoverable = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Discoverable"));
        var pairable = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Pairable"));
        var alias = await SafeGetStringAsync(() => adapter.GetAsync<string>("Alias"));

        return new BluetoothAdapterAccessState(
            Supported: true,
            Powered: powered,
            Discoverable: discoverable,
            Pairable: pairable,
            Alias: alias,
            StatusMessage: DescribeRfkillBlockState(
                GetBluetoothRfkillState()?.SoftBlocked ?? false,
                GetBluetoothRfkillState()?.HardBlocked ?? false));
    }

    internal async Task<BluetoothAdapterVisibilityResult> SetDirectAccessVisibilityAsync(
        bool enabled,
        CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new BluetoothAdapterVisibilityResult(
                Success: false,
                Powered: false,
                Discoverable: false,
                Pairable: false,
                Message: "Bluetooth direct access is supported on Linux hosts with BlueZ.");
        }

        var adapter = await TryGetAdapterAsync();
        if (adapter is null)
        {
            return new BluetoothAdapterVisibilityResult(
                Success: false,
                Powered: false,
                Discoverable: false,
                Pairable: false,
                Message: "No Bluetooth adapter was detected.");
        }

        try
        {
            var powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));
            if (!powered)
            {
                return new BluetoothAdapterVisibilityResult(
                    Success: false,
                    Powered: false,
                    Discoverable: false,
                    Pairable: false,
                    Message: "Bluetooth is powered off.");
            }

            if (enabled)
            {
                await TrySetAdapterPropertyAsync(adapter, "DiscoverableTimeout", 0u);
                await TrySetAdapterPropertyAsync(adapter, "PairableTimeout", 0u);
            }

            await adapter.SetAsync("Pairable", enabled);
            await adapter.SetAsync("Discoverable", enabled);

            var state = await GetDirectAccessStateAsync(cancellationToken);
            var success = state.Supported
                && state.Powered
                && state.Discoverable == enabled
                && state.Pairable == enabled;

            return new BluetoothAdapterVisibilityResult(
                Success: success,
                Powered: state.Powered,
                Discoverable: state.Discoverable,
                Pairable: state.Pairable,
                Message: success
                    ? enabled
                        ? "Bluetooth pairing mode is ready."
                        : "Bluetooth pairing mode is off."
                    : enabled
                        ? "Bluetooth could not stay discoverable and pairable."
                        : "Bluetooth pairing mode did not turn off cleanly.");
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(
                exception,
                "Failed to change Bluetooth direct-access visibility. Enabled={Enabled}. ErrorMessage={ErrorMessage}.",
                enabled,
                exception.Message);

            var state = await GetDirectAccessStateAsync(cancellationToken);
            return new BluetoothAdapterVisibilityResult(
                Success: false,
                Powered: state.Powered,
                Discoverable: state.Discoverable,
                Pairable: state.Pairable,
                Message: exception.Message);
        }
    }

    internal async Task SetDirectAccessAliasAsync(string? alias, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux() || string.IsNullOrWhiteSpace(alias))
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        var adapter = await TryGetAdapterAsync();
        if (adapter is null)
        {
            return;
        }

        await TrySetAdapterPropertyAsync(adapter, "Alias", alias.Trim());
    }

    private async Task<Adapter?> TryGetAdapterAsync()
    {
        try
        {
            return (await BlueZManager.GetAdaptersAsync()).FirstOrDefault();
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to enumerate Bluetooth adapters: {ErrorMessage}", exception.Message);
            return null;
        }
    }

    private static BluetoothRfkillState? GetBluetoothRfkillState()
    {
        if (!OperatingSystem.IsLinux())
        {
            return null;
        }

        const string rfkillRoot = "/sys/class/rfkill";
        if (!Directory.Exists(rfkillRoot))
        {
            return null;
        }

        foreach (var directory in Directory.GetDirectories(rfkillRoot, "rfkill*"))
        {
            var type = ReadTrimmedFile(Path.Combine(directory, "type"));
            if (!string.Equals(type, "bluetooth", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return new BluetoothRfkillState(
                ReadTrimmedFile(Path.Combine(directory, "name")) ?? Path.GetFileName(directory),
                SoftBlocked: ReadTrimmedFile(Path.Combine(directory, "soft")) == "1",
                HardBlocked: ReadTrimmedFile(Path.Combine(directory, "hard")) == "1");
        }

        return null;
    }

    internal static string? DescribeRfkillBlockState(bool softBlocked, bool hardBlocked)
    {
        if (hardBlocked)
        {
            return "Bluetooth is hard-blocked by rfkill.";
        }

        if (softBlocked)
        {
            return "Bluetooth is soft-blocked by rfkill.";
        }

        return null;
    }

    private async Task<bool> ClearBluetoothSoftBlockAsync(CancellationToken cancellationToken)
    {
        var result = await RunProcessAsync(
            "sudo",
            [
                "-n",
                "python3",
                "-c",
                """
import pathlib

for path in pathlib.Path('/sys/class/rfkill').glob('rfkill*'):
    type_file = path / 'type'
    if not type_file.exists() or type_file.read_text().strip() != 'bluetooth':
        continue
    soft_file = path / 'soft'
    if soft_file.exists():
        soft_file.write_text('0\n')

persist_root = pathlib.Path('/var/lib/systemd/rfkill')
if persist_root.exists():
    for file in persist_root.iterdir():
        if 'bluetooth' in file.name:
            file.write_text('0\n')
"""
            ],
            cancellationToken);

        if (!result.Succeeded)
        {
            logger.LogWarning(
                "Failed to clear Bluetooth rfkill soft block. ExitCode={ExitCode}. StdOut={StandardOutput}. StdErr={ErrorOutput}.",
                result.ExitCode,
                result.StandardOutput,
                result.ErrorOutput);
            return false;
        }

        var remainingState = GetBluetoothRfkillState();
        var cleared = remainingState?.SoftBlocked != true;
        if (cleared)
        {
            logger.LogInformation("Bluetooth rfkill soft block cleared successfully.");
        }
        else
        {
            logger.LogWarning("Bluetooth rfkill soft block remained set after the clear attempt.");
        }

        return cleared;
    }

    private static async Task<bool> ObservePowerStateAsync(
        Adapter adapter,
        bool expected,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));
        if (powered == expected)
        {
            return powered;
        }

        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(250), cancellationToken);
            powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));
            if (powered == expected)
            {
                return powered;
            }
        }

        return powered;
    }

    private static bool LooksLikeTransientPowerOnResult(ProcessResult result)
    {
        var combined = $"{result.StandardOutput}\n{result.ErrorOutput}";
        return combined.Contains("Busy", StringComparison.OrdinalIgnoreCase)
            || combined.Contains("0x0a", StringComparison.OrdinalIgnoreCase);
    }

    private static string? ReadTrimmedFile(string path)
    {
        try
        {
            return File.Exists(path)
                ? File.ReadAllText(path).Trim()
                : null;
        }
        catch
        {
            return null;
        }
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

            return new ProcessResult(
                process.ExitCode == 0,
                await standardOutputTask,
                await standardErrorTask,
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

    private static async Task<IReadOnlyList<BluetoothDeviceSnapshot>> MapDevicesAsync(IEnumerable<Device> devices, CancellationToken cancellationToken)
    {
        var mappedDevices = new List<BluetoothDeviceSnapshot>();
        foreach (var device in devices)
        {
            cancellationToken.ThrowIfCancellationRequested();
            mappedDevices.Add(await MapDeviceAsync(device));
        }

        return mappedDevices
            .OrderByDescending(device => device.IsConnected)
            .ThenByDescending(device => device.IsPaired)
            .ThenByDescending(device => device.Rssi ?? int.MinValue)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(device => device.Address, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static async Task<BluetoothDeviceSnapshot> MapDeviceAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync()) ?? string.Empty;
        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        var name = await SafeGetStringAsync(() => device.GetNameAsync());
        var isConnected = await SafeGetValueAsync(() => device.GetAsync<bool>("Connected"));
        var isPaired = await SafeGetValueAsync(() => device.GetAsync<bool>("Paired"));
        var rssi = ConvertToNullableInt(await SafeGetObjectAsync(() => device.GetRSSIAsync()));
        var advertisedServiceUuids = DescribeStringSequence(await SafeGetObjectAsync(() => device.GetUUIDsAsync()));

        var displayName = alias;
        if (string.IsNullOrWhiteSpace(displayName))
        {
            displayName = name;
        }

        if (string.IsNullOrWhiteSpace(displayName))
        {
            displayName = address;
        }

        return new BluetoothDeviceSnapshot
        {
            Address = address,
            Alias = alias,
            Name = name,
            DisplayName = displayName ?? "Unknown Bluetooth device",
            IsConnected = isConnected,
            IsPaired = isPaired,
            Rssi = rssi,
            AdvertisedServiceUuids = advertisedServiceUuids
        };
    }

    private static async Task<string?> GetDeviceKeyAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync());
        if (!string.IsNullOrWhiteSpace(address))
        {
            return address;
        }

        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        if (!string.IsNullOrWhiteSpace(alias))
        {
            return alias;
        }

        return await SafeGetStringAsync(() => device.GetNameAsync());
    }

    private static async Task<string?> SafeGetStringAsync(Func<Task<string>> getter)
    {
        try
        {
            var value = await getter();
            return string.IsNullOrWhiteSpace(value) ? null : value.Trim();
        }
        catch
        {
            return null;
        }
    }

    private async Task TrySetAdapterPropertyAsync(Adapter adapter, string propertyName, object value)
    {
        try
        {
            await adapter.SetAsync(propertyName, value);
        }
        catch (Exception exception)
        {
            logger.LogDebug(
                exception,
                "Bluetooth adapter property update failed. Property={PropertyName}. ErrorMessage={ErrorMessage}.",
                propertyName,
                exception.Message);
        }
    }

    private static async Task<bool> SafeGetValueAsync(Func<Task<bool>> getter)
    {
        try
        {
            return await getter();
        }
        catch
        {
            return false;
        }
    }

    private static async Task<object?> SafeGetObjectAsync<T>(Func<Task<T>> getter)
    {
        try
        {
            return await getter();
        }
        catch
        {
            return null;
        }
    }

    private static int? ConvertToNullableInt(object? value)
    {
        if (value is null)
        {
            return null;
        }

        try
        {
            return Convert.ToInt32(value);
        }
        catch
        {
            return null;
        }
    }

    private static string[] DescribeStringSequence(object? value)
    {
        if (value is not IEnumerable enumerable)
        {
            return [];
        }

        return enumerable
            .Cast<object?>()
            .Select(item => item?.ToString()?.Trim())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private sealed record BluetoothRfkillState(string Name, bool SoftBlocked, bool HardBlocked);

    private sealed record ProcessResult(
        bool Succeeded,
        string StandardOutput,
        string ErrorOutput,
        int? ExitCode);

    internal sealed record BluetoothAdapterAccessState(
        bool Supported,
        bool Powered,
        bool Discoverable,
        bool Pairable,
        string? Alias,
        string? StatusMessage);

    internal sealed record BluetoothAdapterVisibilityResult(
        bool Success,
        bool Powered,
        bool Discoverable,
        bool Pairable,
        string Message);
}
