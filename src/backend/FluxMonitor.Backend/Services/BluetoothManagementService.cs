using System.Collections;
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
        var devices = await MapDevicesAsync(await adapter.GetDevicesAsync(), cancellationToken);

        return new BluetoothRuntimeSnapshot
        {
            Supported = true,
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
            cancellationToken.ThrowIfCancellationRequested();
            await adapter.SetAsync("Powered", enabled);
            var powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered"));

            return new BluetoothPowerResult
            {
                Success = powered == enabled,
                Powered = powered,
                Message = powered == enabled
                    ? enabled ? "Bluetooth turned on." : "Bluetooth turned off."
                    : $"Bluetooth state did not change as requested. Current state: {(powered ? "on" : "off")}."
            };
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(exception, "Failed to set Bluetooth power state to {Enabled}.", enabled);
            return new BluetoothPowerResult
            {
                Success = false,
                Powered = await SafeGetValueAsync(() => adapter.GetAsync<bool>("Powered")),
                Message = exception.Message
            };
        }
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

        adapter.DeviceFound += OnDeviceFoundAsync;
        try
        {
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

        var mappedDevices = await MapDevicesAsync(devices.Values, cancellationToken);
        return new BluetoothScanResult
        {
            Supported = true,
            Powered = true,
            Devices = mappedDevices
        };
    }

    private static async Task<Adapter?> TryGetAdapterAsync()
    {
        try
        {
            return (await BlueZManager.GetAdaptersAsync()).FirstOrDefault();
        }
        catch
        {
            return null;
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
}
