using System.Buffers.Binary;
using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Linux.Bluetooth;
using Linux.Bluetooth.Extensions;
using Org.BouncyCastle.Asn1.Sec;
using Org.BouncyCastle.Crypto.Agreement;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Security;
using Tmds.DBus;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

public sealed class EcoFlowBlePollingClient(
    DefinitionDrivenTelemetryBuilder telemetryBuilder,
    DeviceDefinitionLoader definitionLoader,
    BluetoothManagementService bluetoothManagementService,
    ILogger<EcoFlowBlePollingClient> logger) : IDevicePollingClient, IDisposable
{
    public const string ProtocolType = "ecoflow-ble";

    private const byte AuthDst = 0x35;
    private const string DisplayBankId = "display";
    private static readonly TimeSpan MinFreshTelemetryAge = TimeSpan.FromMilliseconds(250);
    private readonly Dictionary<string, EcoFlowSession> _sessions = new(StringComparer.OrdinalIgnoreCase);
    private bool _disposed;

    public static bool IsDefinitionSupported(DeviceDefinition definition)
        => GetUnsupportedDefinitionMessage(definition) is null;

    public static string? GetUnsupportedDefinitionMessage(DeviceDefinition definition)
    {
        if (!string.Equals(definition.Connection.Transport.Type, "ble", StringComparison.OrdinalIgnoreCase))
            return $"Transport type '{definition.Connection.Transport.Type}' is not supported by the EcoFlow BLE client.";

        if (!string.Equals(definition.Connection.Protocol.Type, ProtocolType, StringComparison.OrdinalIgnoreCase))
            return $"Protocol type '{definition.Connection.Protocol.Type}' is not supported by the EcoFlow BLE client.";

        var defaults = definition.Connection.Transport.Defaults;
        if (defaults is null)
            return "BLE transport defaults are required.";
        if (string.IsNullOrWhiteSpace(defaults.ServiceUuid))
            return "BLE serviceUuid is required.";
        if (string.IsNullOrWhiteSpace(defaults.NotifyCharacteristicUuid))
            return "BLE notifyCharacteristicUuid is required.";
        if (string.IsNullOrWhiteSpace(defaults.WriteCharacteristicUuid))
            return "BLE writeCharacteristicUuid is required.";
        if (!definition.DataSources.Any(source => string.Equals(source.Id, DisplayBankId, StringComparison.OrdinalIgnoreCase)))
            return $"EcoFlow BLE definitions must include a '{DisplayBankId}' data source.";

        return null;
    }

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
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
        var unsupported = GetUnsupportedDefinitionMessage(definition);
        if (unsupported is not null)
            throw new NotSupportedException(
                $"EcoFlow BLE definition '{definition.Device.Id}' is not supported for device '{device.DeviceId}': {unsupported}");

        if (string.IsNullOrWhiteSpace(device.ProtocolUserId))
            throw new InvalidOperationException($"Device '{device.DeviceId}' needs a protocol user ID.");

        var session = GetSession(device.DeviceId);
        await session.Lock.WaitAsync(cancellationToken);
        try
        {
            await EnsureConnectedAndAuthenticatedAsync(session, device, definition, cancellationToken);

            var timeoutMs = Math.Max(definition.Connection.Transport.Defaults?.ConnectionTimeoutMs ?? 20000, 3000);
            var payload = await WaitForTelemetryAsync(session, timeoutMs, cancellationToken);
            var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase)
            {
                [DisplayBankId] = payload
            };

            return telemetryBuilder.BuildPollResult(
                definition,
                bankData,
                DateTimeOffset.UtcNow,
                session.LastRawFrameHex);
        }
        catch
        {
            await ResetSessionAsync(session);
            throw;
        }
        finally
        {
            session.Lock.Release();
        }
    }

    private EcoFlowSession GetSession(string deviceId)
    {
        lock (_sessions)
        {
            if (!_sessions.TryGetValue(deviceId, out var session))
            {
                session = new EcoFlowSession(deviceId);
                _sessions.Add(deviceId, session);
            }

            return session;
        }
    }

    private async Task EnsureConnectedAndAuthenticatedAsync(
        EcoFlowSession session,
        DeviceConfiguration device,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        if (await IsSessionUsableAsync(session, definition))
            return;

        await ResetSessionAsync(session);
        session.UserId = device.ProtocolUserId?.Trim() ?? string.Empty;

        var defaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();
        var timeout = TimeSpan.FromMilliseconds(Math.Max(defaults.ConnectionTimeoutMs, 5000));
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

        var bleDevice = await ResolveDeviceAsync(adapter, target, timeout, cancellationToken)
            ?? throw new TimeoutException($"Unable to find BLE device '{target}'.");

        using var adapterOperation = await BlueZOperationHelpers.AcquireAdapterOperationLockAsync(cancellationToken);
        await BlueZOperationHelpers.StopDiscoveryIfActiveAsync(adapter, logger, $"ecoflow-connect:{target}");
        await BlueZOperationHelpers.EnsureConnectedAsync(
            bleDevice,
            timeout,
            logger,
            $"device={device.DeviceId};target={target};protocol=ecoflow",
            cancellationToken);
        await bleDevice.WaitForPropertyValueAsync("Connected", value: true, timeout);
        await bleDevice.WaitForPropertyValueAsync("ServicesResolved", value: true, timeout);

        var serviceUuid = BlueZManager.NormalizeUUID(defaults.ServiceUuid!);
        var notifyUuid = BlueZManager.NormalizeUUID(defaults.NotifyCharacteristicUuid!);
        var writeUuid = BlueZManager.NormalizeUUID(defaults.WriteCharacteristicUuid!);
        var service = await bleDevice.GetServiceAsync(serviceUuid)
            ?? throw new InvalidOperationException($"BLE service '{serviceUuid}' was not found on device '{target}'.");

        var characteristics = await service.GetCharacteristicsAsync();
        var notify = await SelectCharacteristicAsync(characteristics, notifyUuid, "notify")
            ?? throw new InvalidOperationException($"Notify characteristic '{notifyUuid}' was not found on device '{target}'.");
        var write = await SelectCharacteristicAsync(characteristics, writeUuid, "write", "write-without-response")
            ?? throw new InvalidOperationException($"Write characteristic '{writeUuid}' was not found on device '{target}'.");

        session.Device = bleDevice;
        session.NotifyCharacteristic = notify;
        session.WriteCharacteristic = write;
        session.DefinitionId = definition.Device.Id;
        session.SerialNumber = await TryReadSerialNumberAsync(bleDevice)
            ?? throw new InvalidOperationException("Could not read the EcoFlow serial number from BLE manufacturer data.");
        session.NotifyWatcher = await notify.WatchPropertiesAsync(changes => OnNotifyPropertiesChanged(session, changes));
        await BlueZOperationHelpers.StartNotifyAsync(
            notify,
            logger,
            $"device={device.DeviceId};target={target};protocol=ecoflow",
            cancellationToken);

        await AuthenticateType7Async(session, cancellationToken);
        logger.LogInformation(
            "EcoFlow BLE connection authenticated for device {DeviceId}. Target={Target}, Serial={SerialNumber}.",
            device.DeviceId,
            target,
            session.SerialNumber);
    }

    private async Task AuthenticateType7Async(EcoFlowSession session, CancellationToken cancellationToken)
    {
        var keyPair = EcoFlowCrypto.CreateKeyPair();
        await WriteOuterFrameAsync(
            session,
            EcoFlowWire.BuildOuterFrame(
                [0x01, 0x00, .. keyPair.PublicKey],
                frameType: EcoFlowWire.FrameTypeCommand),
            forceWriteWithResponse: true,
            cancellationToken);

        var publicKeyPayload = await WaitForOuterPayloadAsync(session, cancellationToken);
        if (publicKeyPayload.Length < 43)
            throw new InvalidOperationException($"EcoFlow public-key response was too short: {Convert.ToHexString(publicKeyPayload)}");

        var ecdhSize = GetEcdhTypeSize(publicKeyPayload[2]);
        if (publicKeyPayload.Length < 3 + ecdhSize)
            throw new InvalidOperationException($"EcoFlow public-key response did not include {ecdhSize} key bytes.");

        var sharedSecret = EcoFlowCrypto.ComputeSharedSecret(keyPair.PrivateKey, publicKeyPayload.AsSpan(3, ecdhSize));
        var iv = MD5.HashData(sharedSecret);
        var initialKey = sharedSecret.AsSpan(0, 16).ToArray();

        await WriteOuterFrameAsync(
            session,
            EcoFlowWire.BuildOuterFrame([0x02], frameType: EcoFlowWire.FrameTypeCommand),
            forceWriteWithResponse: true,
            cancellationToken);

        var keyInfoPayload = await WaitForOuterPayloadAsync(session, cancellationToken);
        if (keyInfoPayload.Length < 2 || keyInfoPayload[0] != 0x02)
            throw new InvalidOperationException($"EcoFlow key-info response was not valid: {Convert.ToHexString(keyInfoPayload)}");

        var keyInfo = EcoFlowCrypto.DecryptAesCbc(keyInfoPayload.AsSpan(1).ToArray(), initialKey, iv);
        if (keyInfo.Length < 18)
            throw new InvalidOperationException("EcoFlow key-info response did not contain sRand and seed.");

        var sessionKey = EcoFlowCrypto.GenerateSessionKey(keyInfo.AsSpan(16, 2), keyInfo.AsSpan(0, 16));
        lock (session.SyncRoot)
        {
            session.SessionKey = sessionKey;
            session.InitialSessionKey = initialKey;
            session.Iv = iv;
            session.CanProcessEncryptedFrames = true;
        }

        await SendPacketAsync(
            session,
            EcoFlowWire.BuildPacket(0x21, AuthDst, 0x35, 0x89, []),
            cancellationToken);

        var authHash = Convert.ToHexString(MD5.HashData(Encoding.ASCII.GetBytes(session.UserId + session.SerialNumber)));
        await SendPacketAsync(
            session,
            EcoFlowWire.BuildPacket(0x21, AuthDst, 0x35, 0x86, Encoding.ASCII.GetBytes(authHash)),
            cancellationToken);
    }

    private async Task<byte[]> WaitForTelemetryAsync(
        EcoFlowSession session,
        int timeoutMs,
        CancellationToken cancellationToken)
    {
        lock (session.SyncRoot)
        {
            if (session.LastTelemetry is not null &&
                DateTimeOffset.UtcNow - session.LastTelemetryAt <= MinFreshTelemetryAge)
            {
                return session.LastTelemetry;
            }

            session.PendingTelemetry = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(timeoutMs);
        using var _ = timeoutCts.Token.Register(() =>
        {
            TaskCompletionSource<byte[]>? pending;
            lock (session.SyncRoot)
            {
                pending = session.PendingTelemetry;
                session.PendingTelemetry = null;
            }

            pending?.TrySetException(new TimeoutException($"Timed out waiting for EcoFlow telemetry from '{session.DeviceId}'."));
        });

        TaskCompletionSource<byte[]> tcs;
        lock (session.SyncRoot)
        {
            tcs = session.PendingTelemetry!;
        }

        return await tcs.Task;
    }

    private async Task<byte[]> WaitForOuterPayloadAsync(EcoFlowSession session, CancellationToken cancellationToken)
    {
        TaskCompletionSource<byte[]> pending;
        lock (session.SyncRoot)
        {
            pending = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
            session.PendingOuterPayload = pending;
        }

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(10));
        using var _ = timeoutCts.Token.Register(() =>
        {
            TaskCompletionSource<byte[]>? toCancel;
            lock (session.SyncRoot)
            {
                toCancel = session.PendingOuterPayload;
                if (ReferenceEquals(toCancel, pending))
                    session.PendingOuterPayload = null;
            }

            toCancel?.TrySetException(new TimeoutException("Timed out waiting for EcoFlow BLE authentication response."));
        });

        return await pending.Task;
    }

    private void OnNotifyPropertiesChanged(EcoFlowSession session, PropertyChanges changes)
    {
        var changedValue = changes.Changed
            .FirstOrDefault(pair => string.Equals(pair.Key, "Value", StringComparison.Ordinal))
            .Value;
        if (changedValue is not byte[] chunk || chunk.Length == 0)
            return;

        List<byte[]> payloads = [];
        lock (session.SyncRoot)
        {
            session.OuterFrameBuffer.AddRange(chunk);
            while (EcoFlowWire.TryExtractOuterPayload(session.OuterFrameBuffer, out var payload))
            {
                if (payload is not null)
                    payloads.Add(payload);
            }
        }

        foreach (var payload in payloads)
            ProcessOuterPayload(session, payload);
    }

    private void ProcessOuterPayload(EcoFlowSession session, byte[] payload)
    {
        TaskCompletionSource<byte[]>? pendingOuter = null;
        lock (session.SyncRoot)
        {
            if (!session.CanProcessEncryptedFrames)
            {
                pendingOuter = session.PendingOuterPayload;
                session.PendingOuterPayload = null;
            }
        }

        if (pendingOuter is not null)
        {
            pendingOuter.TrySetResult(payload);
            return;
        }

        byte[]? key;
        byte[]? iv;
        lock (session.SyncRoot)
        {
            key = session.SessionKey;
            iv = session.Iv;
        }

        if (key is null || iv is null)
            return;

        byte[] decrypted;
        try
        {
            decrypted = EcoFlowCrypto.DecryptAesCbc(payload, key, iv);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to decrypt EcoFlow BLE payload for device {DeviceId}.", session.DeviceId);
            return;
        }

        if (!EcoFlowWire.TryParsePacket(decrypted, xorPayload: true, out var packet) || packet is null)
        {
            logger.LogDebug("Ignored non-packet EcoFlow BLE payload for device {DeviceId}: {PayloadHex}.", session.DeviceId, Convert.ToHexString(decrypted));
            return;
        }

        if (packet.CmdSet == 0x35 && packet.CmdId == 0x86)
        {
            if (packet.Payload.Length > 0 && packet.Payload[0] is not 0x00 and not 0x01)
            {
                logger.LogWarning(
                    "EcoFlow BLE authentication reply for device {DeviceId} was not successful. Payload={PayloadHex}.",
                    session.DeviceId,
                    Convert.ToHexString(packet.Payload));
            }

            lock (session.SyncRoot)
            {
                session.Authenticated = true;
            }
            return;
        }

        if (packet.Src == 0x02 && packet.CmdSet == 0xFE && packet.CmdId == 0x15)
        {
            if (!EcoFlowStreamTelemetry.TryDecode(packet.Payload, out var telemetry))
            {
                logger.LogDebug("Ignored EcoFlow DisplayPropertyUpload payload that could not be decoded.");
                return;
            }

            var buffer = EcoFlowStreamTelemetryNormalizer.ToDisplayBank(telemetry);
            TaskCompletionSource<byte[]>? pendingTelemetry;
            lock (session.SyncRoot)
            {
                session.Authenticated = true;
                session.LastTelemetry = buffer;
                session.LastTelemetryAt = DateTimeOffset.UtcNow;
                session.LastRawFrameHex = Convert.ToHexString(packet.Payload);
                pendingTelemetry = session.PendingTelemetry;
                session.PendingTelemetry = null;
            }

            pendingTelemetry?.TrySetResult(buffer);
        }
    }

    private static int GetEcdhTypeSize(byte type) => type switch
    {
        1 => 52,
        2 => 56,
        3 or 4 => 64,
        _ => 40
    };

    private async Task SendPacketAsync(EcoFlowSession session, byte[] packet, CancellationToken cancellationToken)
    {
        byte[] key;
        byte[] iv;
        lock (session.SyncRoot)
        {
            key = session.SessionKey ?? throw new InvalidOperationException("EcoFlow session key has not been established.");
            iv = session.Iv ?? throw new InvalidOperationException("EcoFlow session IV has not been established.");
        }

        var encryptedPacket = EcoFlowWire.BuildOuterFrame(
            EcoFlowCrypto.EncryptAesCbc(packet, key, iv),
            frameType: EcoFlowWire.FrameTypeProtocol);
        await WriteOuterFrameAsync(session, encryptedPacket, forceWriteWithResponse: true, cancellationToken);
    }

    private static async Task WriteOuterFrameAsync(
        EcoFlowSession session,
        byte[] frame,
        bool forceWriteWithResponse,
        CancellationToken cancellationToken)
    {
        if (session.WriteCharacteristic is null)
            throw new InvalidOperationException($"Device '{session.DeviceId}' is not connected to a writable BLE characteristic.");

        cancellationToken.ThrowIfCancellationRequested();
        var options = new Dictionary<string, object>
        {
            ["type"] = forceWriteWithResponse ? "request" : await SelectWriteTypeAsync(session.WriteCharacteristic)
        };
        await session.WriteCharacteristic.WriteValueAsync(frame, options);
    }

    private async Task<bool> IsSessionUsableAsync(EcoFlowSession session, DeviceDefinition definition)
    {
        if (session.Device is null ||
            session.NotifyCharacteristic is null ||
            session.WriteCharacteristic is null ||
            !string.Equals(session.DefinitionId, definition.Device.Id, StringComparison.OrdinalIgnoreCase) ||
            !session.CanProcessEncryptedFrames)
        {
            return false;
        }

        try
        {
            return await session.Device.GetAsync<bool>("Connected") &&
                   await session.Device.GetAsync<bool>("ServicesResolved");
        }
        catch
        {
            return false;
        }
    }

    private async Task<Device?> ResolveDeviceAsync(
        Adapter adapter,
        string identifier,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var knownDevices = await adapter.GetDevicesAsync();
        foreach (var known in knownDevices)
        {
            if (await IsMatchingDeviceAsync(known, identifier))
                return known;
        }

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
                $"ecoflow-resolve:{identifier}",
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
                $"ecoflow-resolve:{identifier}");
        }
    }

    private static async Task<bool> IsMatchingDeviceAsync(Device device, string identifier)
    {
        var address = await SafeGetStringAsync(() => device.GetAddressAsync());
        var alias = await SafeGetStringAsync(() => device.GetAliasAsync());
        var name = await SafeGetStringAsync(() => device.GetNameAsync());
        return GenericBlePollingClient.IdentifierMatches(identifier, address, alias, name);
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

    private static async Task<string> SelectWriteTypeAsync(IGattCharacteristic1 characteristic)
    {
        var flags = await characteristic.GetFlagsAsync();
        return flags.Any(flag => string.Equals(flag, "write-without-response", StringComparison.OrdinalIgnoreCase))
            ? "command"
            : "request";
    }

    private static async Task<string?> TryReadSerialNumberAsync(Device device)
    {
        var payload = await SafeGetObjectAsync(() => device.GetManufacturerDataAsync());
        if (payload is not IEnumerable enumerable)
            return null;

        foreach (var entry in enumerable)
        {
            var value = entry?.GetType().GetProperty("Value")?.GetValue(entry);
            if (TryExtractSerialFromPayload(value, out var serial))
                return serial;
        }

        return null;
    }

    private static bool TryExtractSerialFromPayload(object? payload, out string serial)
    {
        serial = string.Empty;
        byte[]? bytes = payload switch
        {
            byte[] direct => direct,
            IEnumerable<byte> enumerable => enumerable.ToArray(),
            _ => null
        };

        if (bytes is null || bytes.Length == 0)
            return false;

        var text = Encoding.ASCII.GetString(bytes.Where(b => b is >= 0x20 and < 0x7F).ToArray());
        var start = text.IndexOf("BK", StringComparison.OrdinalIgnoreCase);
        if (start < 0)
            return false;

        var candidate = new string(text[start..].TakeWhile(char.IsLetterOrDigit).ToArray());
        if (candidate.Length < 12)
            return false;

        serial = candidate;
        return true;
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

    private static async Task ResetSessionAsync(EcoFlowSession session)
    {
        TaskCompletionSource<byte[]>? pendingOuter;
        TaskCompletionSource<byte[]>? pendingTelemetry;
        lock (session.SyncRoot)
        {
            pendingOuter = session.PendingOuterPayload;
            pendingTelemetry = session.PendingTelemetry;
            session.PendingOuterPayload = null;
            session.PendingTelemetry = null;
            session.OuterFrameBuffer.Clear();
            session.SessionKey = null;
            session.InitialSessionKey = null;
            session.Iv = null;
            session.CanProcessEncryptedFrames = false;
            session.Authenticated = false;
        }

        pendingOuter?.TrySetCanceled();
        pendingTelemetry?.TrySetCanceled();

        session.NotifyWatcher?.Dispose();
        session.NotifyWatcher = null;
        if (session.NotifyCharacteristic is not null)
        {
            try
            {
                await session.NotifyCharacteristic.StopNotifyAsync();
            }
            catch
            {
                // Best-effort cleanup.
            }
        }

        session.Device = null;
        session.NotifyCharacteristic = null;
        session.WriteCharacteristic = null;
        session.DefinitionId = null;
        session.SerialNumber = null;
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;
        List<EcoFlowSession> sessions;
        lock (_sessions)
        {
            sessions = _sessions.Values.ToList();
            _sessions.Clear();
        }

        foreach (var session in sessions)
        {
            session.NotifyWatcher?.Dispose();
            session.Lock.Dispose();
        }
    }

    private sealed class EcoFlowSession(string deviceId)
    {
        public string DeviceId { get; } = deviceId;
        public SemaphoreSlim Lock { get; } = new(1, 1);
        public object SyncRoot { get; } = new();
        public string? DefinitionId { get; set; }
        public string? SerialNumber { get; set; }
        public string UserId { get; set; } = string.Empty;
        public Device? Device { get; set; }
        public IGattCharacteristic1? NotifyCharacteristic { get; set; }
        public IGattCharacteristic1? WriteCharacteristic { get; set; }
        public IDisposable? NotifyWatcher { get; set; }
        public List<byte> OuterFrameBuffer { get; } = [];
        public TaskCompletionSource<byte[]>? PendingOuterPayload { get; set; }
        public TaskCompletionSource<byte[]>? PendingTelemetry { get; set; }
        public byte[]? SessionKey { get; set; }
        public byte[]? InitialSessionKey { get; set; }
        public byte[]? Iv { get; set; }
        public bool CanProcessEncryptedFrames { get; set; }
        public bool Authenticated { get; set; }
        public byte[]? LastTelemetry { get; set; }
        public DateTimeOffset LastTelemetryAt { get; set; }
        public string LastRawFrameHex { get; set; } = string.Empty;
    }
}

internal sealed record EcoFlowKeyPair(byte[] PrivateKey, byte[] PublicKey);

internal static class EcoFlowCrypto
{
    private static readonly byte[] KeyData = LoadKeyData();

    public static EcoFlowKeyPair CreateKeyPair()
    {
        var parameters = CreateDomainParameters();
        var random = new SecureRandom();
        Org.BouncyCastle.Math.BigInteger privateKey;
        do
        {
            privateKey = new Org.BouncyCastle.Math.BigInteger(parameters.N.BitLength, random);
        }
        while (privateKey.SignValue <= 0 || privateKey.CompareTo(parameters.N) >= 0);

        var point = parameters.G.Multiply(privateKey).Normalize();
        var x = ToFixedLength(point.AffineXCoord.GetEncoded(), 20);
        var y = ToFixedLength(point.AffineYCoord.GetEncoded(), 20);
        return new EcoFlowKeyPair(privateKey.ToByteArrayUnsigned(), [.. x, .. y]);
    }

    public static byte[] ComputeSharedSecret(byte[] privateKeyBytes, ReadOnlySpan<byte> devicePublicKey)
    {
        if (devicePublicKey.Length != 40)
            throw new InvalidOperationException($"Expected a 40-byte secp160r1 public key, received {devicePublicKey.Length} bytes.");

        var parameters = CreateDomainParameters();
        var privateKey = new ECPrivateKeyParameters(
            new Org.BouncyCastle.Math.BigInteger(1, privateKeyBytes),
            parameters);
        var x = new Org.BouncyCastle.Math.BigInteger(1, devicePublicKey[..20].ToArray());
        var y = new Org.BouncyCastle.Math.BigInteger(1, devicePublicKey[20..40].ToArray());
        var publicPoint = parameters.Curve.CreatePoint(x, y);
        var publicKey = new ECPublicKeyParameters(publicPoint, parameters);
        var agreement = new ECDHBasicAgreement();
        agreement.Init(privateKey);
        return ToFixedLength(agreement.CalculateAgreement(publicKey).ToByteArrayUnsigned(), 20);
    }

    public static byte[] EncryptAesCbc(byte[] plaintext, byte[] key, byte[] iv)
    {
        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = key;
        aes.IV = iv;
        using var encryptor = aes.CreateEncryptor();
        return encryptor.TransformFinalBlock(plaintext, 0, plaintext.Length);
    }

    public static byte[] DecryptAesCbc(byte[] ciphertext, byte[] key, byte[] iv)
    {
        var alignedLength = ciphertext.Length - ciphertext.Length % 16;
        if (alignedLength <= 0)
            return ciphertext;

        using var aes = Aes.Create();
        aes.Mode = CipherMode.CBC;
        aes.Padding = PaddingMode.None;
        aes.Key = key;
        aes.IV = iv;
        using var decryptor = aes.CreateDecryptor();
        var decrypted = decryptor.TransformFinalBlock(ciphertext, 0, alignedLength);
        return TryRemovePkcs7Padding(decrypted, out var unpadded) ? unpadded : decrypted;
    }

    public static byte[] GenerateSessionKey(ReadOnlySpan<byte> seed, ReadOnlySpan<byte> srand)
    {
        if (seed.Length < 2 || srand.Length < 16)
            throw new InvalidOperationException("EcoFlow session key seed/sRand data is incomplete.");

        var pos = seed[0] * 0x10 + ((seed[1] - 1) & 0xff) * 0x100;
        if (pos < 0 || pos + 16 > KeyData.Length)
            throw new InvalidOperationException($"EcoFlow session key seed points outside key data. Position={pos}.");

        Span<byte> data = stackalloc byte[32];
        KeyData.AsSpan(pos, 16).CopyTo(data[..16]);
        srand[..16].CopyTo(data[16..32]);
        return MD5.HashData(data);
    }

    private static ECDomainParameters CreateDomainParameters()
    {
        var curve = SecNamedCurves.GetByName("secp160r1")
            ?? throw new InvalidOperationException("BouncyCastle does not support secp160r1.");
        return new ECDomainParameters(curve.Curve, curve.G, curve.N, curve.H, curve.GetSeed());
    }

    private static byte[] ToFixedLength(byte[] value, int length)
    {
        if (value.Length == length)
            return value;
        if (value.Length > length)
            return value[^length..];

        var result = new byte[length];
        value.CopyTo(result, length - value.Length);
        return result;
    }

    private static bool TryRemovePkcs7Padding(byte[] value, out byte[] unpadded)
    {
        unpadded = value;
        if (value.Length == 0)
            return false;

        var padding = value[^1];
        if (padding is 0 or > 16 || padding > value.Length)
            return false;

        for (var i = value.Length - padding; i < value.Length; i++)
        {
            if (value[i] != padding)
                return false;
        }

        unpadded = value[..^padding];
        return true;
    }

    private static byte[] LoadKeyData()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .FirstOrDefault(name => name.EndsWith("EcoFlowKeyData.b64", StringComparison.Ordinal));
        if (resourceName is null)
            throw new InvalidOperationException("Embedded EcoFlow key data resource is missing.");

        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("Embedded EcoFlow key data resource could not be opened.");
        using var reader = new StreamReader(stream, Encoding.ASCII);
        return Convert.FromBase64String(reader.ReadToEnd().Trim());
    }
}

