using System.IO.Ports;
using System.Runtime.InteropServices;
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

            var request = JkRs485Protocol.BuildReadAllRequest(device.Address);
            logger.LogDebug("Polling JK device {DeviceId} on {PortName} with address {Address}.", device.DeviceId, serialPort.PortName, device.Address);

            await serialPort.BaseStream.WriteAsync(request, pollToken);
            await serialPort.BaseStream.FlushAsync(pollToken);

            var response = await ReadFrameAsync(serialPort.BaseStream, readTimeout, cancellationToken);
            var registerDefs = profile.Registers;
            return JkRs485Protocol.ParseReadAllResponse(response, DateTimeOffset.UtcNow, registerDefs);
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

    private static async Task<byte[]> ReadFrameAsync(Stream stream, int readTimeoutMs, CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(readTimeoutMs);
        var linkedToken = timeoutCts.Token;

        var buffer = new List<byte>(384);
        var oneByte = new byte[1];

        try
        {
            while (true)
            {
                linkedToken.ThrowIfCancellationRequested();

                var bytesRead = await stream.ReadAsync(oneByte.AsMemory(0, 1), linkedToken);
                if (bytesRead == 0)
                {
                    continue;
                }

                buffer.Add(oneByte[0]);

                if (buffer.Count == 1 && buffer[0] != 0x4E)
                {
                    buffer.Clear();
                    continue;
                }

                if (buffer.Count == 2 && (buffer[0] != 0x4E || buffer[1] != 0x57))
                {
                    buffer.Clear();
                    continue;
                }

                if (buffer.Count >= 4)
                {
                    var expectedLength = JkRs485Protocol.GetExpectedFrameLength(CollectionsMarshal.AsSpan(buffer));
                    if (expectedLength < 17 || expectedLength > 1024)
                    {
                        throw new InvalidDataException($"JK response frame declared an invalid length of {expectedLength} bytes.");
                    }

                    if (buffer.Count == expectedLength)
                    {
                        return buffer.ToArray();
                    }
                }
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException($"Timed out after {readTimeoutMs}ms waiting for a JK RS485 response frame (received {buffer.Count} bytes).");
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