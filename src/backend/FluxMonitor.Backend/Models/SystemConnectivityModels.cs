namespace FluxMonitor.Backend.Models;

public sealed record class SystemConnectivitySnapshot
{
    public required NetworkConnectivitySnapshot Network { get; init; }

    public required BluetoothRuntimeSnapshot Bluetooth { get; init; }
}

public sealed record class NetworkConnectivitySnapshot
{
    public bool Supported { get; init; }

    public string? StatusMessage { get; init; }

    public bool? WifiPowered { get; init; }

    public bool? HasInternetAccess { get; init; }

    public IReadOnlyList<EthernetInterfaceSnapshot> EthernetInterfaces { get; init; } = [];

    public IReadOnlyList<WifiInterfaceSnapshot> WifiInterfaces { get; init; } = [];
}

public sealed record class EthernetInterfaceSnapshot
{
    public required string Name { get; init; }

    public string? Description { get; init; }

    public string? Status { get; init; }

    public string? MacAddress { get; init; }

    public IReadOnlyList<string> Addresses { get; init; } = [];

    public long? SpeedMbps { get; init; }

    public string? ConnectionName { get; init; }

    public string? ConnectionState { get; init; }
}

public sealed record class WifiInterfaceSnapshot
{
    public required string Name { get; init; }

    public string? Description { get; init; }

    public string? Status { get; init; }

    public string? MacAddress { get; init; }

    public IReadOnlyList<string> Addresses { get; init; } = [];

    public long? SpeedMbps { get; init; }

    public string? ConnectionName { get; init; }

    public string? ConnectionState { get; init; }

    public string? ConnectedSsid { get; init; }

    public string? ConnectedBssid { get; init; }

    public int? SignalPercent { get; init; }

    public string? Security { get; init; }

    public string? SignalBars { get; init; }
}

public sealed record class WifiAccessPointInfo
{
    public required string InterfaceName { get; init; }

    public required string Ssid { get; init; }

    public string? Bssid { get; init; }

    public int? SignalPercent { get; init; }

    public string? Security { get; init; }

    public string? SignalBars { get; init; }

    public bool IsActive { get; init; }
}

public sealed record class WifiScanResult
{
    public bool Supported { get; init; }

    public string? StatusMessage { get; init; }

    public IReadOnlyList<WifiAccessPointInfo> AccessPoints { get; init; } = [];
}

public sealed record class WifiConnectResult
{
    public bool Success { get; init; }

    public required string Message { get; init; }
}

public sealed record class WifiPowerResult
{
    public bool Success { get; init; }

    public bool Powered { get; init; }

    public required string Message { get; init; }
}

public sealed record class EthernetDisconnectResult
{
    public bool Success { get; init; }

    public required string InterfaceName { get; init; }

    public required string Message { get; init; }
}

public sealed record class BluetoothRuntimeSnapshot
{
    public bool Supported { get; init; }

    public string? StatusMessage { get; init; }

    public bool Powered { get; init; }

    public IReadOnlyList<BluetoothDeviceSnapshot> Devices { get; init; } = [];
}

public sealed record class BluetoothScanResult
{
    public bool Supported { get; init; }

    public string? StatusMessage { get; init; }

    public bool Powered { get; init; }

    public IReadOnlyList<BluetoothDeviceSnapshot> Devices { get; init; } = [];
}

public sealed record class BluetoothPowerResult
{
    public bool Success { get; init; }

    public bool Powered { get; init; }

    public required string Message { get; init; }
}

public sealed record class BluetoothDeviceSnapshot
{
    public required string Address { get; init; }

    public string? Alias { get; init; }

    public string? Name { get; init; }

    public required string DisplayName { get; init; }

    public bool IsConnected { get; init; }

    public bool IsPaired { get; init; }

    public int? Rssi { get; init; }

    public IReadOnlyList<string> AdvertisedServiceUuids { get; init; } = [];
}