internal sealed record EcoFlowPacket(byte Src, byte Dst, byte CmdSet, byte CmdId, byte[] Payload, byte[] Seq);

internal static class EcoFlowWire
{
    public const byte FrameTypeCommand = 0x00;
    public const byte FrameTypeProtocol = 0x01;
    private static readonly byte[] OuterPrefix = [0x5A, 0x5A];

    public static byte[] BuildOuterFrame(byte[] payload, byte frameType)
    {
        var data = new byte[6 + payload.Length + 2];
        data[0] = OuterPrefix[0];
        data[1] = OuterPrefix[1];
        data[2] = (byte)(frameType << 4);
        data[3] = 0x01;
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(4, 2), checked((ushort)(payload.Length + 2)));
        payload.CopyTo(data.AsSpan(6));
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(6 + payload.Length, 2), Crc16Arc(data.AsSpan(0, 6 + payload.Length)));
        return data;
    }

    public static bool TryExtractOuterPayload(List<byte> buffer, out byte[]? payload)
    {
        payload = null;

        while (buffer.Count > 0)
        {
            var start = FindPrefix(buffer);
            if (start < 0)
            {
                buffer.Clear();
                return false;
            }

            if (start > 0)
                buffer.RemoveRange(0, start);

            if (buffer.Count < 8)
                return false;

            var payloadLen = BinaryPrimitives.ReadUInt16LittleEndian(CollectionsMarshalAsSpan(buffer).Slice(4, 2));
            if (payloadLen > 10_000)
            {
                buffer.RemoveAt(0);
                continue;
            }

            var frameLen = 6 + payloadLen;
            if (buffer.Count < frameLen)
                return false;

            var frame = buffer.GetRange(0, frameLen).ToArray();
            var expected = BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(frameLen - 2, 2));
            var actual = Crc16Arc(frame.AsSpan(0, frameLen - 2));
            buffer.RemoveRange(0, frameLen);
            if (expected != actual)
                continue;

            payload = frame.AsSpan(6, payloadLen - 2).ToArray();
            return true;
        }

        return false;
    }

    public static byte[] BuildPacket(byte src, byte dst, byte cmdSet, byte cmdId, byte[] payload)
    {
        var data = new byte[18 + payload.Length + 2];
        data[0] = 0xAA;
        data[1] = 0x03;
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(2, 2), checked((ushort)payload.Length));
        data[4] = Crc8Ccitt(data.AsSpan(0, 4));
        data[5] = 0x0D;
        data[12] = src;
        data[13] = dst;
        data[14] = 0x01;
        data[15] = 0x01;
        data[16] = cmdSet;
        data[17] = cmdId;
        payload.CopyTo(data.AsSpan(18));
        BinaryPrimitives.WriteUInt16LittleEndian(data.AsSpan(18 + payload.Length, 2), Crc16Arc(data.AsSpan(0, 18 + payload.Length)));
        return data;
    }

    public static bool TryParsePacket(byte[] data, bool xorPayload, out EcoFlowPacket? packet)
    {
        packet = null;
        if (data.Length < 18 || data[0] != 0xAA)
            return false;

        var versionByte = data[1];
        var version = versionByte & 0x0F;
        var sentinelFormat = (versionByte & 0x10) != 0;
        if (version is not (2 or 3))
            return false;

        if (Crc8Ccitt(data.AsSpan(0, 4)) != data[4])
            return false;

        var payloadLength = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(2, 2));
        var payloadStart = version == 2 ? 16 : 18;
        if (data.Length < payloadStart + payloadLength)
            return false;

        if (!sentinelFormat)
        {
            var fullLength = payloadStart + payloadLength + 2;
            if (data.Length < fullLength)
                return false;

            var expected = BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(fullLength - 2, 2));
            if (Crc16Arc(data.AsSpan(0, fullLength - 2)) != expected)
                return false;
        }

        var seq = data.AsSpan(6, 4).ToArray();
        var payload = data.AsSpan(payloadStart, payloadLength).ToArray();
        if (xorPayload && seq[0] != 0)
        {
            for (var i = 0; i < payload.Length; i++)
                payload[i] ^= seq[0];
        }

        if (sentinelFormat && payload.Length >= 2 && payload[^2] == 0xBB && payload[^1] == 0xBB)
            payload = payload[..^2];

        packet = new EcoFlowPacket(
            data[12],
            data[13],
            data[payloadStart - 2],
            data[payloadStart - 1],
            payload,
            seq);
        return true;
    }

    private static int FindPrefix(List<byte> buffer)
    {
        for (var i = 0; i + 1 < buffer.Count; i++)
        {
            if (buffer[i] == OuterPrefix[0] && buffer[i + 1] == OuterPrefix[1])
                return i;
        }

        return -1;
    }

    private static Span<byte> CollectionsMarshalAsSpan(List<byte> buffer)
        => System.Runtime.InteropServices.CollectionsMarshal.AsSpan(buffer);

    private static byte Crc8Ccitt(ReadOnlySpan<byte> data)
    {
        byte crc = 0;
        foreach (var value in data)
        {
            crc ^= value;
            for (var i = 0; i < 8; i++)
                crc = (byte)((crc & 0x80) != 0 ? (crc << 1) ^ 0x07 : crc << 1);
        }

        return crc;
    }

    private static ushort Crc16Arc(ReadOnlySpan<byte> data)
    {
        ushort crc = 0;
        foreach (var value in data)
        {
            crc ^= value;
            for (var i = 0; i < 8; i++)
                crc = (ushort)((crc & 1) != 0 ? (crc >> 1) ^ 0xA001 : crc >> 1);
        }

        return crc;
    }
}

