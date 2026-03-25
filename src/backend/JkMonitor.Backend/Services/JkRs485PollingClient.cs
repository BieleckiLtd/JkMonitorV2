using System.IO.Ports;
using JkMonitor.Backend.Models;
using JkMonitor.Backend.Protocol;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public interface IDevicePollingClient
{
    Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken);
}

public sealed class JkRs485PollingClient(
    IOptions<MonitorConfiguration> configuration,
    ILogger<JkRs485PollingClient> logger) : IDisposable
{
    private readonly MonitorConfiguration _configuration = configuration.Value;
    private readonly SemaphoreSlim _busLock = new(1, 1);
    private SerialPort? _serialPort;
    private bool _disposed;

    // Slow-changing registers are refreshed at this interval instead of every poll.
    private static readonly TimeSpan SlowRegisterInterval = TimeSpan.FromSeconds(30);
    private DateTimeOffset _lastConfigRead = DateTimeOffset.MinValue;
    private DateTimeOffset _lastDeviceInfoRead = DateTimeOffset.MinValue;
    private IReadOnlyList<DeviceParameter>? _cachedConfigParams;
    private IReadOnlyList<DeviceParameter>? _cachedDeviceInfoParams;
    private string? _cachedManufacturerId;
    private string? _cachedSoftwareVersion;

    public async Task<DevicePollResult> PollAsync(DeviceConfiguration device, DeviceProfileConfiguration profile, CancellationToken cancellationToken)
    {
        var transport = profile.Transport;
        var readTimeout = transport?.ReadTimeoutMs ?? _configuration.SerialBus.ReadTimeoutMilliseconds;
        var overallTimeoutMs = readTimeout * 8; // Allow time for config/device-info reads on slow-register cycles.

        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        pollCts.CancelAfter(overallTimeoutMs);
        var pollToken = pollCts.Token;

        await _busLock.WaitAsync(pollToken);

        try
        {
            var serialPort = EnsurePort(transport);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            var registerDefs = profile.Registers;

            // 1. Read live data (0x1200)
            logger.LogDebug("Polling JK device {DeviceId} (Modbus RTU) on {PortName} with address {Address}.", device.DeviceId, serialPort.PortName, device.Address);
            var liveResponse = await SendAndReceiveAsync(serialPort, JkModbusProtocol.BuildReadLiveDataRequest(device.Address),
                JkModbusProtocol.ExpectedResponseLength(JkModbusProtocol.LiveDataRegisterCount), readTimeout, cancellationToken);

            // 2. Read config (0x1000) — only every SlowRegisterInterval
            var now = DateTimeOffset.UtcNow;
            IReadOnlyList<DeviceParameter>? configParams = _cachedConfigParams;
            if (now - _lastConfigRead >= SlowRegisterInterval)
            {
                try
                {
                    await Task.Delay(100, pollToken);
                    serialPort.DiscardInBuffer();
                    var configResponse = await SendAndReceiveAsync(serialPort, JkModbusProtocol.BuildReadConfigRequest(device.Address),
                        JkModbusProtocol.ExpectedResponseLength(JkModbusProtocol.ConfigRegisterCount), readTimeout * 2, cancellationToken);
                    configParams = JkModbusProtocol.ParseConfigResponse(configResponse, device.Address, 100);
                    _cachedConfigParams = configParams;
                    _lastConfigRead = now;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Failed to read config registers for device {DeviceId}.", device.DeviceId);
                }
            }

            // 3. Read device info (0x1400) — only every SlowRegisterInterval
            IReadOnlyList<DeviceParameter>? deviceInfoParams = _cachedDeviceInfoParams;
            string? manufacturerId = _cachedManufacturerId;
            string? softwareVersion = _cachedSoftwareVersion;
            if (now - _lastDeviceInfoRead >= SlowRegisterInterval)
            {
                try
                {
                    await Task.Delay(100, pollToken);
                    serialPort.DiscardInBuffer();
                    var deviceInfoResponse = await SendAndReceiveAsync(serialPort, JkModbusProtocol.BuildReadDeviceInfoRequest(device.Address),
                        JkModbusProtocol.ExpectedResponseLength(JkModbusProtocol.DeviceInfoRegisterCount), readTimeout * 2, cancellationToken);
                    (deviceInfoParams, manufacturerId, softwareVersion) = JkModbusProtocol.ParseDeviceInfoResponse(deviceInfoResponse, device.Address, 200);
                    _cachedDeviceInfoParams = deviceInfoParams;
                    _cachedManufacturerId = manufacturerId;
                    _cachedSoftwareVersion = softwareVersion;
                    _lastDeviceInfoRead = now;
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Failed to read device info registers for device {DeviceId}.", device.DeviceId);
                }
            }

            return JkModbusProtocol.ParseLiveDataResponse(liveResponse, device.Address, DateTimeOffset.UtcNow, registerDefs,
                configParams, deviceInfoParams, manufacturerId, softwareVersion);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw new TimeoutException($"Overall poll timeout ({overallTimeoutMs}ms) exceeded for device {device.DeviceId}.");
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw;
        }
        finally
        {
            if (cancellationToken.IsCancellationRequested)
            {
                ClosePort();
            }

            _busLock.Release();
        }
    }

    /// <summary>
    /// Write a config register value through the Modbus bus with read-back verification.
    /// </summary>
    public async Task<WriteRegisterResult> WriteConfigRegisterAsync(
        DeviceConfiguration device, DeviceProfileConfiguration profile,
        string parameterKey, uint rawValue, CancellationToken cancellationToken)
    {
        var regDef = JkModbusProtocol.FindConfigRegister(parameterKey)
            ?? throw new ArgumentException($"Unknown config parameter key '{parameterKey}'.");

        var registerAddress = JkModbusProtocol.ConfigByteOffsetToRegisterAddress(regDef.ByteOffset);
        var transport = profile.Transport;
        var readTimeout = transport?.ReadTimeoutMs ?? _configuration.SerialBus.ReadTimeoutMilliseconds;

        using var writeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        writeCts.CancelAfter(readTimeout * 5);
        var writeToken = writeCts.Token;

        await _busLock.WaitAsync(writeToken);
        try
        {
            var serialPort = EnsurePort(transport);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            // Write
            var writeRequest = JkModbusProtocol.BuildWriteConfigRegisterRequest(device.Address, registerAddress, rawValue);
            logger.LogInformation("Writing config register {Key} (0x{Register:X4}) = {Value} for device {DeviceId}.",
                parameterKey, registerAddress, rawValue, device.DeviceId);

            var writeResponse = await SendAndReceiveAsync(serialPort, writeRequest,
                JkModbusProtocol.WriteResponseLength, readTimeout, cancellationToken);
            JkModbusProtocol.ValidateWriteResponse(writeResponse, device.Address);

            // Read back to verify
            await Task.Delay(50, writeToken);
            serialPort.DiscardInBuffer();

            var readRequest = JkModbusProtocol.BuildReadHoldingRegistersRequest(device.Address, registerAddress, 2);
            var readResponse = await SendAndReceiveAsync(serialPort, readRequest,
                JkModbusProtocol.ExpectedResponseLength(2), readTimeout, cancellationToken);

            // Parse read-back value
            var frame = readResponse;
            if (frame.Length >= 9 && frame[1] == 0x03 && frame[2] == 4)
            {
                var readBack = (uint)((frame[3] << 24) | (frame[4] << 16) | (frame[5] << 8) | frame[6]);
                var success = readBack == rawValue;
                logger.LogInformation("Write verification for {Key}: written={Written}, readBack={ReadBack}, success={Success}.",
                    parameterKey, rawValue, readBack, success);

                return new WriteRegisterResult(success, rawValue, readBack,
                    success ? null : $"Read-back mismatch: expected {rawValue}, got {readBack}");
            }

            return new WriteRegisterResult(false, rawValue, null, "Unable to read back register value after write.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw new TimeoutException($"Write timeout exceeded for parameter {parameterKey}.");
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw;
        }
        finally
        {
            if (cancellationToken.IsCancellationRequested)
            {
                ClosePort();
            }

            _busLock.Release();
        }
    }

    private async Task<byte[]> SendAndReceiveAsync(SerialPort serialPort, byte[] request, int expectedLen, int readTimeout, CancellationToken cancellationToken)
    {
        await serialPort.BaseStream.WriteAsync(request, cancellationToken);
        await serialPort.BaseStream.FlushAsync(cancellationToken);
        return await ReadModbusResponseAsync(serialPort.BaseStream, expectedLen, readTimeout, cancellationToken);
    }

    private void ClosePort()
    {
        try { _serialPort?.Close(); } catch { /* best-effort */ }
        try { _serialPort?.Dispose(); } catch { /* best-effort */ }
        _serialPort = null;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _serialPort?.Dispose();
        _busLock.Dispose();
    }

    private SerialPort EnsurePort(TransportConfiguration? transport)
    {
        var portName = transport?.PortName ?? _configuration.SerialBus.PortName;

        if (_serialPort is { IsOpen: true } && _serialPort.PortName == portName)
        {
            return _serialPort;
        }

        _serialPort?.Dispose();

        var baudRate = transport?.BaudRate ?? _configuration.SerialBus.BaudRate;
        var dataBits = transport?.DataBits ?? _configuration.SerialBus.DataBits;
        var parity = transport?.Parity ?? _configuration.SerialBus.Parity;
        var stopBits = transport?.StopBits ?? _configuration.SerialBus.StopBits;
        var readTimeout = transport?.ReadTimeoutMs ?? _configuration.SerialBus.ReadTimeoutMilliseconds;
        var writeTimeout = transport?.WriteTimeoutMs ?? _configuration.SerialBus.WriteTimeoutMilliseconds;

        _serialPort = new SerialPort(portName)
        {
            BaudRate = baudRate,
            DataBits = dataBits,
            Parity = ParseParity(parity),
            StopBits = ParseStopBits(stopBits),
            ReadTimeout = readTimeout,
            WriteTimeout = writeTimeout,
            Handshake = Handshake.None
        };

        _serialPort.Open();
        return _serialPort;
    }

    private static async Task<byte[]> ReadModbusResponseAsync(Stream stream, int expectedLength, int readTimeoutMs, CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(readTimeoutMs);
        var linkedToken = timeoutCts.Token;

        var buffer = new byte[expectedLength];
        var totalRead = 0;

        try
        {
            while (totalRead < expectedLength)
            {
                linkedToken.ThrowIfCancellationRequested();

                var bytesRead = await stream.ReadAsync(buffer.AsMemory(totalRead, expectedLength - totalRead), linkedToken);
                if (bytesRead == 0)
                {
                    await Task.Delay(1, linkedToken);
                    continue;
                }

                totalRead += bytesRead;

                // After reading at least 3 bytes, check for Modbus exception (shorter response)
                if (totalRead >= 5 && (buffer[1] & 0x80) != 0)
                {
                    // Exception response is always 5 bytes: [addr][func|0x80][exception_code][crc_lo][crc_hi]
                    return buffer[..5];
                }
            }

            return buffer;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException($"Timed out after {readTimeoutMs}ms waiting for Modbus RTU response (received {totalRead} of {expectedLength} bytes).");
        }
    }

    private static Parity ParseParity(string parity)
    {
        return Enum.TryParse<Parity>(parity, ignoreCase: true, out var value)
            ? value
            : throw new InvalidOperationException($"Unsupported parity '{parity}'.");
    }

    private static StopBits ParseStopBits(string stopBits)
    {
        return Enum.TryParse<StopBits>(stopBits, ignoreCase: true, out var value)
            ? value
            : throw new InvalidOperationException($"Unsupported stop bits '{stopBits}'.");
    }
}