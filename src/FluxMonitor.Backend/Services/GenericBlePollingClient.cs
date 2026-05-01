using System.Buffers.Binary;
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
/// Definition-driven BLE client for frame-based GATT protocols.
/// Read behavior is described by the device definition per data source:
/// request/response banks actively write commands, while notify-stream banks
/// consume unsolicited frames from the active BLE notification subscription.
/// </summary>
public sealed class GenericBlePollingClient(
    DefinitionDrivenTelemetryBuilder telemetryBuilder,
    DeviceDefinitionLoader definitionLoader,
    BluetoothManagementService bluetoothManagementService,
    ILogger<GenericBlePollingClient> logger) : IDevicePollingClient, IDisposable
{
    private readonly ConcurrentDictionary<string, BleSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private bool _disposed;

    public static bool IsDefinitionSupported(DeviceDefinition definition)
        => GetUnsupportedDefinitionMessage(definition) is null;

    public static string? GetUnsupportedDefinitionMessage(DeviceDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);

        if (!string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
        {
            return $"Transport type '{definition.Connection.Transport.Type}' is not supported by the BLE polling client.";
        }

        if (definition.DataSources.Count == 0)
            return "At least one data source must be defined.";

        var transportDefaults = definition.Connection.Transport.Defaults;
        if (transportDefaults is null)
            return "BLE transport defaults are required.";

        if (string.IsNullOrWhiteSpace(transportDefaults.ServiceUuid))
            return "BLE serviceUuid is required.";

        if (string.IsNullOrWhiteSpace(transportDefaults.NotifyCharacteristicUuid))
            return "BLE notifyCharacteristicUuid is required.";

        var settings = definition.Connection.Protocol.Settings;
        if (settings is null)
            return "BLE protocol settings are required.";

        if (settings.ResponseFrameSize < 8)
            return "BLE responseFrameSize must be at least 8 bytes.";

        if (settings.ResponsePreamble.Count == 0)
            return "BLE responsePreamble is required.";

        if (!IsSupportedBleChecksum(settings.ChecksumType))
            return $"BLE checksumType '{settings.ChecksumType}' is not supported.";

        var invalidReadModeBank = definition.DataSources.FirstOrDefault(bank => !IsSupportedReadMode(bank.ReadMode));
        if (invalidReadModeBank is not null)
        {
            return $"BLE data source '{invalidReadModeBank.Id}' declares unsupported readMode '{invalidReadModeBank.ReadMode}'.";
        }

        if (settings.ResponseFrameTypeOffset < 0 || settings.ResponseFrameTypeOffset >= settings.ResponseFrameSize)
        {
            return $"BLE responseFrameTypeOffset {settings.ResponseFrameTypeOffset} must be within responseFrameSize {settings.ResponseFrameSize}.";
        }

        if (settings.ResponseFooterSize < 0 || settings.ResponseFooterSize >= settings.ResponseFrameSize)
        {
            return $"BLE responseFooterSize {settings.ResponseFooterSize} must be within responseFrameSize {settings.ResponseFrameSize}.";
        }

        if (definition.DataSources.Any(IsRequestResponseBank))
        {
            if (string.IsNullOrWhiteSpace(transportDefaults.WriteCharacteristicUuid))
                return "BLE writeCharacteristicUuid is required for request-response banks.";

            if (settings.RequestFrameSize < 2)
                return "BLE requestFrameSize must be at least 2 bytes for request-response banks.";

            if (settings.RequestPreamble.Count == 0)
                return "BLE requestPreamble is required for request-response banks.";

            if (settings.CommandOffset < 0 || settings.CommandOffset >= settings.RequestFrameSize)
            {
                return $"BLE commandOffset {settings.CommandOffset} must be within requestFrameSize {settings.RequestFrameSize}.";
            }
        }

        return null;
    }

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) ||
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

        var unsupportedReason = GetUnsupportedDefinitionMessage(definition);
        if (unsupportedReason is not null)
            throw new NotSupportedException(
                $"BLE definition '{definition.Device.Id}' is not supported for device '{device.DeviceId}': {unsupportedReason}");

        var session = _sessions.GetOrAdd(device.DeviceId, _ => new BleSession(device.DeviceId));
        await session.Lock.WaitAsync(cancellationToken);
        try
        {
            await EnsureConnectedAsync(
                session,
                device,
                definition,
                cancellationToken,
                requireWriteCharacteristic: DefinitionRequiresWriteCharacteristic(definition));

            var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            var interBankDelay = definition.Connection.Protocol.Settings?.InterBankDelayMs ?? 0;
            var isFirstBank = true;
            foreach (var bank in definition.DataSources)
            {
                var intervalMs = GetBankIntervalMilliseconds(definition, bank);

                if (TryGetFreshCachedPayload(session, bank.Id, intervalMs, out var cachedPayload))
                {
                    bankData[bank.Id] = cachedPayload;
                    isFirstBank = false;
                    continue;
                }

                if (!isFirstBank && interBankDelay > 0)
                    await Task.Delay(interBankDelay, cancellationToken);
                isFirstBank = false;

                try
                {
                    var payload = await ReadBankPayloadAsync(session, definition, bank, cancellationToken);
                    bankData[bank.Id] = payload;
                }
                catch (TimeoutException ex) when (IsOptionalBank(bank))
                {
                    logger.LogWarning(
                        ex,
                        "BLE optional bank read timed out for device {DeviceId}. BankId={BankId}, DefinitionId={DefinitionId}.",
                        device.DeviceId,
                        bank.Id,
                        definition.Device.Id);
                }
            }

            return telemetryBuilder.BuildPollResult(
                definition,
                bankData,
                DateTimeOffset.UtcNow,
                GetLastFrameHex(session));
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            if (!await IsSessionConnectedAsync(session))
            {
                logger.LogInformation(
                    "BLE connection lost for device {DeviceId}. Resetting session.",
                    device.DeviceId);
                await ResetSessionAsync(session);
            }
            else
            {
                logger.LogDebug(
                    "BLE poll error for device {DeviceId} but connection is still alive. Keeping session.",
                    device.DeviceId);
            }

            throw;
        }
        finally
        {
            session.Lock.Release();
        }
    }

    public async Task<WriteRegisterResult> WriteEntityAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        string entityId,
        uint rawValue,
        CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
            throw new PlatformNotSupportedException("BLE writes are supported on Linux/BlueZ only.");

        var unsupportedReason = GetUnsupportedDefinitionMessage(definition);
        if (unsupportedReason is not null)
            throw new NotSupportedException(
                $"BLE definition '{definition.Device.Id}' is not supported for device '{device.DeviceId}': {unsupportedReason}");

        var entity = definition.Entities.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, entityId, StringComparison.OrdinalIgnoreCase) && candidate.Writable);
        if (entity is null)
            throw new ArgumentException($"Writable entity '{entityId}' not found in definition '{definition.Device.Id}'.");

        var bank = definition.DataSources.FirstOrDefault(candidate =>
            string.Equals(candidate.Id, entity.Source.Bank, StringComparison.OrdinalIgnoreCase));
        if (bank is null)
            throw new InvalidOperationException($"BLE bank '{entity.Source.Bank}' was not found for entity '{entityId}'.");
        if (bank.Write is null)
            throw new InvalidOperationException($"BLE bank '{entity.Source.Bank}' does not define a write strategy.");

        var writeUnsupportedReason = GetUnsupportedWriteMessage(definition);
        if (writeUnsupportedReason is not null)
        {
            throw new NotSupportedException(
                $"BLE definition '{definition.Device.Id}' cannot write entity '{entityId}' for device '{device.DeviceId}': {writeUnsupportedReason}");
        }

        var writeTarget = ResolveFrameWriteTarget(entity, bank.Write);
        var session = _sessions.GetOrAdd(device.DeviceId, _ => new BleSession(device.DeviceId));

        await session.Lock.WaitAsync(cancellationToken);
        try
        {
            await EnsureConnectedAsync(
                session,
                device,
                definition,
                cancellationToken,
                requireWriteCharacteristic: true);
            if (session.WriteCharacteristic is null)
            {
                throw new InvalidOperationException(
                    $"Device '{device.DeviceId}' does not expose a writable BLE characteristic for entity '{entityId}'.");
            }

            await SendWriteFrameAsync(session, definition, writeTarget, rawValue, cancellationToken);

            RemoveCachedPayload(session, bank.Id);
            await Task.Delay(150, cancellationToken);

            var payload = await ReadBankPayloadAsync(session, definition, bank, cancellationToken);

            if (!TryReadRawValue(entity, payload, definition.Connection.Protocol.Settings?.ByteOrder, out var readBackValue))
            {
                return new WriteRegisterResult(
                    false,
                    rawValue,
                    null,
                    $"Unable to read back value for entity '{entityId}' after BLE write.");
            }

            var success = readBackValue == rawValue;
            return new WriteRegisterResult(
                success,
                rawValue,
                readBackValue,
                success ? null : $"Read-back mismatch: expected {rawValue}, got {readBackValue}");
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
        CancellationToken cancellationToken,
        bool returnOnFirstMatch = false)
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
        {
            var powerResult = await bluetoothManagementService.SetPowerAsync(enabled: true, cancellationToken);
            if (!powerResult.Success)
                throw new InvalidOperationException(powerResult.Message);
        }

        var devices = new ConcurrentDictionary<string, Device>(StringComparer.OrdinalIgnoreCase);
        var expectedServiceUuid = definition is not null && IsDefinitionSupported(definition)
            ? BlueZManager.NormalizeUUID(
                definition.Connection.Transport.Defaults?.ServiceUuid
                ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE service UUID."))
            : null;
        var matchingAdvertisementSeen = returnOnFirstMatch && expectedServiceUuid is not null
            ? new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)
            : null;

        foreach (var device in await adapter.GetDevicesAsync())
        {
            var key = await GetDiscoveryKeyAsync(device);
            if (!string.IsNullOrWhiteSpace(key))
                devices[key] = device;

            if (matchingAdvertisementSeen is not null &&
                await DeviceAdvertisesServiceUuidAsync(device, expectedServiceUuid!))
            {
                matchingAdvertisementSeen?.TrySetResult();
            }
        }

        async Task OnDeviceFoundAsync(Adapter _, DeviceFoundEventArgs args)
        {
            var key = await GetDiscoveryKeyAsync(args.Device);
            if (!string.IsNullOrWhiteSpace(key))
                devices[key] = args.Device;

            if (matchingAdvertisementSeen is not null &&
                await DeviceAdvertisesServiceUuidAsync(args.Device, expectedServiceUuid!))
            {
                matchingAdvertisementSeen?.TrySetResult();
            }
        }

        using var adapterOperation = await BlueZOperationHelpers.AcquireAdapterOperationLockAsync(cancellationToken);
        adapter.DeviceFound += OnDeviceFoundAsync;
        var startedDiscovery = false;
        try
        {
            startedDiscovery = await BlueZOperationHelpers.TryStartDiscoveryAsync(
                adapter,
                logger,
                "generic-ble-discovery",
                cancellationToken);
            if (matchingAdvertisementSeen is null)
            {
                await Task.Delay(discoveryWindow, cancellationToken);
            }
            else
            {
                var discoveryDelay = Task.Delay(discoveryWindow, cancellationToken);
                var completed = await Task.WhenAny(discoveryDelay, matchingAdvertisementSeen.Task);
                if (completed == matchingAdvertisementSeen.Task)
                {
                    var settleWindow = TimeSpan.FromMilliseconds(Math.Clamp((int)(discoveryWindow.TotalMilliseconds / 4), 250, 1000));
                    await Task.Delay(settleWindow, cancellationToken);
                }
                else
                {
                    await discoveryDelay;
                }
            }
        }
        finally
        {
            adapter.DeviceFound -= OnDeviceFoundAsync;
            await BlueZOperationHelpers.StopDiscoveryIfStartedAsync(
                adapter,
                startedDiscovery,
                logger,
                "generic-ble-discovery");
        }

        var discovered = new List<BleDiscoveredDevice>(devices.Count);
        foreach (var device in devices.Values)
            discovered.Add(await MapDiscoveredDeviceAsync(device));

        if (expectedServiceUuid is not null)
        {
            discovered = discovered
                .Select(device => ApplyAdvertisedServiceVerification(device, expectedServiceUuid))
                .ToList();
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
        CancellationToken cancellationToken,
        bool requireWriteCharacteristic = false)
    {
        var requiresWriteCharacteristic = requireWriteCharacteristic || DefinitionRequiresWriteCharacteristic(definition);
        if (session.Device is not null &&
            string.Equals(session.DefinitionId, definition.Device.Id, StringComparison.OrdinalIgnoreCase) &&
            session.NotifyCharacteristic is not null &&
            (!requiresWriteCharacteristic || session.WriteCharacteristic is not null))
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
        var writeUuid = requiresWriteCharacteristic
            ? BlueZManager.NormalizeUUID(
                transportDefaults.WriteCharacteristicUuid
                ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE write characteristic UUID."))
            : null;
        var target = device.TransportPortName?.Trim();
        if (string.IsNullOrWhiteSpace(target))
            throw new InvalidOperationException($"Device '{device.DeviceId}' has no BLE address or alias configured.");

        var adapter = (await BlueZManager.GetAdaptersAsync()).FirstOrDefault()
            ?? throw new InvalidOperationException("No Bluetooth adapter was found.");

        if (!await adapter.GetAsync<bool>("Powered"))
        {
            var powerResult = await bluetoothManagementService.SetPowerAsync(enabled: true, cancellationToken);
            if (!powerResult.Success)
                throw new InvalidOperationException(powerResult.Message);
        }

        try
        {
            var bleDevice = await ResolveDeviceAsync(adapter, target, timeout, cancellationToken)
                ?? throw new TimeoutException($"Unable to find BLE device '{target}'.");

            using var adapterOperation = await BlueZOperationHelpers.AcquireAdapterOperationLockAsync(cancellationToken);

            await BlueZOperationHelpers.StopDiscoveryIfActiveAsync(
                adapter,
                logger,
                $"connect-device:{target}");

            logger.LogInformation("Connecting to BLE device {Target} for device {DeviceId}.", target, device.DeviceId);
            await BlueZOperationHelpers.EnsureConnectedAsync(
                bleDevice,
                timeout,
                logger,
                $"device={device.DeviceId};target={target}",
                cancellationToken);
            await bleDevice.WaitForPropertyValueAsync("Connected", value: true, timeout);
            await bleDevice.WaitForPropertyValueAsync("ServicesResolved", value: true, timeout);

            var service = await bleDevice.GetServiceAsync(serviceUuid);
            if (service is null)
                throw new InvalidOperationException(
                    $"BLE service '{serviceUuid}' was not found on device '{target}'. Pairing may be required.");

            var characteristics = await service.GetCharacteristicsAsync();
            var notifyCharacteristic = await SelectCharacteristicAsync(characteristics, notifyUuid, requiredFlag: "notify");
            var writeCharacteristic = requiresWriteCharacteristic
                ? await SelectCharacteristicAsync(
                    characteristics,
                    writeUuid!,
                    requiredFlag: "write-without-response",
                    alternateFlag: "write")
                : null;

            if (notifyCharacteristic is null)
                throw new InvalidOperationException($"Notify characteristic '{notifyUuid}' was not found on device '{target}'.");
            if (requiresWriteCharacteristic && writeCharacteristic is null)
                throw new InvalidOperationException($"Write characteristic '{writeUuid}' was not found on device '{target}'.");

            session.Device = bleDevice;
            session.NotifyCharacteristic = notifyCharacteristic;
            session.WriteCharacteristic = writeCharacteristic;
            session.DefinitionId = definition.Device.Id;
            session.NotifyWatcher = await notifyCharacteristic.WatchPropertiesAsync(changes => OnNotifyPropertiesChanged(session, definition, changes));
            await BlueZOperationHelpers.StartNotifyAsync(
                notifyCharacteristic,
                logger,
                $"device={device.DeviceId};target={target}",
                cancellationToken);
            await Task.Delay(150, cancellationToken);

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

    private async Task<byte[]> ReadBankPayloadAsync(
        BleSession session,
        DeviceDefinition definition,
        DataSourceDefinition bank,
        CancellationToken cancellationToken)
    {
        return IsNotifyStreamBank(bank)
            ? await WaitForNotifyStreamPayloadAsync(session, definition, bank, cancellationToken)
            : await RequestFrameAsync(session, definition, bank, cancellationToken);
    }

    private async Task<byte[]> RequestFrameAsync(
        BleSession session,
        DeviceDefinition definition,
        DataSourceDefinition bank,
        CancellationToken cancellationToken)
    {
        if (session.WriteCharacteristic is null)
            throw new InvalidOperationException($"Device '{session.DeviceId}' is not connected to a writable BLE characteristic.");

        var transportDefaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();
        var settings = GetRequiredProtocolSettings(definition);
        var timeout = TimeSpan.FromMilliseconds(Math.Max(transportDefaults.ConnectionTimeoutMs, 1000));
        var retries = Math.Max(settings.Retries, 0);
        var attempts = retries + 1;
        Exception? lastError = null;

        for (var attempt = 1; attempt <= attempts; attempt++)
        {
            var pendingRead = RegisterPendingRead(session, bank.Id);

            try
            {
                var commandFrame = BuildBleRequestCommand(bank.Command, settings);
                var options = new Dictionary<string, object>
                {
                    ["type"] = await SelectWriteTypeAsync(session.WriteCharacteristic)
                };

                logger.LogDebug(
                    "Sending BLE command 0x{Command:X2} expecting frame type 0x{FrameType:X2} for device {DeviceId}. Attempt {Attempt}/{Attempts}.",
                    bank.Command,
                    bank.ResponseFrameType,
                    session.DeviceId,
                    attempt,
                    attempts);

                await session.WriteCharacteristic.WriteValueAsync(commandFrame, options);
                return await WaitForPendingReadAsync(session, bank, pendingRead, timeout, cancellationToken);
            }
            catch (Exception ex) when (!cancellationToken.IsCancellationRequested && attempt < attempts)
            {
                lastError = ex;
                logger.LogDebug(
                    ex,
                    "BLE command retry scheduled for device {DeviceId}. Command=0x{Command:X2}, FrameType=0x{FrameType:X2}, Attempt={Attempt}/{Attempts}.",
                    session.DeviceId,
                    bank.Command,
                    bank.ResponseFrameType,
                    attempt,
                    attempts);
                await Task.Delay(150, cancellationToken);
            }
            finally
            {
                ClearPendingRead(session, bank.Id, pendingRead);
            }
        }

        throw lastError ?? new TimeoutException(
            $"Timed out waiting for BLE frame type 0x{bank.ResponseFrameType:X2} from device '{session.DeviceId}'.");
    }

    private async Task<byte[]> WaitForNotifyStreamPayloadAsync(
        BleSession session,
        DeviceDefinition definition,
        DataSourceDefinition bank,
        CancellationToken cancellationToken)
    {
        var transportDefaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();
        var intervalMs = GetBankIntervalMilliseconds(definition, bank);
        var timeout = GetNotifyStreamWaitTimeout(
            TimeSpan.FromMilliseconds(Math.Max(transportDefaults.ConnectionTimeoutMs, 1000)),
            intervalMs);
        var pendingRead = RegisterPendingRead(session, bank.Id);

        try
        {
            if (TryGetFreshCachedPayload(session, bank.Id, intervalMs, out var cachedPayload))
                return cachedPayload;

            logger.LogDebug(
                "Waiting for BLE notify-stream frame type 0x{FrameType:X2} for device {DeviceId}. BankId={BankId}.",
                bank.ResponseFrameType,
                session.DeviceId,
                bank.Id);

            try
            {
                return await WaitForPendingReadAsync(session, bank, pendingRead, timeout, cancellationToken);
            }
            catch (TimeoutException) when (session.WriteCharacteristic is not null)
            {
                if (!SupportsNotifyStreamRequestFallback(bank) ||
                    !TryMarkNotifyStreamFallbackIssued(session, bank.Id))
                {
                    throw;
                }

                logger.LogDebug(
                    "BLE notify-stream frame type 0x{FrameType:X2} did not arrive in time for device {DeviceId}. Issuing one-time request-response fallback for bank {BankId}.",
                    bank.ResponseFrameType,
                    session.DeviceId,
                    bank.Id);
            }

            return await RequestFrameAsync(session, definition, bank, cancellationToken);
        }
        finally
        {
            ClearPendingRead(session, bank.Id, pendingRead);
        }
    }

    private void OnNotifyPropertiesChanged(BleSession session, DeviceDefinition definition, PropertyChanges changes)
    {
        var changedValue = changes.Changed
            .FirstOrDefault(pair => string.Equals(pair.Key, "Value", StringComparison.Ordinal))
            .Value;
        if (changedValue is not byte[] chunk || chunk.Length == 0)
            return;

        var settings = GetRequiredProtocolSettings(definition);
        var completedReads = new List<(TaskCompletionSource<BankCacheEntry> PendingRead, BankCacheEntry CacheEntry)>();
        var receivedUnmappedFrameTypes = new HashSet<byte>();
        var discardedInvalidFrame = false;
        var discardedFrameType = false;

        lock (session.SyncRoot)
        {
            session.FrameBuffer.AddRange(chunk);

            while (true)
            {
                var extracted = TryExtractValidatedFrame(
                    session.FrameBuffer,
                    settings.ResponseFrameSize,
                    settings.ResponsePreamble,
                    settings.ChecksumType,
                    out var candidate,
                    out var discardedCurrentFrame);
                discardedInvalidFrame |= discardedCurrentFrame;
                if (!extracted)
                    break;

                if (candidate is null)
                    continue;

                session.LastFrameHex = Convert.ToHexString(candidate);
                if (!TryGetFrameType(candidate, settings, out var frameType))
                {
                    discardedFrameType = true;
                    continue;
                }

                var matchedBanks = definition.DataSources
                    .Where(bank => bank.ResponseFrameType == frameType)
                    .DistinctBy(bank => bank.Id, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
                if (matchedBanks.Length == 0)
                {
                    receivedUnmappedFrameTypes.Add(frameType);
                    continue;
                }

                var timestamp = DateTimeOffset.UtcNow;
                foreach (var bank in matchedBanks)
                {
                    var cacheEntry = new BankCacheEntry(timestamp, ExtractPayload(candidate, bank, settings.ResponseFooterSize));
                    session.BankCache[bank.Id] = cacheEntry;

                    if (session.PendingReads.Remove(bank.Id, out var pendingRead))
                        completedReads.Add((pendingRead, cacheEntry));
                }
            }
        }

        foreach (var completedRead in completedReads)
            completedRead.PendingRead.TrySetResult(completedRead.CacheEntry);

        if (discardedInvalidFrame)
            logger.LogWarning("Discarded BLE frame with invalid checksum for device {DeviceId}.", session.DeviceId);
        if (discardedFrameType)
        {
            logger.LogWarning(
                "Discarded BLE frame with invalid frame-type offset for device {DeviceId}. DefinitionId={DefinitionId}.",
                session.DeviceId,
                definition.Device.Id);
        }

        foreach (var frameType in receivedUnmappedFrameTypes)
        {
            logger.LogDebug(
                "Received BLE frame type 0x{FrameType:X2} with no mapped data source for device {DeviceId}.",
                frameType,
                session.DeviceId);
        }
    }

    private static byte[] ExtractPayload(byte[] frame, DataSourceDefinition bank, int footerSize)
    {
        var headerSize = Math.Max(bank.HeaderSize, 0);
        var trailingBytes = Math.Max(footerSize, 0);
        if (headerSize + trailingBytes >= frame.Length)
            return [];

        var payloadLength = frame.Length - headerSize - trailingBytes;
        return frame.AsSpan(headerSize, payloadLength).ToArray();
    }

    internal static bool TryExtractValidatedFrame(
        List<byte> buffer,
        int expectedFrameSize,
        IReadOnlyList<byte> preamble,
        string checksumType,
        out byte[]? frame,
        out bool discardedInvalidFrame)
    {
        ArgumentNullException.ThrowIfNull(buffer);
        ArgumentNullException.ThrowIfNull(preamble);

        frame = null;
        discardedInvalidFrame = false;

        if (expectedFrameSize <= 0 || preamble.Count == 0)
            return false;

        while (buffer.Count > 0)
        {
            var preambleIndex = IndexOfFramePreamble(buffer, preamble);
            if (preambleIndex < 0)
            {
                var trailingBytesToKeep = Math.Max(preamble.Count - 1, 0);
                if (buffer.Count > trailingBytesToKeep)
                    buffer.RemoveRange(0, buffer.Count - trailingBytesToKeep);
                return false;
            }

            if (preambleIndex > 0)
                buffer.RemoveRange(0, preambleIndex);

            if (buffer.Count < expectedFrameSize)
                return false;

            var candidate = buffer.Take(expectedFrameSize).ToArray();
            if (TryValidateFrame(candidate, checksumType))
            {
                frame = candidate;
                buffer.RemoveRange(0, expectedFrameSize);
                return true;
            }

            discardedInvalidFrame = true;
            var nextPreambleIndex = IndexOfFramePreamble(buffer, preamble, 1);
            if (nextPreambleIndex > 0)
                buffer.RemoveRange(0, nextPreambleIndex);
            else
                buffer.RemoveAt(0);
        }

        return false;
    }

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

    private static int IndexOfFramePreamble(IReadOnlyList<byte> data, IReadOnlyList<byte> preamble, int startIndex = 0)
    {
        if (preamble.Count == 0 || data.Count < preamble.Count)
            return -1;

        for (var i = Math.Max(startIndex, 0); i <= data.Count - preamble.Count; i++)
        {
            var matched = true;
            for (var j = 0; j < preamble.Count; j++)
            {
                if (data[i + j] == preamble[j])
                    continue;

                matched = false;
                break;
            }

            if (matched)
                return i;
        }

        return -1;
    }

    internal static byte[] BuildBleRequestCommand(byte command, ProtocolSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);

        var frame = CreateRequestFrame(settings);
        ValidateFrameOffset(settings.CommandOffset, frame.Length, nameof(settings.CommandOffset));
        frame[settings.CommandOffset] = command;
        ApplyChecksum(frame, settings.ChecksumType);
        return frame;
    }

    internal static BleFrameWriteTarget ResolveFrameWriteTarget(
        EntityDefinition entity,
        DataSourceWriteDefinition writeDefinition)
    {
        ArgumentNullException.ThrowIfNull(entity);
        ArgumentNullException.ThrowIfNull(writeDefinition);

        if (!string.Equals(writeDefinition.Type, "frame-register", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"Entity '{entity.Id}' uses BLE write strategy '{writeDefinition.Type}', which is not supported by this protocol handler.");
        }

        var valueLength = entity.Write?.ValueLength ?? writeDefinition.ValueLength ?? GetDataTypeSize(entity.Source.DataType);
        if (valueLength <= 0)
            throw new InvalidOperationException($"Entity '{entity.Id}' uses unsupported data type '{entity.Source.DataType}' for BLE writes.");

        var address = entity.Write?.Address;
        if (!address.HasValue)
        {
            if (writeDefinition.AddressStepBytes <= 0)
                throw new InvalidOperationException($"Entity '{entity.Id}' uses an invalid BLE write addressStepBytes value.");

            if (entity.Source.ByteOffset < 0 || entity.Source.ByteOffset % writeDefinition.AddressStepBytes != 0)
            {
                throw new InvalidOperationException(
                    $"Entity '{entity.Id}' has byte offset {entity.Source.ByteOffset}, which cannot be mapped using the configured BLE write strategy.");
            }

            address = writeDefinition.AddressBase + (entity.Source.ByteOffset / writeDefinition.AddressStepBytes);
        }

        if (address <= 0 || address > byte.MaxValue)
        {
            throw new InvalidOperationException(
                $"Entity '{entity.Id}' resolved to BLE register {address}, which is outside the supported range.");
        }

        if (valueLength > byte.MaxValue)
            throw new InvalidOperationException($"Entity '{entity.Id}' resolved to BLE value length {valueLength}, which is outside the supported range.");

        return new((byte)address.Value, (byte)valueLength);
    }

    internal static byte[] BuildBleFrameWriteCommand(BleFrameWriteTarget target, uint value, ProtocolSettings settings)
    {
        ArgumentNullException.ThrowIfNull(settings);

        if (target.ValueLength <= 0 || target.ValueLength > sizeof(uint))
        {
            throw new InvalidOperationException(
                $"BLE write value length {target.ValueLength} is outside the supported range for 32-bit raw values.");
        }

        var frame = CreateRequestFrame(settings);
        ValidateFrameOffset(settings.WriteRegisterOffset, frame.Length, nameof(settings.WriteRegisterOffset));
        ValidateFrameOffset(settings.WriteValueLengthOffset, frame.Length, nameof(settings.WriteValueLengthOffset));
        ValidateFrameOffset(settings.WriteValueOffset, frame.Length, nameof(settings.WriteValueOffset));

        var valueEndOffset = settings.WriteValueOffset + target.ValueLength;
        if (valueEndOffset > frame.Length)
        {
            throw new InvalidOperationException(
                $"BLE write value offset {settings.WriteValueOffset} with length {target.ValueLength} exceeds request frame length {frame.Length}.");
        }

        frame[settings.WriteRegisterOffset] = target.RegisterAddress;
        frame[settings.WriteValueLengthOffset] = target.ValueLength;
        WriteRawValue(frame.AsSpan(settings.WriteValueOffset, target.ValueLength), value, settings.WriteValueByteOrder);
        ApplyChecksum(frame, settings.ChecksumType);
        return frame;
    }

    private static byte ComputeSum8(ReadOnlySpan<byte> data)
    {
        byte checksum = 0;
        foreach (var value in data)
            checksum += value;

        return checksum;
    }

    private async Task SendWriteFrameAsync(
        BleSession session,
        DeviceDefinition definition,
        BleFrameWriteTarget target,
        uint rawValue,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (session.WriteCharacteristic is null)
            throw new InvalidOperationException($"Device '{session.DeviceId}' is not connected to a writable BLE characteristic.");

        var frame = BuildBleFrameWriteCommand(target, rawValue, GetRequiredProtocolSettings(definition));
        var options = new Dictionary<string, object>
        {
            ["type"] = await SelectWriteTypeAsync(session.WriteCharacteristic)
        };

        logger.LogInformation(
            "Sending BLE frame write for device {DeviceId}. Register=0x{Register:X2}, Length={Length}, Value={Value}.",
            session.DeviceId,
            target.RegisterAddress,
            target.ValueLength,
            rawValue);

        await session.WriteCharacteristic.WriteValueAsync(frame, options);
    }

    private static ProtocolSettings GetRequiredProtocolSettings(DeviceDefinition definition)
        => definition.Connection.Protocol.Settings
           ?? throw new InvalidOperationException($"Definition '{definition.Device.Id}' has no BLE protocol settings.");

    private static string? GetUnsupportedWriteMessage(DeviceDefinition definition)
    {
        var transportDefaults = definition.Connection.Transport.Defaults;
        if (transportDefaults is null)
            return "BLE transport defaults are required.";

        if (string.IsNullOrWhiteSpace(transportDefaults.WriteCharacteristicUuid))
            return "BLE writeCharacteristicUuid is required for BLE writes.";

        var settings = definition.Connection.Protocol.Settings;
        if (settings is null)
            return "BLE protocol settings are required.";

        if (settings.RequestFrameSize < 2)
            return "BLE requestFrameSize must be at least 2 bytes for BLE writes.";

        if (settings.RequestPreamble.Count == 0)
            return "BLE requestPreamble is required for BLE writes.";

        if (!IsSupportedBleChecksum(settings.ChecksumType))
            return $"BLE checksumType '{settings.ChecksumType}' is not supported.";

        if (settings.WriteRegisterOffset < 0 || settings.WriteRegisterOffset >= settings.RequestFrameSize)
        {
            return $"BLE writeRegisterOffset {settings.WriteRegisterOffset} must be within requestFrameSize {settings.RequestFrameSize}.";
        }

        if (settings.WriteValueLengthOffset < 0 || settings.WriteValueLengthOffset >= settings.RequestFrameSize)
        {
            return $"BLE writeValueLengthOffset {settings.WriteValueLengthOffset} must be within requestFrameSize {settings.RequestFrameSize}.";
        }

        if (settings.WriteValueOffset < 0 || settings.WriteValueOffset >= settings.RequestFrameSize)
        {
            return $"BLE writeValueOffset {settings.WriteValueOffset} must be within requestFrameSize {settings.RequestFrameSize}.";
        }

        return null;
    }

    private static bool DefinitionRequiresWriteCharacteristic(DeviceDefinition definition)
        => definition.DataSources.Any(IsRequestResponseBank);

    private static bool IsRequestResponseBank(DataSourceDefinition bank)
        => string.Equals(NormalizeReadMode(bank.ReadMode), "request-response", StringComparison.Ordinal);

    private static bool IsNotifyStreamBank(DataSourceDefinition bank)
        => string.Equals(NormalizeReadMode(bank.ReadMode), "notify-stream", StringComparison.Ordinal);

    internal static bool SupportsNotifyStreamRequestFallback(DataSourceDefinition bank)
        => bank.Command != 0;

    internal static BleDiscoveredDevice ApplyAdvertisedServiceVerification(BleDiscoveredDevice device, string serviceUuid)
    {
        ArgumentNullException.ThrowIfNull(device);
        ArgumentException.ThrowIfNullOrWhiteSpace(serviceUuid);

        var isMatch = device.AdvertisedServiceUuids.Contains(serviceUuid, StringComparer.OrdinalIgnoreCase);
        return device with
        {
            IsDefinitionVerified = isMatch,
            VerificationLabel = isMatch ? "Service match" : null,
            VerificationDetails = isMatch ? "Advertises the expected BLE service." : null
        };
    }

    private static async Task<bool> DeviceAdvertisesServiceUuidAsync(Device device, string serviceUuid)
    {
        ArgumentNullException.ThrowIfNull(device);
        ArgumentException.ThrowIfNullOrWhiteSpace(serviceUuid);

        var advertisedServiceUuids = DescribeStringSequence(await SafeGetObjectAsync(() => device.GetUUIDsAsync()));
        return advertisedServiceUuids.Contains(serviceUuid, StringComparer.OrdinalIgnoreCase);
    }

    private static bool IsSupportedReadMode(string? readMode)
    {
        var normalized = NormalizeReadMode(readMode);
        return string.Equals(normalized, "request-response", StringComparison.Ordinal) ||
               string.Equals(normalized, "notify-stream", StringComparison.Ordinal);
    }

    private static bool IsSupportedBleChecksum(string? checksumType)
        => checksumType?.Trim().ToLowerInvariant() is "sum8" or "none";

    private static string NormalizeReadMode(string? readMode)
        => string.IsNullOrWhiteSpace(readMode)
            ? "request-response"
            : readMode.Trim().ToLowerInvariant();

    private static int GetBankIntervalMilliseconds(DeviceDefinition definition, DataSourceDefinition bank)
        => definition.PollGroups.GetValueOrDefault(bank.PollGroup)?.IntervalMs ?? 1000;

    internal static TimeSpan GetNotifyStreamWaitTimeout(TimeSpan connectionTimeout, int intervalMs)
    {
        var intervalTimeout = TimeSpan.FromMilliseconds(Math.Max(intervalMs, 1) * 2L);
        var boundedIntervalTimeout = intervalTimeout < TimeSpan.FromMilliseconds(1500)
            ? TimeSpan.FromMilliseconds(1500)
            : intervalTimeout;

        return boundedIntervalTimeout <= connectionTimeout
            ? boundedIntervalTimeout
            : connectionTimeout;
    }

    private static bool TryGetFreshCachedPayload(
        BleSession session,
        string bankId,
        int intervalMs,
        out byte[] payload)
    {
        lock (session.SyncRoot)
        {
            // intervalMs <= 0 means "cache until reconnection" — once read, the
            // payload stays valid until the session is reset (e.g. on disconnect).
            if (session.BankCache.TryGetValue(bankId, out var cached) &&
                (intervalMs <= 0 || DateTimeOffset.UtcNow - cached.LastRead < TimeSpan.FromMilliseconds(intervalMs)))
            {
                payload = cached.Data;
                return true;
            }
        }

        payload = [];
        return false;
    }

    private static bool TryMarkNotifyStreamFallbackIssued(BleSession session, string bankId)
    {
        lock (session.SyncRoot)
        {
            return session.NotifyStreamFallbackIssued.Add(bankId);
        }
    }

    private static void RemoveCachedPayload(BleSession session, string bankId)
    {
        lock (session.SyncRoot)
        {
            session.BankCache.Remove(bankId);
        }
    }

    private static TaskCompletionSource<BankCacheEntry> RegisterPendingRead(BleSession session, string bankId)
    {
        TaskCompletionSource<BankCacheEntry>? previousPendingRead = null;
        TaskCompletionSource<BankCacheEntry> pendingRead;

        lock (session.SyncRoot)
        {
            if (session.PendingReads.TryGetValue(bankId, out previousPendingRead))
                session.PendingReads.Remove(bankId);

            pendingRead = new(TaskCreationOptions.RunContinuationsAsynchronously);
            session.PendingReads[bankId] = pendingRead;
        }

        previousPendingRead?.TrySetCanceled();
        return pendingRead;
    }

    private static void ClearPendingRead(
        BleSession session,
        string bankId,
        TaskCompletionSource<BankCacheEntry> pendingRead)
    {
        lock (session.SyncRoot)
        {
            if (session.PendingReads.TryGetValue(bankId, out var existingPendingRead) &&
                ReferenceEquals(existingPendingRead, pendingRead))
            {
                session.PendingReads.Remove(bankId);
            }
        }
    }

    private static async Task<byte[]> WaitForPendingReadAsync(
        BleSession session,
        DataSourceDefinition bank,
        TaskCompletionSource<BankCacheEntry> pendingRead,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var timeoutTask = Task.Delay(timeout, timeoutCts.Token);
        var completed = await Task.WhenAny(pendingRead.Task, timeoutTask);
        if (completed != pendingRead.Task)
        {
            var lastFrameHex = GetLastFrameHex(session);
            var suffix = string.IsNullOrWhiteSpace(lastFrameHex)
                ? string.Empty
                : $" Last valid frame={lastFrameHex}.";
            throw new TimeoutException(
                $"Timed out waiting for BLE frame type 0x{bank.ResponseFrameType:X2} from device '{session.DeviceId}'.{suffix}");
        }

        timeoutCts.Cancel();
        return (await pendingRead.Task).Data;
    }

    private static bool TryGetFrameType(byte[] frame, ProtocolSettings settings, out byte frameType)
    {
        if (settings.ResponseFrameTypeOffset < 0 || settings.ResponseFrameTypeOffset >= frame.Length)
        {
            frameType = 0;
            return false;
        }

        frameType = frame[settings.ResponseFrameTypeOffset];
        return true;
    }

    private static byte[] CreateRequestFrame(ProtocolSettings settings)
    {
        if (settings.RequestFrameSize < 2)
            throw new InvalidOperationException($"BLE requestFrameSize {settings.RequestFrameSize} is invalid.");
        if (settings.RequestPreamble.Count == 0)
            throw new InvalidOperationException("BLE requestPreamble is required.");
        if (settings.RequestPreamble.Count > settings.RequestFrameSize)
        {
            throw new InvalidOperationException(
                $"BLE requestPreamble length {settings.RequestPreamble.Count} exceeds request frame size {settings.RequestFrameSize}.");
        }

        var frame = new byte[settings.RequestFrameSize];
        for (var i = 0; i < settings.RequestPreamble.Count; i++)
            frame[i] = settings.RequestPreamble[i];

        return frame;
    }

    private static void ApplyChecksum(byte[] frame, string checksumType)
    {
        if (frame.Length == 0)
            return;

        switch (checksumType.Trim().ToLowerInvariant())
        {
            case "sum8":
                frame[^1] = ComputeSum8(frame.AsSpan(0, frame.Length - 1));
                break;
            case "none":
                break;
            default:
                throw new InvalidOperationException($"BLE checksum type '{checksumType}' is not supported.");
        }
    }

    private static void ValidateFrameOffset(int offset, int frameLength, string name)
    {
        if (offset < 0 || offset >= frameLength)
            throw new InvalidOperationException($"BLE {name} {offset} is outside request frame length {frameLength}.");
    }

    private static void WriteRawValue(Span<byte> destination, uint value, string? byteOrder)
    {
        var littleEndian = !string.Equals(byteOrder, "big-endian", StringComparison.OrdinalIgnoreCase);
        for (var index = 0; index < destination.Length; index++)
        {
            var shift = littleEndian
                ? index * 8
                : (destination.Length - 1 - index) * 8;
            destination[index] = (byte)(value >> shift);
        }
    }

    internal static bool TryReadRawValue(
        EntityDefinition entity,
        byte[] payload,
        string? byteOrder,
        out uint rawValue)
    {
        ArgumentNullException.ThrowIfNull(entity);
        ArgumentNullException.ThrowIfNull(payload);

        rawValue = 0;
        var offset = entity.Source.ByteOffset;
        if (offset < 0 || offset >= payload.Length)
            return false;

        var littleEndian = !string.Equals(byteOrder, "big-endian", StringComparison.OrdinalIgnoreCase);
        switch (entity.Source.DataType.ToLowerInvariant())
        {
            case "uint8":
                rawValue = payload[offset];
                return true;

            case "int8":
                rawValue = unchecked((uint)(sbyte)payload[offset]);
                return true;

            case "uint16" when offset + 2 <= payload.Length:
                rawValue = littleEndian
                    ? BinaryPrimitives.ReadUInt16LittleEndian(payload.AsSpan(offset, 2))
                    : BinaryPrimitives.ReadUInt16BigEndian(payload.AsSpan(offset, 2));
                return true;

            case "int16" when offset + 2 <= payload.Length:
                rawValue = unchecked((ushort)(littleEndian
                    ? BinaryPrimitives.ReadInt16LittleEndian(payload.AsSpan(offset, 2))
                    : BinaryPrimitives.ReadInt16BigEndian(payload.AsSpan(offset, 2))));
                return true;

            case "uint32" when offset + 4 <= payload.Length:
                rawValue = littleEndian
                    ? BinaryPrimitives.ReadUInt32LittleEndian(payload.AsSpan(offset, 4))
                    : BinaryPrimitives.ReadUInt32BigEndian(payload.AsSpan(offset, 4));
                return true;

            case "int32" when offset + 4 <= payload.Length:
                rawValue = unchecked((uint)(littleEndian
                    ? BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(offset, 4))
                    : BinaryPrimitives.ReadInt32BigEndian(payload.AsSpan(offset, 4))));
                return true;

            default:
                return false;
        }
    }

    private static int GetDataTypeSize(string? dataType)
        => dataType?.Trim().ToLowerInvariant() switch
        {
            "uint8" or "int8" => 1,
            "uint16" or "int16" => 2,
            "uint32" or "int32" => 4,
            _ => 0
        };

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

    private async Task<Device?> ResolveDeviceAsync(
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
        var startedDiscovery = false;
        try
        {
            startedDiscovery = await BlueZOperationHelpers.TryStartDiscoveryAsync(
                adapter,
                logger,
                $"resolve-device:{identifier}",
                cancellationToken);
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
            await BlueZOperationHelpers.StopDiscoveryIfStartedAsync(
                adapter,
                startedDiscovery,
                logger,
                $"resolve-device:{identifier}");
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
        var address = await SafeGetStringAsync(() => device.GetAddressAsync());
        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        var name = await SafeGetStringAsync(() => device.GetNameAsync());
        return IdentifierMatches(identifier, address, alias, name);
    }

    internal static bool IdentifierMatches(string identifier, params string?[] candidates)
    {
        if (string.IsNullOrWhiteSpace(identifier))
            return false;

        var target = identifier.Trim();
        var normalizedTarget = NormalizeIdentifier(target);

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate))
                continue;

            var value = candidate.Trim();
            if (string.Equals(value, target, StringComparison.OrdinalIgnoreCase))
                return true;

            if (!string.IsNullOrEmpty(normalizedTarget) &&
                string.Equals(NormalizeIdentifier(value), normalizedTarget, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (value.Contains(target, StringComparison.OrdinalIgnoreCase))
                return true;
        }

        return false;
    }

    private static async Task<string?> GetDiscoveryKeyAsync(Device device)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync());
        if (!string.IsNullOrWhiteSpace(address))
            return address;

        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        if (!string.IsNullOrWhiteSpace(alias))
            return alias;

        return await SafeGetStringAsync(() => device.GetNameAsync());
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
            var probeBanks = GetProbeBanks(definition).ToArray();
            await EnsureConnectedAsync(
                session,
                probeConfig,
                definition,
                probeCts.Token,
                requireWriteCharacteristic: probeBanks.Any(IsRequestResponseBank));

            if (probeBanks.Length == 0)
            {
                logger.LogWarning(
                    "BLE probe could not find a readable data source for address {Address} and definition {DefinitionId}.",
                    address,
                    definition.Device.Id);
                return new(false, null, "Probe could not find a readable BLE data source.");
            }

            // Check if any bank was already populated from unsolicited notifications during connection setup.
            lock (session.SyncRoot)
            {
                foreach (var bank in definition.DataSources)
                {
                    if (session.BankCache.ContainsKey(bank.Id))
                    {
                        var details = $"{bank.Name} auto-detected from unsolicited BLE notification.";
                        logger.LogInformation(
                            "BLE probe verified address {Address} for definition {DefinitionId} via unsolicited frame. BankId={BankId}.",
                            address,
                            definition.Device.Id,
                            bank.Id);
                        return new(true, "Verified BLE device", details);
                    }
                }
            }

            var failures = new List<string>();
            foreach (var bank in probeBanks)
            {
                try
                {
                    _ = await ReadBankPayloadAsync(session, definition, bank, probeCts.Token);
                    var details = $"{bank.Name} ({NormalizeReadMode(bank.ReadMode)}) responded successfully.";
                    return new(true, "Verified BLE device", details);
                }
                catch (TimeoutException ex) when (!probeCts.IsCancellationRequested)
                {
                    failures.Add($"{bank.Id}: {ex.Message}");
                }
            }

            return new(false, null, string.Join(" ", failures));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(
                "BLE probe timed out for address {Address} and definition {DefinitionId}.",
                address,
                definition.Device.Id);
            return new(false, null, "BLE probe timed out.");
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "BLE probe failed for address {Address} and definition {DefinitionId}.",
                address,
                definition.Device.Id);
            return new(false, null, $"BLE probe failed: {ex.Message}");
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

    private static string NormalizeIdentifier(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            return string.Empty;

        return new string(value
            .Where(char.IsLetterOrDigit)
            .Select(char.ToUpperInvariant)
            .ToArray());
    }

    private static IEnumerable<DataSourceDefinition> GetProbeBanks(DeviceDefinition definition)
    {
        return definition.DataSources
            .OrderBy(bank => IsOptionalBank(bank) ? 1 : 0)
            .ThenBy(bank => IsRequestResponseBank(bank) ? 1 : 0)
            .ThenBy(bank => GetBankIntervalMilliseconds(definition, bank))
            .DistinctBy(bank => bank.Id, StringComparer.OrdinalIgnoreCase);
    }

    private static bool IsOptionalBank(DataSourceDefinition bank)
        => bank.Optional;

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

    private static async Task<bool> IsSessionConnectedAsync(BleSession session)
    {
        if (session.Device is null)
            return false;
        try
        {
            return await session.Device.GetAsync<bool>("Connected");
        }
        catch
        {
            return false;
        }
    }

    private static async Task ResetSessionAsync(BleSession session)
    {
        TaskCompletionSource<BankCacheEntry>[] pendingReads;
        lock (session.SyncRoot)
        {
            pendingReads = session.PendingReads.Values.ToArray();
            session.PendingReads.Clear();
            session.FrameBuffer.Clear();
            session.BankCache.Clear();
            session.NotifyStreamFallbackIssued.Clear();
            session.LastFrameHex = string.Empty;
        }

        foreach (var pendingRead in pendingReads)
            pendingRead.TrySetCanceled();

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
        session.DefinitionId = null;
    }

    private static string GetLastFrameHex(BleSession session)
    {
        lock (session.SyncRoot)
        {
            return session.LastFrameHex;
        }
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
        public string? DefinitionId { get; set; }
        public Device? Device { get; set; }
        public IGattCharacteristic1? NotifyCharacteristic { get; set; }
        public IGattCharacteristic1? WriteCharacteristic { get; set; }
        public IDisposable? NotifyWatcher { get; set; }
        public List<byte> FrameBuffer { get; } = [];
        public Dictionary<string, BankCacheEntry> BankCache { get; } = new(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> NotifyStreamFallbackIssued { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, TaskCompletionSource<BankCacheEntry>> PendingReads { get; } = new(StringComparer.OrdinalIgnoreCase);
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
    string? VerificationDetails,
    DateTimeOffset? LastSeenAt = null,
    int? SignalStrengthPercent = null,
    decimal? TemperatureCelsius = null,
    decimal? HumidityPercent = null,
    int? BatteryPercent = null);

public sealed record BleProbeResult(
    bool IsDefinitionVerified,
    string? VerificationLabel,
    string? VerificationDetails);

internal sealed record BleFrameWriteTarget(
    byte RegisterAddress,
    byte ValueLength);

internal sealed record BankCacheEntry(
    DateTimeOffset LastRead,
    byte[] Data);
