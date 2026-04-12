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
    DeviceConfigStore deviceConfigStore,
    DeviceDefinitionLoader definitionLoader,
    DeviceStateStore stateStore,
    ILogger<GenericBleAdvertisementPollingClient> logger) : IDevicePollingClient, IDisposable
{
    private readonly SemaphoreSlim _scannerLock = new(1, 1);
    private readonly object _cacheGate = new();
    private readonly Dictionary<string, AdvertisementDeviceSnapshot> _snapshots = new(StringComparer.OrdinalIgnoreCase);
    private static readonly TimeSpan SnapshotMetadataRefreshInterval = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan SnapshotRefreshInterval = TimeSpan.FromSeconds(1);
    private Adapter? _adapter;
    private DeviceChangeEventHandlerAsync? _deviceFoundHandler;
    private CancellationTokenSource? _scannerRefreshCancellationSource;
    private Task? _scannerRefreshTask;
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
        var result = telemetryBuilder.BuildPollResult(
            definition,
            CreateBankData(definition, payloadSnapshot.Payload),
            payloadSnapshot.CapturedAt,
            Convert.ToHexString(payloadSnapshot.Payload));

        return EnrichResultWithAdvertisementMetadata(result, payloadSnapshot);
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
            _scannerRefreshCancellationSource = new CancellationTokenSource();
            _scannerRefreshTask = RunSnapshotRefreshLoopAsync(adapter, _scannerRefreshCancellationSource.Token);
        }
        finally
        {
            _scannerLock.Release();
        }
    }

    private async Task RunSnapshotRefreshLoopAsync(Adapter adapter, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(SnapshotRefreshInterval);

        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                IReadOnlyList<Device> devices;
                try
                {
                    devices = await adapter.GetDevicesAsync();
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception exception)
                {
                    logger.LogDebug(exception, "Unable to refresh BLE advertisement snapshots from BlueZ.");
                    continue;
                }

                foreach (var device in devices)
                {
                    try
                    {
                        await CaptureSnapshotAsync(device);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        return;
                    }
                    catch (Exception exception)
                    {
                        logger.LogDebug(exception, "Unable to capture a refreshed BLE advertisement snapshot.");
                    }
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Expected during shutdown.
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

    private BleDiscoveredDevice MapDiscoveredDevice(
        AdvertisementDeviceSnapshot snapshot,
        DeviceDefinition? definition)
    {
        var verified = definition is not null && IsDefinitionSupported(definition) && MatchesDefinition(snapshot, definition);
        var details = verified
            ? BuildVerificationDetails(snapshot, definition!)
            : null;
        var payloadSnapshot = definition is not null && verified && TryExtractPayload(snapshot, definition, out var payload)
            ? payload
            : default;
        var preview = definition is not null && verified && payloadSnapshot.Payload is not null
            ? BuildPreviewMetrics(definition, payloadSnapshot)
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
            verified ? "Compatible" : null,
            details,
            snapshot.LastSeen,
            ConvertRssiToSignalStrengthPercent(snapshot.Rssi),
            preview?.TemperatureCelsius,
            preview?.HumidityPercent,
            preview?.BatteryPercent);
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
            snapshot.Address,
            rawPayload.Skip(offset).Take(length).ToArray(),
            snapshot.LastSeen,
            snapshot.Rssi,
            ConvertRssiToSignalStrengthPercent(snapshot.Rssi));
        return true;
    }

    private async Task CaptureSnapshotAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync()) ?? string.Empty;
        if (string.IsNullOrWhiteSpace(address))
            return;

        AdvertisementDeviceSnapshot? previousSnapshot;
        lock (_cacheGate)
        {
            _snapshots.TryGetValue(address, out previousSnapshot);
        }

        var snapshot = await BuildSnapshotAsync(device, address, previousSnapshot);
        if (string.IsNullOrWhiteSpace(snapshot.Address))
            return;

        lock (_cacheGate)
        {
            _snapshots[snapshot.Address] = snapshot;
        }

        await PublishAdvertisementObservationsAsync(snapshot);
    }

    private static async Task<AdvertisementDeviceSnapshot> BuildSnapshotAsync(
        Device device,
        string address,
        AdvertisementDeviceSnapshot? previousSnapshot)
    {
        var capturedAt = DateTimeOffset.UtcNow;
        var shouldRefreshMetadata = previousSnapshot is null ||
            capturedAt - previousSnapshot.MetadataRefreshedAt >= SnapshotMetadataRefreshInterval;

        var alias = previousSnapshot?.Alias;
        if (string.IsNullOrWhiteSpace(alias) || shouldRefreshMetadata)
            alias = await SafeGetStringAsync(() => device.GetAliasAsync()) ?? alias;

        var name = previousSnapshot?.Name;
        if (string.IsNullOrWhiteSpace(name) || shouldRefreshMetadata)
            name = await SafeGetStringAsync(() => device.GetNameAsync()) ?? name;

        var isConnected = shouldRefreshMetadata
            ? await SafeGetValueAsync(() => device.GetAsync<bool>("Connected"))
            : previousSnapshot?.IsConnected ?? false;
        var isPaired = shouldRefreshMetadata
            ? await SafeGetValueAsync(() => device.GetAsync<bool>("Paired"))
            : previousSnapshot?.IsPaired ?? false;
        var rssi = ConvertToNullableInt(await SafeGetObjectAsync(() => device.GetRSSIAsync()));
        var manufacturerData = ExtractKeyedPayloads(
            await SafeGetObjectAsync(() => device.GetManufacturerDataAsync()),
            previousSnapshot?.ManufacturerData);
        var serviceData = ExtractServicePayloads(
            await SafeGetObjectAsync(() => device.GetServiceDataAsync()),
            previousSnapshot?.ServiceData);
        var advertisedServiceUuids = shouldRefreshMetadata || previousSnapshot is null || previousSnapshot.AdvertisedServiceUuids.Length == 0
            ? DescribeStringSequence(await SafeGetObjectAsync(() => device.GetUUIDsAsync()))
            : previousSnapshot.AdvertisedServiceUuids;

        var displayName = alias;
        if (string.IsNullOrWhiteSpace(displayName))
            displayName = name;
        if (string.IsNullOrWhiteSpace(displayName))
            displayName = address;

        var advertisementChanged = previousSnapshot is null ||
            rssi != previousSnapshot.Rssi ||
            !PayloadMapsEqual(manufacturerData.Payloads, previousSnapshot.ManufacturerData) ||
            !PayloadMapsEqual(serviceData, previousSnapshot.ServiceData);
        var lastSeen = previousSnapshot is null || advertisementChanged
            ? capturedAt
            : previousSnapshot.LastSeen;

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
            lastSeen,
            shouldRefreshMetadata ? capturedAt : previousSnapshot?.MetadataRefreshedAt ?? capturedAt);
    }

    private Task PublishAdvertisementObservationsAsync(AdvertisementDeviceSnapshot snapshot)
    {
        foreach (var device in deviceConfigStore.GetDevices())
        {
            if (!device.Enabled || string.IsNullOrWhiteSpace(device.TransportPortName))
            {
                continue;
            }

            DeviceDefinition? definition = null;
            if (!device.TryResolveDefinition(definitionLoader, out definition) || definition is null)
            {
                continue;
            }

            if (!string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase) ||
                !string.Equals(definition.Connection.Protocol.Type, "ble-advertisement", StringComparison.OrdinalIgnoreCase) ||
                !GenericBlePollingClient.IdentifierMatches(device.TransportPortName, snapshot.Address, snapshot.Alias, snapshot.Name) ||
                !TryExtractPayload(snapshot, definition, out var payloadSnapshot))
            {
                continue;
            }

            try
            {
                var result = BuildResultFromPayload(payloadSnapshot, definition);
                stateStore.MarkAdvertisementObserved(device, result.Snapshot);
            }
            catch (Exception exception)
            {
                logger.LogDebug(
                    exception,
                    "Skipping live advertisement update for device {DeviceId}.",
                    device.DeviceId);
            }
        }

        return Task.CompletedTask;
    }

    private static Dictionary<string, byte[]> CreateBankData(DeviceDefinition definition, byte[] payload)
    {
        var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        var hasGoveePayload = TryDecodeGoveeH5075Payload(payload, out var goveeBuffer);
        foreach (var bank in definition.DataSources)
        {
            if (IsGoveeH5075Definition(definition) && hasGoveePayload)
            {
                bankData[bank.Id] = goveeBuffer!;
                continue;
            }

            var buffer = payload.ToArray();
            if (bank.ResponseLayout is not null)
                buffer = ResponseLayoutNormalizer.Normalize(buffer, bank.ResponseLayout);

            bankData[bank.Id] = buffer;
        }

        return bankData;
    }

    private static DevicePollResult EnrichResultWithAdvertisementMetadata(
        DevicePollResult result,
        AdvertisementPayloadSnapshot payloadSnapshot)
    {
        var parameters = result.Snapshot.Parameters.ToList();
        AppendOrReplaceParameter(
            parameters,
            new FluxMonitor.Contracts.Status.DeviceParameter
            {
                Key = "signal_strength_pct",
                DisplayName = "Signal",
                Category = "Status",
                NumericValue = payloadSnapshot.SignalStrengthPercent,
                Unit = "%",
                SortOrder = parameters.Count
            });

        if (payloadSnapshot.Rssi.HasValue)
        {
            AppendOrReplaceParameter(
                parameters,
                new FluxMonitor.Contracts.Status.DeviceParameter
                {
                    Key = "rssi_dbm",
                    DisplayName = "RSSI",
                    Category = "Status",
                    NumericValue = payloadSnapshot.Rssi.Value,
                    Unit = "dBm",
                    SortOrder = parameters.Count
                });
        }

        return result with
        {
            Snapshot = result.Snapshot with
            {
                Parameters = parameters
            }
        };
    }

    private static void AppendOrReplaceParameter(
        List<FluxMonitor.Contracts.Status.DeviceParameter> parameters,
        FluxMonitor.Contracts.Status.DeviceParameter parameter)
    {
        var existingIndex = parameters.FindIndex(existing =>
            string.Equals(existing.Key, parameter.Key, StringComparison.OrdinalIgnoreCase));
        if (existingIndex >= 0)
        {
            parameters[existingIndex] = parameter with { SortOrder = parameters[existingIndex].SortOrder };
            return;
        }

        parameters.Add(parameter);
    }

    private BlePreviewMetrics? BuildPreviewMetrics(
        DeviceDefinition definition,
        AdvertisementPayloadSnapshot payloadSnapshot)
    {
        var preview = BuildResultFromPayload(payloadSnapshot, definition).Snapshot;
        return new BlePreviewMetrics(
            FindNumericParameter(preview, ResolveEntityId(definition, role: "temperature", fallbackId: "temperature_c")),
            FindNumericParameter(preview, ResolveEntityId(definition, fallbackId: "humidity_pct")),
            FindNumericParameter(preview, ResolveEntityId(definition, fallbackId: "battery_pct")) is { } battery
                ? decimal.ToInt32(decimal.Round(battery, 0))
                : null);
    }

    private static decimal? FindNumericParameter(
        FluxMonitor.Contracts.Status.DeviceTelemetrySnapshot snapshot,
        string? parameterKey)
    {
        if (string.IsNullOrWhiteSpace(parameterKey))
            return null;

        return snapshot.Parameters.FirstOrDefault(parameter =>
            string.Equals(parameter.Key, parameterKey, StringComparison.OrdinalIgnoreCase))?.NumericValue;
    }

    private static string? ResolveEntityId(
        DeviceDefinition definition,
        string? role = null,
        string? fallbackId = null)
    {
        if (!string.IsNullOrWhiteSpace(role))
        {
            var roleMatch = definition.Entities.FirstOrDefault(entity =>
                string.Equals(entity.Role, role, StringComparison.OrdinalIgnoreCase));
            if (roleMatch is not null)
                return roleMatch.Id;
        }

        return fallbackId;
    }

    internal static int? ConvertRssiToSignalStrengthPercent(int? rssi, int minRssi = -95, int maxRssi = -45)
    {
        if (!rssi.HasValue)
            return null;

        var bounded = Math.Clamp((rssi.Value - minRssi) / (double)(maxRssi - minRssi), 0d, 1d);
        return (int)Math.Round(bounded * 100d, MidpointRounding.AwayFromZero);
    }

    private static bool IsGoveeH5075Definition(DeviceDefinition definition)
    {
        return string.Equals(definition.Device.Id, "govee-thermo-hygrometer-ble", StringComparison.OrdinalIgnoreCase);
    }

    internal static bool TryDecodeGoveeH5075Payload(byte[] payload, out byte[]? normalizedBuffer)
    {
        normalizedBuffer = null;

        if (payload.Length < 4)
            return false;

        ReadOnlySpan<byte> tempHum;
        var battery = 0;

        if (payload.Length >= 6 && payload[0] == 0x00)
        {
            tempHum = payload.AsSpan(1, 3);
            battery = payload[4] & 0x7F;
        }
        else
        {
            tempHum = payload.AsSpan(0, 3);
            battery = payload[^1] & 0x7F;
        }

        var raw = (tempHum[0] << 16) | (tempHum[1] << 8) | tempHum[2];
        var isNegative = (raw & 0x800000) != 0;
        raw &= 0x7FFFFF;

        var temperatureTenths = raw / 1000;
        if (isNegative)
            temperatureTenths *= -1;

        var humidityTenths = raw % 1000;

        normalizedBuffer = new byte[5];
        System.Buffers.Binary.BinaryPrimitives.WriteInt16BigEndian(normalizedBuffer.AsSpan(0, 2), (short)temperatureTenths);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(normalizedBuffer.AsSpan(2, 2), (ushort)humidityTenths);
        normalizedBuffer[4] = (byte)battery;
        return true;
    }

    private static string[] DescribePayloads(IReadOnlyDictionary<int, byte[]> payloads)
    {
        return payloads
            .Select(entry =>
            {
                var payloadText = FormatPayload(entry.Value);
                return string.IsNullOrWhiteSpace(payloadText)
                    ? null
                    : $"0x{entry.Key:X4}: {payloadText}";
            })
            .Where(description => !string.IsNullOrWhiteSpace(description))
            .Select(description => description!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static ExtractedPayloadMap ExtractKeyedPayloads(
        object? value,
        IReadOnlyDictionary<int, byte[]>? previousPayloads = null)
    {
        if (value is not IEnumerable enumerable)
        {
            var fallbackPayloads = previousPayloads is null
                ? new Dictionary<int, byte[]>()
                : new Dictionary<int, byte[]>(previousPayloads, EqualityComparer<int>.Default);
            return new ExtractedPayloadMap(fallbackPayloads, DescribePayloads(fallbackPayloads));
        }

        var payloads = new Dictionary<int, byte[]>();
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
        }

        if (payloads.Count == 0 && previousPayloads is not null)
            payloads = new Dictionary<int, byte[]>(previousPayloads, EqualityComparer<int>.Default);

        return new ExtractedPayloadMap(payloads, DescribePayloads(payloads));
    }

    private static Dictionary<string, byte[]> ExtractServicePayloads(
        object? value,
        IReadOnlyDictionary<string, byte[]>? previousPayloads = null)
    {
        if (value is not IEnumerable enumerable)
            return previousPayloads is null
                ? new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, byte[]>(previousPayloads, StringComparer.OrdinalIgnoreCase);

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

        if (payloads.Count == 0 && previousPayloads is not null)
            return new Dictionary<string, byte[]>(previousPayloads, StringComparer.OrdinalIgnoreCase);

        return payloads;
    }

    private static bool PayloadMapsEqual<TKey>(
        IReadOnlyDictionary<TKey, byte[]> current,
        IReadOnlyDictionary<TKey, byte[]>? previous)
        where TKey : notnull
    {
        if (previous is null || current.Count != previous.Count)
            return false;

        foreach (var (key, currentPayload) in current)
        {
            if (!previous.TryGetValue(key, out var previousPayload) ||
                previousPayload is null ||
                !currentPayload.AsSpan().SequenceEqual(previousPayload))
            {
                return false;
            }
        }

        return true;
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

        if (_scannerRefreshCancellationSource is not null)
        {
            _scannerRefreshCancellationSource.Cancel();
        }

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

        if (_scannerRefreshTask is not null)
        {
            try
            {
                _scannerRefreshTask.GetAwaiter().GetResult();
            }
            catch
            {
                // Best effort during shutdown.
            }
        }

        _scannerRefreshCancellationSource?.Dispose();

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
        DateTimeOffset LastSeen,
        DateTimeOffset MetadataRefreshedAt);

    private readonly record struct AdvertisementPayloadSnapshot(
        string Address,
        byte[] Payload,
        DateTimeOffset CapturedAt,
        int? Rssi,
        int? SignalStrengthPercent);

    private sealed record ExtractedPayloadMap(
        Dictionary<int, byte[]> Payloads,
        string[] Descriptions);

    private sealed record BlePreviewMetrics(
        decimal? TemperatureCelsius,
        decimal? HumidityPercent,
        int? BatteryPercent);
}
