using System.Collections;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using Linux.Bluetooth;
using Linux.Bluetooth.Extensions;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Definition-driven BLE advertisement client for passive broadcaster devices.
/// Polling reads the most recent matching advertisement payload captured from an
/// active BlueZ discovery session and then feeds it through the standard
/// definition-driven telemetry builder.
/// </summary>
public sealed class GenericBleAdvertisementPollingClient(
    DefinitionDrivenTelemetryBuilder telemetryBuilder,
    ILogger<GenericBleAdvertisementPollingClient> logger) : IDevicePollingClient, IDisposable
{
    private readonly SemaphoreSlim _scannerLock = new(1, 1);
    private readonly object _cacheGate = new();
    private readonly Dictionary<string, AdvertisementDeviceSnapshot> _snapshots = new(StringComparer.OrdinalIgnoreCase);
    private Adapter? _adapter;
    private DeviceChangeEventHandlerAsync? _deviceFoundHandler;
    private bool _disposed;

    public static bool IsDefinitionSupported(DeviceDefinition definition)
        => GetUnsupportedDefinitionMessage(definition) is null;

    public static string? GetUnsupportedDefinitionMessage(DeviceDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);

        if (!string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
            return $"Transport type '{definition.Connection.Transport.Type}' is not supported by the BLE advertisement client.";

        if (!string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase))
            return $"Protocol type '{definition.Connection.Protocol.Type}' is not supported by the BLE advertisement client.";

        if (definition.DataSources.Count == 0)
            return "At least one data source must be defined.";

        var advertisement = definition.Connection.Protocol.Settings?.Advertisement;
        if (advertisement is null)
            return "BLE advertisement settings are required.";

        if (!string.Equals(advertisement.PayloadSource, "manufacturer-data", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(advertisement.PayloadSource, "service-data", StringComparison.OrdinalIgnoreCase))
        {
            return $"BLE advertisement payloadSource '{advertisement.PayloadSource}' is not supported.";
        }

        if (string.Equals(advertisement.PayloadSource, "manufacturer-data", StringComparison.OrdinalIgnoreCase) &&
            !advertisement.ManufacturerId.HasValue)
        {
            return "BLE advertisement manufacturerId is required for manufacturer-data payloads.";
        }

        if (string.Equals(advertisement.PayloadSource, "service-data", StringComparison.OrdinalIgnoreCase) &&
            string.IsNullOrWhiteSpace(advertisement.ServiceDataUuid))
        {
            return "BLE advertisement serviceDataUuid is required for service-data payloads.";
        }

        return null;
    }

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
        => throw new NotSupportedException("Advertisement polling requires the resolved device definition.");

    public async Task<DevicePollResult> PollAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("BLE advertisement polling is supported on Linux/BlueZ only.");

        var unsupportedReason = GetUnsupportedDefinitionMessage(definition);
        if (unsupportedReason is not null)
        {
            throw new NotSupportedException(
                $"BLE advertisement definition '{definition.Device.Id}' is not supported for device '{device.DeviceId}': {unsupportedReason}");
        }

        var identifier = device.TransportPortName?.Trim();
        if (string.IsNullOrWhiteSpace(identifier))
            throw new InvalidOperationException($"Device '{device.DeviceId}' has no BLE address or alias configured.");

        await EnsureScannerRunningAsync(cancellationToken);

        var advertisement = definition.Connection.Protocol.Settings!.Advertisement!;

        // For passive broadcast devices we use a relaxed model: return the latest
        // cached advertisement immediately if one exists.  Only on the very first
        // poll (when the cache is empty) do we wait up to scanWindowMs for an
        // initial advertisement to arrive.  This avoids timeout errors for devices
        // that broadcast intermittently — the orchestrator's poll interval controls
        // how often data is recorded, not how quickly the device must respond.
        if (TryResolveLatestPayload(identifier, definition, out var immediateSnapshot))
        {
            return BuildResultFromPayload(immediateSnapshot, definition);
        }

        // First poll — wait for the initial advertisement.
        var scanWindow = TimeSpan.FromMilliseconds(Math.Max(advertisement.ScanWindowMs, 1000));
        var startedAt = DateTimeOffset.UtcNow;

        while (!cancellationToken.IsCancellationRequested)
        {
            if (TryResolveLatestPayload(identifier, definition, out var payloadSnapshot))
            {
                return BuildResultFromPayload(payloadSnapshot, definition);
            }

            if (DateTimeOffset.UtcNow - startedAt >= scanWindow)
            {
                throw new TimeoutException(
                    $"No BLE advertisement received from '{identifier}' for definition '{definition.Device.Id}'. " +
                    "The device may be out of range or powered off.");
            }

            await Task.Delay(200, cancellationToken);
        }

        throw new OperationCanceledException(cancellationToken);
    }

    private DevicePollResult BuildResultFromPayload(AdvertisementPayloadSnapshot payloadSnapshot, DeviceDefinition definition)
    {
        var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        foreach (var bank in definition.DataSources)
        {
            var buffer = payloadSnapshot.Payload.ToArray();
            if (bank.ResponseLayout is not null)
                buffer = ResponseLayoutNormalizer.Normalize(buffer, bank.ResponseLayout);

            bankData[bank.Id] = buffer;
        }

        return telemetryBuilder.BuildPollResult(
            definition,
            bankData,
            DateTimeOffset.UtcNow,
            Convert.ToHexString(payloadSnapshot.Payload));
    }

    public async Task<IReadOnlyList<BleDiscoveredDevice>> DiscoverDevicesAsync(
        DeviceDefinition? definition,
        TimeSpan? timeout,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("BLE discovery is supported on Linux/BlueZ only.");

        await EnsureScannerRunningAsync(cancellationToken);

        var window = timeout ?? TimeSpan.FromSeconds(6);
        if (window > TimeSpan.Zero)
            await Task.Delay(window, cancellationToken);

        List<AdvertisementDeviceSnapshot> snapshots;
        lock (_cacheGate)
        {
            snapshots = _snapshots.Values.ToList();
        }

        return snapshots
            .Select(snapshot => MapDiscoveredDevice(snapshot, definition))
            .OrderByDescending(device => device.IsDefinitionVerified)
            .ThenByDescending(device => device.IsConnected)
            .ThenByDescending(device => device.Rssi ?? int.MinValue)
            .ThenBy(device => string.IsNullOrWhiteSpace(device.DisplayName) ? 1 : 0)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(device => device.Address, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private async Task EnsureScannerRunningAsync(CancellationToken cancellationToken)
    {
        if (_adapter is not null)
            return;

        await _scannerLock.WaitAsync(cancellationToken);
        try
        {
            if (_adapter is not null)
                return;

            var adapter = (await BlueZManager.GetAdaptersAsync()).FirstOrDefault()
                ?? throw new InvalidOperationException("No Bluetooth adapter was found.");

            if (!await adapter.GetAsync<bool>("Powered"))
                await adapter.SetAsync("Powered", true);

            foreach (var device in await adapter.GetDevicesAsync())
                await CaptureSnapshotAsync(device);

            _deviceFoundHandler = async (_, args) => await CaptureSnapshotAsync(args.Device);
            adapter.DeviceFound += _deviceFoundHandler;

            try
            {
                await adapter.StartDiscoveryAsync();
            }
            catch (Exception exception)
            {
                logger.LogDebug(exception, "BLE advertisement discovery was already active.");
            }

            _adapter = adapter;
        }
        finally
        {
            _scannerLock.Release();
        }
    }

    private bool TryResolvePayload(
        string identifier,
        DeviceDefinition definition,
        TimeSpan freshness,
        out AdvertisementPayloadSnapshot payload)
    {
        lock (_cacheGate)
        {
            var candidate = _snapshots.Values
                .Where(snapshot =>
                    GenericBlePollingClient.IdentifierMatches(identifier, snapshot.Address, snapshot.Alias, snapshot.Name))
                .OrderByDescending(snapshot => snapshot.LastSeen)
                .FirstOrDefault();

            if (candidate is null ||
                DateTimeOffset.UtcNow - candidate.LastSeen > freshness ||
                !TryExtractPayload(candidate, definition, out payload))
            {
                payload = default;
                return false;
            }

            return true;
        }
    }

    /// <summary>
    /// Returns the latest matching payload regardless of age. Used for passive
    /// broadcast devices where event-driven data is returned whenever available.
    /// </summary>
    private bool TryResolveLatestPayload(
        string identifier,
        DeviceDefinition definition,
        out AdvertisementPayloadSnapshot payload)
    {
        lock (_cacheGate)
        {
            var candidate = _snapshots.Values
                .Where(snapshot =>
                    GenericBlePollingClient.IdentifierMatches(identifier, snapshot.Address, snapshot.Alias, snapshot.Name))
                .OrderByDescending(snapshot => snapshot.LastSeen)
                .FirstOrDefault();

            if (candidate is null || !TryExtractPayload(candidate, definition, out payload))
            {
                payload = default;
                return false;
            }

            return true;
        }
    }

    private static BleDiscoveredDevice MapDiscoveredDevice(
        AdvertisementDeviceSnapshot snapshot,
        DeviceDefinition? definition)
    {
        var verified = definition is not null && IsDefinitionSupported(definition) && MatchesDefinition(snapshot, definition);
        var details = verified
            ? BuildVerificationDetails(snapshot, definition!)
            : null;

        return new BleDiscoveredDevice(
            snapshot.Address,
            snapshot.Alias,
            snapshot.Name,
            snapshot.DisplayName,
            snapshot.IsConnected,
            snapshot.IsPaired,
            snapshot.Rssi,
            snapshot.ManufacturerDataDescriptions,
            snapshot.AdvertisedServiceUuids,
            verified,
            verified ? "Advertisement match" : null,
            details);
    }

    private static bool MatchesDefinition(AdvertisementDeviceSnapshot snapshot, DeviceDefinition definition)
    {
        var advertisement = definition.Connection.Protocol.Settings?.Advertisement;
        if (advertisement is null)
            return false;

        var normalizedServiceDataUuid = NormalizeUuid(advertisement.ServiceDataUuid);
        var payloadMatches = string.Equals(advertisement.PayloadSource, "manufacturer-data", StringComparison.OrdinalIgnoreCase)
            ? advertisement.ManufacturerId.HasValue && snapshot.ManufacturerData.ContainsKey(advertisement.ManufacturerId.Value)
            : normalizedServiceDataUuid is not null && snapshot.ServiceData.ContainsKey(normalizedServiceDataUuid);

        if (!payloadMatches)
            return false;

        if (string.IsNullOrWhiteSpace(advertisement.LocalNamePrefix))
            return true;

        return (snapshot.Alias?.StartsWith(advertisement.LocalNamePrefix, StringComparison.OrdinalIgnoreCase) ?? false)
            || (snapshot.Name?.StartsWith(advertisement.LocalNamePrefix, StringComparison.OrdinalIgnoreCase) ?? false)
            || snapshot.DisplayName.StartsWith(advertisement.LocalNamePrefix, StringComparison.OrdinalIgnoreCase);
    }

    private static string? BuildVerificationDetails(AdvertisementDeviceSnapshot snapshot, DeviceDefinition definition)
    {
        var advertisement = definition.Connection.Protocol.Settings?.Advertisement;
        if (advertisement is null)
            return null;

        if (string.Equals(advertisement.PayloadSource, "manufacturer-data", StringComparison.OrdinalIgnoreCase) &&
            advertisement.ManufacturerId.HasValue)
        {
            return $"Manufacturer data 0x{advertisement.ManufacturerId.Value:X4} matched the expected advertisement payload.";
        }

        if (!string.IsNullOrWhiteSpace(advertisement.ServiceDataUuid))
            return $"Service data {NormalizeUuid(advertisement.ServiceDataUuid)} matched the expected advertisement payload.";

        return "Advertisement payload matched the selected device definition.";
    }

    private static bool TryExtractPayload(
        AdvertisementDeviceSnapshot snapshot,
        DeviceDefinition definition,
        out AdvertisementPayloadSnapshot payload)
    {
        var advertisement = definition.Connection.Protocol.Settings?.Advertisement;
        if (advertisement is null)
        {
            payload = default;
            return false;
        }

        byte[]? rawPayload;
        if (string.Equals(advertisement.PayloadSource, "manufacturer-data", StringComparison.OrdinalIgnoreCase))
        {
            rawPayload = advertisement.ManufacturerId.HasValue &&
                         snapshot.ManufacturerData.TryGetValue(advertisement.ManufacturerId.Value, out var data)
                ? data
                : null;
        }
        else
        {
            var serviceDataUuid = advertisement.ServiceDataUuid;
            if (string.IsNullOrWhiteSpace(serviceDataUuid))
            {
                payload = default;
                return false;
            }

            var uuid = NormalizeUuid(serviceDataUuid);
            rawPayload = uuid is not null && snapshot.ServiceData.TryGetValue(uuid, out var data)
                ? data
                : null;
        }

        if (rawPayload is null)
        {
            payload = default;
            return false;
        }

        var offset = Math.Clamp(advertisement.PayloadOffset, 0, rawPayload.Length);
        var remaining = rawPayload.Length - offset;
        var length = advertisement.PayloadLength > 0
            ? Math.Min(advertisement.PayloadLength, remaining)
            : remaining;
        if (length <= 0)
        {
            payload = default;
            return false;
        }

        payload = new AdvertisementPayloadSnapshot(
            rawPayload.Skip(offset).Take(length).ToArray(),
            snapshot.LastSeen);
        return true;
    }

    private async Task CaptureSnapshotAsync(Device device)
    {
        var snapshot = await BuildSnapshotAsync(device);
        if (string.IsNullOrWhiteSpace(snapshot.Address))
            return;

        lock (_cacheGate)
        {
            _snapshots[snapshot.Address] = snapshot;
        }
    }

    private static async Task<AdvertisementDeviceSnapshot> BuildSnapshotAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync()) ?? string.Empty;
        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        var name = await SafeGetStringAsync(() => device.GetNameAsync());
        var isConnected = await SafeGetValueAsync(() => device.GetAsync<bool>("Connected"));
        var isPaired = await SafeGetValueAsync(() => device.GetAsync<bool>("Paired"));
        var rssi = ConvertToNullableInt(await SafeGetObjectAsync(() => device.GetRSSIAsync()));
        var manufacturerData = ExtractKeyedPayloads(await SafeGetObjectAsync(() => device.GetManufacturerDataAsync()));
        var serviceData = ExtractServicePayloads(await SafeGetObjectAsync(() => device.GetServiceDataAsync()));
        var advertisedServiceUuids = DescribeStringSequence(await SafeGetObjectAsync(() => device.GetUUIDsAsync()));

        var displayName = alias;
        if (string.IsNullOrWhiteSpace(displayName))
            displayName = name;
        if (string.IsNullOrWhiteSpace(displayName))
            displayName = address;

        return new AdvertisementDeviceSnapshot(
            address,
            alias,
            name,
            displayName ?? "Unknown BLE device",
            isConnected,
            isPaired,
            rssi,
            manufacturerData.Payloads,
            serviceData,
            manufacturerData.Descriptions,
            advertisedServiceUuids,
            DateTimeOffset.UtcNow);
    }

    private static ExtractedPayloadMap ExtractKeyedPayloads(object? value)
    {
        if (value is not IEnumerable enumerable)
            return new ExtractedPayloadMap(new Dictionary<int, byte[]>(), []);

        var payloads = new Dictionary<int, byte[]>();
        var descriptions = new List<string>();
        foreach (var entry in enumerable)
        {
            if (entry is null)
                continue;

            var entryType = entry.GetType();
            var key = entryType.GetProperty("Key")?.GetValue(entry);
            var payload = entryType.GetProperty("Value")?.GetValue(entry);

            var normalizedPayload = ToByteArray(payload);
            var keyValue = TryConvertInt32(key);
            if (keyValue.HasValue && normalizedPayload is not null)
                payloads[keyValue.Value] = normalizedPayload;

            var keyText = keyValue.HasValue ? $"0x{keyValue.Value:X4}" : key?.ToString()?.Trim() ?? "Manufacturer";
            var payloadText = normalizedPayload is null ? null : FormatPayload(normalizedPayload);
            if (!string.IsNullOrWhiteSpace(payloadText))
                descriptions.Add($"{keyText}: {payloadText}");
        }

        return new ExtractedPayloadMap(payloads, descriptions.Distinct(StringComparer.OrdinalIgnoreCase).ToArray());
    }

    private static Dictionary<string, byte[]> ExtractServicePayloads(object? value)
    {
        if (value is not IEnumerable enumerable)
            return new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

        var payloads = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in enumerable)
        {
            if (entry is null)
                continue;

            var entryType = entry.GetType();
            var key = entryType.GetProperty("Key")?.GetValue(entry)?.ToString()?.Trim();
            var payload = ToByteArray(entryType.GetProperty("Value")?.GetValue(entry));
            var normalizedKey = NormalizeUuid(key);
            if (!string.IsNullOrWhiteSpace(normalizedKey) && payload is not null)
                payloads[normalizedKey] = payload;
        }

        return payloads;
    }

    private static byte[]? ToByteArray(object? payload)
    {
        switch (payload)
        {
            case null:
                return null;
            case byte[] bytes:
                return bytes;
            case IEnumerable<byte> byteEnumerable:
                return byteEnumerable.ToArray();
            default:
                return null;
        }
    }

    private static int? TryConvertInt32(object? value)
    {
        if (value is null)
            return null;

        try
        {
            return Convert.ToInt32(value);
        }
        catch
        {
            return null;
        }
    }

    private static string? NormalizeUuid(string? uuid)
    {
        if (string.IsNullOrWhiteSpace(uuid))
            return null;

        return BlueZManager.NormalizeUUID(uuid.Trim());
    }

    private static string[] DescribeStringSequence(object? value)
    {
        if (value is not IEnumerable enumerable)
            return [];

        return enumerable
            .Cast<object?>()
            .Select(item => item?.ToString()?.Trim())
            .Where(item => !string.IsNullOrWhiteSpace(item))
            .Select(item => item!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static string FormatPayload(byte[] payload)
    {
        var hex = Convert.ToHexString(payload);
        return hex.Length > 20 ? $"{hex[..20]}..." : hex;
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
            return null;

        try
        {
            return Convert.ToInt32(value);
        }
        catch
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;

        if (_adapter is not null && _deviceFoundHandler is not null)
            _adapter.DeviceFound -= _deviceFoundHandler;

        if (_adapter is not null)
        {
            try
            {
                _adapter.StopDiscoveryAsync().GetAwaiter().GetResult();
            }
            catch
            {
                // Best effort during shutdown.
            }
        }

        _scannerLock.Dispose();
    }

    private sealed record AdvertisementDeviceSnapshot(
        string Address,
        string? Alias,
        string? Name,
        string DisplayName,
        bool IsConnected,
        bool IsPaired,
        int? Rssi,
        IReadOnlyDictionary<int, byte[]> ManufacturerData,
        IReadOnlyDictionary<string, byte[]> ServiceData,
        string[] ManufacturerDataDescriptions,
        string[] AdvertisedServiceUuids,
        DateTimeOffset LastSeen);

    private readonly record struct AdvertisementPayloadSnapshot(
        byte[] Payload,
        DateTimeOffset CapturedAt);

    private sealed record ExtractedPayloadMap(
        Dictionary<int, byte[]> Payloads,
        string[] Descriptions);
}