internal sealed class EcoFlowStreamTelemetry
{
    public float? Pv1PowerWatts { get; set; }
    public float? Pv2PowerWatts { get; set; }
    public float? Pv1VoltageVolts { get; set; }
    public float? Pv1CurrentAmps { get; set; }
    public float? Pv2VoltageVolts { get; set; }
    public float? Pv2CurrentAmps { get; set; }
    public uint? FeedGridModePowerLimitWatts { get; set; }
    public uint? FeedGridModePowerMaxWatts { get; set; }
    public float? WifiRssiDbm { get; set; }
    public float? GridVoltageVolts { get; set; }
    public float? GridCurrentAmps { get; set; }
    public float? GridFrequencyHz { get; set; }
    public float? GridPowerWatts { get; set; }
    public float? GridPowerFactor { get; set; }
    public uint? GridConnectionStatus { get; set; }
    public List<uint> ErrorCodes { get; } = [];
    public float? InverterTargetPowerWatts { get; set; }
    public int? UtcTimezone { get; set; }
    public string? UtcTimezoneId { get; set; }
    public bool? UtcSetMode { get; set; }
    public string? CountryCode { get; set; }
    public uint? TownCode { get; set; }
    public uint? GridCodeSelection { get; set; }
    public uint? GridCodeVersion { get; set; }
    public bool? FactoryModeEnabled { get; set; }
    public bool? DebugModeEnabled { get; set; }
    public float? GridPowerFactorSetting { get; set; }
    public float? GridPowerSettingWatts { get; set; }
    public uint? FeedGridSafetyPowerMaxWatts { get; set; }

