using System.IO.Ports;
using JkMonitor.Backend.Models;
using JkMonitor.Backend.Protocol;
using JkMonitor.Contracts.Configuration;
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

    public async Task<DevicePollResult> PollAsync(DeviceConfiguration device, DeviceProfileConfiguration profile, CancellationToken cancellationToken)
    {
        var transport = profile.Transport;
        var readTimeout = transport?.ReadTimeoutMs ?? _configuration.SerialBus.ReadTimeoutMilliseconds;
        var overallTimeoutMs = readTimeout * 3;

        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        pollCts.CancelAfter(overallTimeoutMs);
        var pollToken = pollCts.Token;

        await _busLock.WaitAsync(pollToken);

        try
        {
            var serialPort = EnsurePort(transport);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            const ushort registerCount = JkModbusProtocol.LiveDataRegisterCount;
            var request = JkModbusProtocol.BuildReadLiveDataRequest(device.Address);
            logger.LogDebug("Polling JK device {DeviceId} (Modbus RTU) on {PortName} with address {Address}.", device.DeviceId, serialPort.PortName, device.Address);

            await serialPort.BaseStream.WriteAsync(request, pollToken);
            await serialPort.BaseStream.FlushAsync(pollToken);

            var expectedLen = JkModbusProtocol.ExpectedResponseLength(registerCount);
            var response = await ReadModbusResponseAsync(serialPort.BaseStream, expectedLen, readTimeout, cancellationToken);
            var registerDefs = profile.Registers;
            return JkModbusProtocol.ParseLiveDataResponse(response, device.Address, DateTimeOffset.UtcNow, registerDefs);
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
            _busLock.Release();
        }
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