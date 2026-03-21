using System.IO.Ports;
using System.Runtime.InteropServices;
using JkMonitor.Backend.Protocol;
using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public interface IJkPollingClient
{
    Task<JkParsedSample> PollAsync(BmsDeviceConfiguration device, CancellationToken cancellationToken);
}

public sealed class JkRs485PollingClient(
    IOptions<MonitorConfiguration> configuration,
    ILogger<JkRs485PollingClient> logger) : IJkPollingClient, IDisposable
{
    private readonly MonitorConfiguration _configuration = configuration.Value;
    private readonly SemaphoreSlim _busLock = new(1, 1);
    private SerialPort? _serialPort;
    private bool _disposed;

    public async Task<JkParsedSample> PollAsync(BmsDeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!string.Equals(device.Protocol, "jk-rs485", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Unsupported protocol '{device.Protocol}'.");
        }

        await _busLock.WaitAsync(cancellationToken);

        try
        {
            var serialPort = EnsurePort();
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            var request = JkRs485Protocol.BuildReadAllRequest(device.Address);
            logger.LogDebug("Polling JK device {DeviceId} on {PortName} with address {Address}.", device.DeviceId, serialPort.PortName, device.Address);

            await serialPort.BaseStream.WriteAsync(request, cancellationToken);
            await serialPort.BaseStream.FlushAsync(cancellationToken);

            var response = await ReadFrameAsync(serialPort.BaseStream, cancellationToken);
            return JkRs485Protocol.ParseReadAllResponse(response, DateTimeOffset.UtcNow);
        }
        finally
        {
            _busLock.Release();
        }
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

    private SerialPort EnsurePort()
    {
        if (_serialPort is { IsOpen: true })
        {
            return _serialPort;
        }

        _serialPort?.Dispose();

        var serialBus = _configuration.SerialBus;
        _serialPort = new SerialPort(serialBus.PortName)
        {
            BaudRate = serialBus.BaudRate,
            DataBits = serialBus.DataBits,
            Parity = ParseParity(serialBus.Parity),
            StopBits = ParseStopBits(serialBus.StopBits),
            ReadTimeout = serialBus.ReadTimeoutMilliseconds,
            WriteTimeout = serialBus.WriteTimeoutMilliseconds,
            Handshake = Handshake.None
        };

        _serialPort.Open();
        return _serialPort;
    }

    private async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var buffer = new List<byte>(384);
        var oneByte = new byte[1];
        var startedAt = DateTime.UtcNow;
        var timeout = TimeSpan.FromMilliseconds(_configuration.SerialBus.ReadTimeoutMilliseconds);

        while (!cancellationToken.IsCancellationRequested)
        {
            if (DateTime.UtcNow - startedAt > timeout)
            {
                throw new TimeoutException("Timed out waiting for a JK RS485 response frame.");
            }

            var bytesRead = await stream.ReadAsync(oneByte.AsMemory(0, 1), cancellationToken);
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

        throw new OperationCanceledException(cancellationToken);
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