    public static bool TryDecode(byte[] payload, out EcoFlowStreamTelemetry telemetry)
    {
        telemetry = new EcoFlowStreamTelemetry();
        try
        {
            var reader = new ProtobufReader(payload);
            while (reader.TryReadField(out var fieldNumber, out var wireType))
            {
                switch (fieldNumber)
                {
                    case 70: telemetry.Pv2PowerWatts = reader.ReadFloat(wireType); break;
                    case 71: telemetry.Pv2CurrentAmps = reader.ReadFloat(wireType); break;
                    case 133: telemetry.UtcTimezone = (int)reader.ReadVarint(wireType); break;
                    case 134: telemetry.UtcTimezoneId = reader.ReadString(wireType); break;
                    case 135: telemetry.UtcSetMode = reader.ReadVarint(wireType) != 0; break;
                    case 361: telemetry.Pv1PowerWatts = reader.ReadFloat(wireType); break;
                    case 380: telemetry.Pv1VoltageVolts = reader.ReadFloat(wireType); break;
                    case 381: telemetry.Pv1CurrentAmps = reader.ReadFloat(wireType); break;
                    case 442: telemetry.Pv2VoltageVolts = reader.ReadFloat(wireType); break;
                    case 521: telemetry.FeedGridModePowerLimitWatts = (uint)reader.ReadVarint(wireType); break;
                    case 602: telemetry.WifiRssiDbm = reader.ReadFloat(wireType); break;
                    case 613: telemetry.GridVoltageVolts = reader.ReadFloat(wireType); break;
                    case 614: telemetry.GridCurrentAmps = reader.ReadFloat(wireType); break;
                    case 615: telemetry.GridFrequencyHz = reader.ReadFloat(wireType); break;
                    case 616: telemetry.GridPowerWatts = reader.ReadFloat(wireType); break;
                    case 618: telemetry.GridPowerFactor = reader.ReadFloat(wireType); break;
                    case 619: telemetry.GridConnectionStatus = (uint)reader.ReadVarint(wireType); break;
                    case 627: DecodeErrorList(reader.ReadBytes(wireType), telemetry.ErrorCodes); break;
                    case 638: telemetry.InverterTargetPowerWatts = reader.ReadFloat(wireType); break;
                    case 727: telemetry.FeedGridModePowerMaxWatts = (uint)reader.ReadVarint(wireType); break;
                    case 728: telemetry.CountryCode = reader.ReadString(wireType); break;
                    case 729: telemetry.TownCode = (uint)reader.ReadVarint(wireType); break;
                    case 730: telemetry.GridCodeSelection = (uint)reader.ReadVarint(wireType); break;
                    case 731: telemetry.GridCodeVersion = (uint)reader.ReadVarint(wireType); break;
                    case 732: telemetry.FactoryModeEnabled = reader.ReadVarint(wireType) != 0; break;
                    case 733: telemetry.DebugModeEnabled = reader.ReadVarint(wireType) != 0; break;
                    case 734: telemetry.GridPowerFactorSetting = reader.ReadFloat(wireType); break;
                    case 735: telemetry.GridPowerSettingWatts = reader.ReadFloat(wireType); break;
                    case 1543: telemetry.FeedGridSafetyPowerMaxWatts = (uint)reader.ReadVarint(wireType); break;
                    default: reader.Skip(wireType); break;
                }
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void DecodeErrorList(byte[] payload, List<uint> target)
    {
        var reader = new ProtobufReader(payload);
        while (reader.TryReadField(out var fieldNumber, out var wireType))
        {
            if (fieldNumber == 1)
                target.Add((uint)reader.ReadVarint(wireType));
            else
                reader.Skip(wireType);
        }
    }
}

internal static class EcoFlowStreamTelemetryNormalizer
{
    public const int BufferSize = 192;

    public static byte[] ToDisplayBank(EcoFlowStreamTelemetry telemetry)
    {
        var buffer = new byte[BufferSize];
        WriteInt32(buffer, 0, telemetry.Pv1PowerWatts, 10);
        WriteInt32(buffer, 4, telemetry.Pv2PowerWatts, 10);
        WriteUInt16(buffer, 8, telemetry.Pv1VoltageVolts, 100);
        WriteUInt16(buffer, 10, telemetry.Pv1CurrentAmps, 100);
        WriteUInt16(buffer, 12, telemetry.Pv2VoltageVolts, 100);
        WriteUInt16(buffer, 14, telemetry.Pv2CurrentAmps, 100);
        WriteUInt16(buffer, 16, telemetry.GridVoltageVolts, 100);
        WriteUInt16(buffer, 18, telemetry.GridCurrentAmps, 100);
        WriteUInt16(buffer, 20, telemetry.GridFrequencyHz, 100);
        WriteInt32(buffer, 22, telemetry.GridPowerWatts, 10);
        WriteInt16(buffer, 26, telemetry.GridPowerFactor, 1000);
        WriteUInt16(buffer, 28, telemetry.GridConnectionStatus);
        WriteInt16(buffer, 30, telemetry.WifiRssiDbm, 1);
        WriteUInt16(buffer, 32, telemetry.FeedGridModePowerLimitWatts);
        WriteUInt16(buffer, 34, telemetry.FeedGridModePowerMaxWatts);
        WriteInt32(buffer, 36, telemetry.InverterTargetPowerWatts, 10);
        WriteInt16(buffer, 40, telemetry.UtcTimezone);
        buffer[42] = telemetry.UtcSetMode == true ? (byte)1 : (byte)0;
        buffer[43] = telemetry.FactoryModeEnabled == true ? (byte)1 : (byte)0;
        buffer[44] = telemetry.DebugModeEnabled == true ? (byte)1 : (byte)0;
        WriteAscii(buffer, 45, 8, telemetry.CountryCode);
        WriteUInt16(buffer, 53, telemetry.TownCode);
        WriteUInt16(buffer, 55, telemetry.GridCodeSelection);
        WriteUInt32(buffer, 57, telemetry.GridCodeVersion);
        WriteInt16(buffer, 61, telemetry.GridPowerFactorSetting, 1000);
        WriteAscii(buffer, 63, 32, telemetry.UtcTimezoneId);
        WriteAscii(buffer, 95, 64, telemetry.ErrorCodes.Count == 0 ? "none" : string.Join(",", telemetry.ErrorCodes));
        WriteInt32(buffer, 159, telemetry.GridPowerSettingWatts, 10);
        WriteUInt16(buffer, 163, telemetry.FeedGridSafetyPowerMaxWatts);
        return buffer;
    }

    private static void WriteInt32(byte[] buffer, int offset, float? value, double multiplier)
        => BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(offset, 4), checked((int)Math.Round((value ?? 0) * multiplier)));

    private static void WriteInt16(byte[] buffer, int offset, float? value, double multiplier)
        => BinaryPrimitives.WriteInt16LittleEndian(buffer.AsSpan(offset, 2), checked((short)Math.Round((value ?? 0) * multiplier)));

    private static void WriteInt16(byte[] buffer, int offset, int? value)
        => BinaryPrimitives.WriteInt16LittleEndian(buffer.AsSpan(offset, 2), checked((short)(value ?? 0)));

    private static void WriteUInt16(byte[] buffer, int offset, float? value, double multiplier)
        => BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(offset, 2), checked((ushort)Math.Max(0, Math.Round((value ?? 0) * multiplier))));

    private static void WriteUInt16(byte[] buffer, int offset, uint? value)
        => BinaryPrimitives.WriteUInt16LittleEndian(buffer.AsSpan(offset, 2), checked((ushort)Math.Min(ushort.MaxValue, value ?? 0)));

    private static void WriteUInt32(byte[] buffer, int offset, uint? value)
        => BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(offset, 4), value ?? 0);

