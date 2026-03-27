using System.Collections.Concurrent;
using System.Collections;
using Linux.Bluetooth;
using Linux.Bluetooth.Extensions;
using Tmds.DBus;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Definition-driven BLE polling client for frame-based GATT protocols.
/// The current implementation supports the JK BMS BLE protocol over BlueZ on Linux.
/// </summary>
public sealed class GenericBlePollingClient(
    DefinitionDrivenTelemetryBuilder telemetryBuilder,
    DeviceDefinitionLoader definitionLoader,
    ILogger<GenericBlePollingClient> logger) : IDevicePollingClient, IDisposable
{
    private readonly ConcurrentDictionary<string, BleSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private bool _disposed;

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(device.DefinitionId) ||
            !definitionLoader.TryGet(device.DefinitionId, out var definition) ||
            definition is null)
        {
            throw new InvalidOperationException(
                $"Device '{device.DeviceId}' has no valid DefinitionId ('{device.DefinitionId}').");
        }

        return PollAsync(device, definition, cancellationToken);
    }

    public async Task<DevicePollResult> PollAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("BLE polling is supported on Linux/BlueZ only.");

        if (!string.Equals(definition.Connection.Protocol.Type, "jk-bms-ble", StringComparison.OrdinalIgnoreCase))
        {
            throw new NotSupportedException(
                $"BLE protocol '{definition.Connection.Protocol.Type}' is not supported yet for device '{device.DeviceId}'.");
        }

        var session = _sessions.GetOrAdd(device.DeviceId, _ => new BleSession(device.DeviceId));
        await session.Lock.WaitAsync(cancellationToken);
        try
        {
            await EnsureConnectedAsync(session, device, definition, cancellationToken);

            var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            var now = DateTimeOffset.UtcNow;
            foreach (var bank in definition.DataSources)
            {
                var pollGroup = definition.PollGroups.GetValueOrDefault(bank.PollGroup);
                var intervalMs = pollGroup?.IntervalMs ?? 1000;

                if (session.BankCache.TryGetValue(bank.Id, out var cached) &&
                    now - cached.LastRead < TimeSpan.FromMilliseconds(intervalMs))
                {
                    bankData[bank.Id] = cached.Data;
                    continue;
                }

                var frame = await RequestFrameAsync(session, definition, bank, cancellationToken);
                var payload = ExtractPayload(frame, bank);
                bankData[bank.Id] = payload;
                session.BankCache[bank.Id] = (now, payload);
            }

            return telemetryBuilder.BuildPollResult(
                definition,
                bankData,
                DateTimeOffset.UtcNow,
                session.LastFrameHex);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            await ResetSessionAsync(session);
            throw;
        }
        finally
        {
            session.Lock.Release();
        }
    }

    public async Task<IReadOnlyList<BleDiscoveredDevice>> DiscoverDevicesAsync(
        DeviceDefinition? definition,
        TimeSpan? timeout,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("BLE discovery is supported on Linux/BlueZ only.");

        if (definition is not null &&
            !string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
        {
            return [];
        }

        var discoveryWindow = timeout ?? TimeSpan.FromSeconds(6);
        if (discoveryWindow < TimeSpan.FromSeconds(1))
            discoveryWindow = TimeSpan.FromSeconds(1);

        logger.LogInformation(
            "Starting BLE discovery. DefinitionId={DefinitionId}, Protocol={Protocol}, TimeoutMs={TimeoutMs}.",
            definition?.Device.Id ?? "<none>",
            definition?.Connection.Protocol.Type ?? "<none>",
            (int)discoveryWindow.TotalMilliseconds);

        var adapter = (await BlueZManager.GetAdaptersAsync()).FirstOrDefault()
            ?? throw new InvalidOperationException("No Bluetooth adapter was found.");

        if (!await adapter.GetAsync<bool>("Powered"))
            await adapter.SetAsync("Powered", true);

        var devices = new ConcurrentDictionary<string, Device>(StringComparer.OrdinalIgnoreCase);

        foreach (var device in await adapter.GetDevicesAsync())
        {
            var key = await GetDiscoveryKeyAsync(device);
            if (!string.IsNullOrWhiteSpace(key))
                devices[key] = device;
        }

        async Task OnDeviceFoundAsync(Adapter _, DeviceFoundEventArgs args)
        {
            var key = await GetDiscoveryKeyAsync(args.Device);
            if (!string.IsNullOrWhiteSpace(key))
                devices[key] = args.Device;
        }

        adapter.DeviceFound += OnDeviceFoundAsync;
        try
        {
            await adapter.StartDiscoveryAsync();
            await Task.Delay(discoveryWindow, cancellationToken);
        }
        finally
        {
            adapter.DeviceFound -= OnDeviceFoundAsync;
            try { await adapter.StopDiscoveryAsync(); } catch { /* best effort */ }
        }

        var discovered = new List<BleDiscoveredDevice>(devices.Count);
        foreach (var device in devices.Values)
            discovered.Add(await MapDiscoveredDeviceAsync(device));

        if (definition is not null &&
            string.Equals(definition.Connection.Protocol.Type, "jk-bms-ble", StringComparison.OrdinalIgnoreCase))
        {
            var serviceUuid = BlueZManager.NormalizeUUID(
                definition.Connection.Transport.Defaults?.ServiceUuid
                ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE service UUID."));
            var probeTimeout = TimeSpan.FromMilliseconds(Math.Clamp((int)(discoveryWindow.TotalMilliseconds / 2), 1500, 4000));

            foreach (var candidate in discovered
                .Where(device =>
                    device.AdvertisedServiceUuids.Length == 0 ||
                    device.AdvertisedServiceUuids.Contains(serviceUuid, StringComparer.OrdinalIgnoreCase))
                .OrderByDescending(device => device.Rssi ?? int.MinValue)
                .Take(4)
                .ToArray())
            {
                var probe = await ProbeDefinitionAsync(candidate.Address, definition, probeTimeout, cancellationToken);
                if (probe.IsDefinitionVerified)
                {
                    logger.LogInformation(
                        "BLE probe verified candidate {Address} for definition {DefinitionId}. Details={Details}",
                        candidate.Address,
                        definition.Device.Id,
                        probe.VerificationDetails ?? "<none>");
                }
                else if (!string.IsNullOrWhiteSpace(probe.VerificationDetails))
                {
                    logger.LogWarning(
                        "BLE probe could not verify candidate {Address} for definition {DefinitionId}. Details={Details}",
                        candidate.Address,
                        definition.Device.Id,
                        probe.VerificationDetails);
                }

                discovered[discovered.FindIndex(device => string.Equals(device.Address, candidate.Address, StringComparison.OrdinalIgnoreCase))] =
                    candidate with
                    {
                        IsDefinitionVerified = probe.IsDefinitionVerified,
                        VerificationLabel = probe.VerificationLabel,
                        VerificationDetails = probe.VerificationDetails
                    };
            }
        }

        var ordered = discovered
            .OrderByDescending(device => device.IsDefinitionVerified)
            .ThenByDescending(device => device.IsConnected)
            .ThenByDescending(device => device.Rssi ?? int.MinValue)
            .ThenBy(device => string.IsNullOrWhiteSpace(device.DisplayName) ? 1 : 0)
            .ThenBy(device => device.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(device => device.Address, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        logger.LogInformation(
            "BLE discovery completed. DefinitionId={DefinitionId}, ResultCount={ResultCount}, VerifiedCount={VerifiedCount}.",
            definition?.Device.Id ?? "<none>",
            ordered.Length,
            ordered.Count(device => device.IsDefinitionVerified));

        return ordered;
    }

    private async Task EnsureConnectedAsync(
        BleSession session,
        DeviceConfiguration device,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        if (session.Device is not null &&
            session.WriteCharacteristic is not null &&
            session.NotifyCharacteristic is not null)
        {
            try
            {
                if (await session.Device.GetAsync<bool>("Connected") &&
                    await session.Device.GetAsync<bool>("ServicesResolved"))
                {
                    return;
                }
            }
            catch
            {
                // Reconnect below.
            }
        }

        await ResetSessionAsync(session);

        var transportDefaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();
        var timeout = TimeSpan.FromMilliseconds(Math.Max(transportDefaults.ConnectionTimeoutMs, 1000));
        var serviceUuid = BlueZManager.NormalizeUUID(
            transportDefaults.ServiceUuid
            ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE service UUID."));
        var notifyUuid = BlueZManager.NormalizeUUID(
            transportDefaults.NotifyCharacteristicUuid
            ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE notify characteristic UUID."));
        var writeUuid = BlueZManager.NormalizeUUID(
            transportDefaults.WriteCharacteristicUuid
            ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE write characteristic UUID."));
        var target = device.TransportPortName?.Trim();
        if (string.IsNullOrWhiteSpace(target))
            throw new InvalidOperationException($"Device '{device.DeviceId}' has no BLE address or alias configured.");

        var adapter = (await BlueZManager.GetAdaptersAsync()).FirstOrDefault()
            ?? throw new InvalidOperationException("No Bluetooth adapter was found.");

        if (!await adapter.GetAsync<bool>("Powered"))
            await adapter.SetAsync("Powered", true);

        try
        {
            var bleDevice = await ResolveDeviceAsync(adapter, target, timeout, cancellationToken)
                ?? throw new TimeoutException($"Unable to find BLE device '{target}'.");

            logger.LogInformation("Connecting to BLE device {Target} for device {DeviceId}.", target, device.DeviceId);
            await bleDevice.ConnectAsync();
            await bleDevice.WaitForPropertyValueAsync("Connected", value: true, timeout);
            await bleDevice.WaitForPropertyValueAsync("ServicesResolved", value: true, timeout);

            var service = await bleDevice.GetServiceAsync(serviceUuid);
            if (service is null)
                throw new InvalidOperationException(
                    $"BLE service '{serviceUuid}' was not found on device '{target}'. Pairing may be required.");

            var characteristics = await service.GetCharacteristicsAsync();
            var notifyCharacteristic = await SelectCharacteristicAsync(characteristics, notifyUuid, requiredFlag: "notify");
            var writeCharacteristic = await SelectCharacteristicAsync(
                characteristics,
                writeUuid,
                requiredFlag: "write-without-response",
                alternateFlag: "write");

            if (notifyCharacteristic is null)
                throw new InvalidOperationException($"Notify characteristic '{notifyUuid}' was not found on device '{target}'.");
            if (writeCharacteristic is null)
                throw new InvalidOperationException($"Write characteristic '{writeUuid}' was not found on device '{target}'.");

            session.Device = bleDevice;
            session.NotifyCharacteristic = notifyCharacteristic;
            session.WriteCharacteristic = writeCharacteristic;
            session.NotifyWatcher = await notifyCharacteristic.WatchPropertiesAsync(changes => OnNotifyPropertiesChanged(session, definition, changes));
            await notifyCharacteristic.StartNotifyAsync();

            logger.LogInformation(
                "BLE connection established for device {DeviceId}. Target={Target}, ServiceUuid={ServiceUuid}.",
                device.DeviceId,
                target,
                serviceUuid);
        }
        catch (Exception ex) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(
                ex,
                "BLE connection/setup failed for device {DeviceId}. Target={Target}, DefinitionId={DefinitionId}.",
                device.DeviceId,
                target,
                definition.Device.Id);
            throw;
        }
    }

    private async Task<byte[]> RequestFrameAsync(
        BleSession session,
        DeviceDefinition definition,
        DataSourceDefinition bank,
        CancellationToken cancellationToken)
    {
        var transportDefaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();
        var timeout = TimeSpan.FromMilliseconds(Math.Max(transportDefaults.ConnectionTimeoutMs, 1000));
        var expectedFrameSize = definition.Connection.Protocol.Settings?.ResponseFrameSize ?? 300;
        if (expectedFrameSize < 8)
            throw new InvalidOperationException($"Definition '{definition.Device.Id}' has an invalid BLE response frame size.");

        TaskCompletionSource<byte[]> pendingFrame;
        lock (session.SyncRoot)
        {
            session.FrameBuffer.Clear();
            pendingFrame = new(TaskCreationOptions.RunContinuationsAsynchronously);
            session.PendingFrame = pendingFrame;
            session.PendingFrameType = bank.ResponseFrameType;
            session.ExpectedFrameSize = expectedFrameSize;
        }

        try
        {
            var commandFrame = BuildJkBleCommand(bank.Command);
            var options = new Dictionary<string, object>
            {
                ["type"] = await SelectWriteTypeAsync(session.WriteCharacteristic!)
            };

            logger.LogDebug(
                "Sending BLE command 0x{Command:X2} expecting frame type 0x{FrameType:X2} for device {DeviceId}.",
                bank.Command,
                bank.ResponseFrameType,
                session.DeviceId);

            await session.WriteCharacteristic!.WriteValueAsync(commandFrame, options);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var timeoutTask = Task.Delay(timeout, timeoutCts.Token);
            var completed = await Task.WhenAny(pendingFrame.Task, timeoutTask);
            if (completed != pendingFrame.Task)
                throw new TimeoutException(
                    $"Timed out waiting for BLE frame type 0x{bank.ResponseFrameType:X2} from device '{session.DeviceId}'.");

            timeoutCts.Cancel();
            return await pendingFrame.Task;
        }
        finally
        {
            lock (session.SyncRoot)
            {
                session.PendingFrame = null;
                session.PendingFrameType = null;
            }
        }
    }

    private void OnNotifyPropertiesChanged(BleSession session, DeviceDefinition definition, PropertyChanges changes)
    {
        var changedValue = changes.Changed
            .FirstOrDefault(pair => string.Equals(pair.Key, "Value", StringComparison.Ordinal))
            .Value;
        if (changedValue is not byte[] chunk || chunk.Length == 0)
            return;

        var checksumType = definition.Connection.Protocol.Settings?.ChecksumType ?? "sum8";
        TaskCompletionSource<byte[]>? pendingFrame = null;
        byte[]? completedFrame = null;
        byte? frameType = null;

        lock (session.SyncRoot)
        {
            if (StartsWithFramePreamble(chunk))
                session.FrameBuffer.Clear();

            session.FrameBuffer.AddRange(chunk);
            if (session.ExpectedFrameSize <= 0 || session.FrameBuffer.Count < session.ExpectedFrameSize)
                return;

            var candidate = session.FrameBuffer.Take(session.ExpectedFrameSize).ToArray();
            session.FrameBuffer.Clear();

            if (!TryValidateFrame(candidate, checksumType))
            {
                logger.LogWarning("Discarded BLE frame with invalid checksum for device {DeviceId}.", session.DeviceId);
                return;
            }

            frameType = candidate[4];
            session.LastFrameHex = Convert.ToHexString(candidate);
            if (session.PendingFrameType == frameType && session.PendingFrame is not null)
            {
                pendingFrame = session.PendingFrame;
                completedFrame = candidate;
            }
        }

        if (pendingFrame is not null && completedFrame is not null)
            pendingFrame.TrySetResult(completedFrame);
        else if (frameType is not null)
            logger.LogDebug("Received unsolicited BLE frame type 0x{FrameType:X2} for device {DeviceId}.", frameType, session.DeviceId);
    }

    private static byte[] ExtractPayload(byte[] frame, DataSourceDefinition bank)
    {
        var headerSize = Math.Max(bank.HeaderSize, 0);
        if (headerSize >= frame.Length)
            return [];

        var crcSize = 1;
        var payloadLength = Math.Max(frame.Length - headerSize - crcSize, 0);
        return frame.AsSpan(headerSize, payloadLength).ToArray();
    }

    private static bool StartsWithFramePreamble(byte[] data)
        => data.Length >= 4 &&
           data[0] == 0x55 &&
           data[1] == 0xAA &&
           data[2] == 0xEB &&
           data[3] == 0x90;

    private static bool TryValidateFrame(byte[] frame, string checksumType)
    {
        if (frame.Length < 2)
            return false;

        return checksumType.ToLowerInvariant() switch
        {
            "sum8" => ComputeSum8(frame.AsSpan(0, frame.Length - 1)) == frame[^1],
            "none" => true,
            _ => false
        };
    }

    private static byte[] BuildJkBleCommand(byte command)
    {
        var frame = new byte[20];
        frame[0] = 0xAA;
        frame[1] = 0x55;
        frame[2] = 0x90;
        frame[3] = 0xEB;
        frame[4] = command;
        frame[5] = 0x00;
        frame[19] = ComputeSum8(frame.AsSpan(0, 19));
        return frame;
    }

    private static byte ComputeSum8(ReadOnlySpan<byte> data)
    {
        byte checksum = 0;
        foreach (var value in data)
            checksum += value;

        return checksum;
    }

    private static async Task<string> SelectWriteTypeAsync(IGattCharacteristic1 characteristic)
    {
        var flags = await characteristic.GetFlagsAsync();
        return flags.Any(flag => string.Equals(flag, "write-without-response", StringComparison.OrdinalIgnoreCase))
            ? "command"
            : "request";
    }

    private static async Task<IGattCharacteristic1?> SelectCharacteristicAsync(
        IReadOnlyList<IGattCharacteristic1> characteristics,
        string uuid,
        string requiredFlag,
        string? alternateFlag = null)
    {
        IGattCharacteristic1? alternate = null;
        foreach (var characteristic in characteristics)
        {
            var characteristicUuid = await characteristic.GetUUIDAsync();
            if (!string.Equals(characteristicUuid, uuid, StringComparison.OrdinalIgnoreCase))
                continue;

            var flags = await characteristic.GetFlagsAsync();
            if (flags.Any(flag => string.Equals(flag, requiredFlag, StringComparison.OrdinalIgnoreCase)))
                return characteristic;

            if (alternateFlag is not null &&
                flags.Any(flag => string.Equals(flag, alternateFlag, StringComparison.OrdinalIgnoreCase)))
            {
                alternate = characteristic;
            }
        }

        return alternate;
    }

    private static async Task<Device?> ResolveDeviceAsync(
        Adapter adapter,
        string identifier,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var knownDevices = await adapter.GetDevicesAsync();
        var knownMatch = await FindMatchingDeviceAsync(knownDevices, identifier);
        if (knownMatch is not null)
            return knownMatch;

        var discoveryTcs = new TaskCompletionSource<Device?>(TaskCreationOptions.RunContinuationsAsynchronously);

        async Task OnDeviceFoundAsync(Adapter _, DeviceFoundEventArgs args)
        {
            if (await IsMatchingDeviceAsync(args.Device, identifier))
                discoveryTcs.TrySetResult(args.Device);
        }

        adapter.DeviceFound += OnDeviceFoundAsync;
        try
        {
            await adapter.StartDiscoveryAsync();
            using var delayCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var delayTask = Task.Delay(timeout, delayCts.Token);
            var completed = await Task.WhenAny(discoveryTcs.Task, delayTask);
            if (completed != discoveryTcs.Task)
                return null;

            delayCts.Cancel();
            return await discoveryTcs.Task;
        }
        finally
        {
            adapter.DeviceFound -= OnDeviceFoundAsync;
            try { await adapter.StopDiscoveryAsync(); } catch { /* best effort */ }
        }
    }

    private static async Task<Device?> FindMatchingDeviceAsync(IEnumerable<Device> devices, string identifier)
    {
        foreach (var device in devices)
        {
            if (await IsMatchingDeviceAsync(device, identifier))
                return device;
        }

        return null;
    }

    private static async Task<bool> IsMatchingDeviceAsync(Device device, string identifier)
    {
        var target = identifier.Trim();
        var address = await device.GetAddressAsync();
        if (string.Equals(address, target, StringComparison.OrdinalIgnoreCase))
            return true;

        var alias = await device.GetAliasAsync();
        if (!string.IsNullOrWhiteSpace(alias) &&
            alias.Contains(target, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var name = await device.GetNameAsync();
        return !string.IsNullOrWhiteSpace(name) &&
               name.Contains(target, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<string?> GetDiscoveryKeyAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync());
        if (!string.IsNullOrWhiteSpace(address))
            return address;

        var name = await SafeGetStringAsync(() => device.GetNameAsync());
        if (!string.IsNullOrWhiteSpace(name))
            return name;

        return await SafeGetStringAsync(() => device.GetAliasAsync());
    }

    private async Task<BleProbeResult> ProbeDefinitionAsync(
        string address,
        DeviceDefinition definition,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(address))
            return new(false, null, null);

        using var probeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        probeCts.CancelAfter(timeout);

        var probeConfig = new DeviceConfiguration
        {
            DeviceId = $"ble-scan-{address.Replace(':', '-').ToLowerInvariant()}",
            DisplayName = address,
            DefinitionId = definition.Device.Id,
            TransportPortName = address,
            Address = 0,
            IsMaster = false,
            PollIntervalMilliseconds = 1000,
            Enabled = false
        };

        var session = new BleSession($"probe:{address}");
        try
        {
            await EnsureConnectedAsync(session, probeConfig, definition, probeCts.Token);

            var infoBank = definition.DataSources.FirstOrDefault(bank =>
                               string.Equals(bank.Id, "info", StringComparison.OrdinalIgnoreCase))
                           ?? definition.DataSources.FirstOrDefault();

            if (infoBank is null)
            {
                logger.LogWarning(
                    "BLE probe could not find a readable data source for address {Address} and definition {DefinitionId}.",
                    address,
                    definition.Device.Id);
                return new(false, null, "Probe could not find a readable JK data source.");
            }

            var frame = await RequestFrameAsync(session, definition, infoBank, probeCts.Token);
            var payload = ExtractPayload(frame, infoBank);

            var model = ReadAscii(payload, 0, 16);
            var deviceName = ReadAscii(payload, 96, 16);
            var vendor = ReadAscii(payload, 128, 16);
            var identity = new[] { vendor, model, deviceName }
                .Where(value => !string.IsNullOrWhiteSpace(value))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            var details = identity.Length > 0
                ? string.Join(" · ", identity)
                : "JK BLE protocol responded successfully.";

            return new(true, "Verified JK BMS", details);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(
                "BLE probe timed out for address {Address} and definition {DefinitionId}.",
                address,
                definition.Device.Id);
            return new(false, null, "JK probe timed out.");
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "BLE probe failed for address {Address} and definition {DefinitionId}.",
                address,
                definition.Device.Id);
            return new(false, null, $"JK probe failed: {ex.Message}");
        }
        finally
        {
            await ResetSessionAsync(session);
            session.Lock.Dispose();
        }
    }

    private static async Task<BleDiscoveredDevice> MapDiscoveredDeviceAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync()) ?? string.Empty;
        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        var name = await SafeGetStringAsync(() => device.GetNameAsync());
        var isConnected = await SafeGetValueAsync(() => device.GetAsync<bool>("Connected"));
        var isPaired = await SafeGetValueAsync(() => device.GetAsync<bool>("Paired"));
        var rssi = ConvertToNullableInt(await SafeGetObjectAsync(() => device.GetRSSIAsync()));
        var manufacturerData = DescribeKeyValuePayloads(await SafeGetObjectAsync(() => device.GetManufacturerDataAsync()));
        var advertisedServiceUuids = DescribeStringSequence(await SafeGetObjectAsync(() => device.GetUUIDsAsync()));

        var displayName = alias;
        if (string.IsNullOrWhiteSpace(displayName))
            displayName = name;
        if (string.IsNullOrWhiteSpace(displayName))
            displayName = address;

        return new BleDiscoveredDevice(
            address,
            string.Equals(alias, name, StringComparison.OrdinalIgnoreCase) ? null : alias,
            name,
            displayName ?? "Unknown BLE device",
            isConnected,
            isPaired,
            rssi,
            manufacturerData,
            advertisedServiceUuids,
            false,
            null,
            null);
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

    private static string[] DescribeKeyValuePayloads(object? value)
    {
        if (value is not IEnumerable enumerable)
            return [];

        var results = new List<string>();
        foreach (var entry in enumerable)
        {
            if (entry is null)
                continue;

            var entryType = entry.GetType();
            var key = entryType.GetProperty("Key")?.GetValue(entry);
            var payload = entryType.GetProperty("Value")?.GetValue(entry);
            var keyText = FormatManufacturerKey(key);
            var payloadText = FormatPayload(payload);

            if (!string.IsNullOrWhiteSpace(keyText) || !string.IsNullOrWhiteSpace(payloadText))
                results.Add(string.IsNullOrWhiteSpace(payloadText) ? keyText : $"{keyText}: {payloadText}");
        }

        return results.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static string FormatManufacturerKey(object? key)
    {
        if (key is null)
            return "Manufacturer";

        try
        {
            var numeric = Convert.ToUInt32(key);
            return $"0x{numeric:X4}";
        }
        catch
        {
            return key.ToString()?.Trim() ?? "Manufacturer";
        }
    }

    private static string? FormatPayload(object? payload)
    {
        if (payload is null)
            return null;

        if (payload is byte[] bytes)
        {
            var hex = Convert.ToHexString(bytes);
            return hex.Length > 20 ? $"{hex[..20]}..." : hex;
        }

        if (payload is IEnumerable<byte> byteEnumerable)
        {
            var bytesValue = byteEnumerable.ToArray();
            var hex = Convert.ToHexString(bytesValue);
            return hex.Length > 20 ? $"{hex[..20]}..." : hex;
        }

        return payload.ToString()?.Trim();
    }

    private static string? ReadAscii(byte[] payload, int offset, int length)
    {
        if (payload.Length <= offset || length <= 0)
            return null;

        var safeLength = Math.Min(length, payload.Length - offset);
        var value = System.Text.Encoding.ASCII.GetString(payload, offset, safeLength).TrimEnd('\0', ' ');
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private static async Task ResetSessionAsync(BleSession session)
    {
        TaskCompletionSource<byte[]>? pendingFrame;
        lock (session.SyncRoot)
        {
            pendingFrame = session.PendingFrame;
            session.PendingFrame = null;
            session.PendingFrameType = null;
            session.FrameBuffer.Clear();
            session.BankCache.Clear();
            session.LastFrameHex = string.Empty;
        }

        pendingFrame?.TrySetCanceled();

        try { session.NotifyWatcher?.Dispose(); } catch { /* best effort */ }
        session.NotifyWatcher = null;

        if (session.NotifyCharacteristic is not null)
        {
            try { await session.NotifyCharacteristic.StopNotifyAsync(); } catch { /* best effort */ }
        }

        if (session.Device is not null)
        {
            try { await session.Device.DisconnectAsync(); } catch { /* best effort */ }
            try { session.Device.Dispose(); } catch { /* best effort */ }
        }

        session.NotifyCharacteristic = null;
        session.WriteCharacteristic = null;
        session.Device = null;
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;
        foreach (var session in _sessions.Values)
        {
            try
            {
                session.Lock.Wait();
                ResetSessionAsync(session).GetAwaiter().GetResult();
            }
            finally
            {
                if (session.Lock.CurrentCount == 0)
                    session.Lock.Release();
                session.Lock.Dispose();
            }
        }
    }

    private sealed class BleSession(string deviceId)
    {
        public string DeviceId { get; } = deviceId;
        public SemaphoreSlim Lock { get; } = new(1, 1);
        public object SyncRoot { get; } = new();
        public Device? Device { get; set; }
        public IGattCharacteristic1? NotifyCharacteristic { get; set; }
        public IGattCharacteristic1? WriteCharacteristic { get; set; }
        public IDisposable? NotifyWatcher { get; set; }
        public List<byte> FrameBuffer { get; } = [];
        public Dictionary<string, (DateTimeOffset LastRead, byte[] Data)> BankCache { get; } = new(StringComparer.OrdinalIgnoreCase);
        public TaskCompletionSource<byte[]>? PendingFrame { get; set; }
        public byte? PendingFrameType { get; set; }
        public int ExpectedFrameSize { get; set; }
        public string LastFrameHex { get; set; } = string.Empty;
    }
}

public sealed record BleDiscoveredDevice(
    string Address,
    string? Alias,
    string? Name,
    string DisplayName,
    bool IsConnected,
    bool IsPaired,
    int? Rssi,
    string[] ManufacturerData,
    string[] AdvertisedServiceUuids,
    bool IsDefinitionVerified,
    string? VerificationLabel,
    string? VerificationDetails);

public sealed record BleProbeResult(
    bool IsDefinitionVerified,
    string? VerificationLabel,
    string? VerificationDetails);