    private static void WriteAscii(byte[] buffer, int offset, int length, string? value)
    {
        var bytes = Encoding.ASCII.GetBytes(value ?? string.Empty);
        Array.Fill(buffer, (byte)' ', offset, length);
        bytes.AsSpan(0, Math.Min(length, bytes.Length)).CopyTo(buffer.AsSpan(offset, length));
    }
}

internal ref struct ProtobufReader(ReadOnlySpan<byte> data)
{
    private ReadOnlySpan<byte> _data = data;
    private int _offset;

    public bool TryReadField(out int fieldNumber, out int wireType)
    {
        fieldNumber = 0;
        wireType = 0;
        if (_offset >= _data.Length)
            return false;

        var tag = ReadRawVarint();
        fieldNumber = (int)(tag >> 3);
        wireType = (int)(tag & 0x07);
        return fieldNumber > 0;
    }

    public ulong ReadVarint(int wireType)
    {
        EnsureWireType(wireType, 0);
        return ReadRawVarint();
    }

    public float ReadFloat(int wireType)
    {
        EnsureWireType(wireType, 5);
        if (_offset + 4 > _data.Length)
            throw new InvalidOperationException("Unexpected end of protobuf fixed32 value.");

        var value = BitConverter.Int32BitsToSingle(BinaryPrimitives.ReadInt32LittleEndian(_data.Slice(_offset, 4)));
        _offset += 4;
        return value;
    }

    public string ReadString(int wireType)
        => Encoding.UTF8.GetString(ReadBytes(wireType));

    public byte[] ReadBytes(int wireType)
    {
        EnsureWireType(wireType, 2);
        var length = checked((int)ReadRawVarint());
        if (_offset + length > _data.Length)
            throw new InvalidOperationException("Unexpected end of protobuf length-delimited value.");

        var value = _data.Slice(_offset, length).ToArray();
        _offset += length;
        return value;
    }

    public void Skip(int wireType)
    {
        switch (wireType)
        {
            case 0:
                _ = ReadRawVarint();
                break;
            case 1:
                _offset += 8;
                break;
            case 2:
                var length = checked((int)ReadRawVarint());
                _offset += length;
                break;
            case 5:
                _offset += 4;
                break;
            default:
                throw new InvalidOperationException($"Unsupported protobuf wire type {wireType}.");
        }

        if (_offset > _data.Length)
            throw new InvalidOperationException("Unexpected end of protobuf payload.");
    }

    private ulong ReadRawVarint()
    {
        ulong result = 0;
        for (var shift = 0; shift < 64; shift += 7)
        {
            if (_offset >= _data.Length)
                throw new InvalidOperationException("Unexpected end of protobuf varint.");

            var value = _data[_offset++];
            result |= (ulong)(value & 0x7F) << shift;
            if ((value & 0x80) == 0)
                return result;
        }

        throw new InvalidOperationException("Protobuf varint is too long.");
    }

    private static void EnsureWireType(int actual, int expected)
    {
        if (actual != expected)
            throw new InvalidOperationException($"Unexpected protobuf wire type {actual}; expected {expected}.");
    }
}
