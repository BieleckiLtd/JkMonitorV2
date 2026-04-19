using System.IO.Ports;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Protocol;

namespace FluxMonitor.Backend.Services;

public sealed class ModbusScannerService(ILogger<ModbusScannerService> logger)
{
    private readonly SemaphoreSlim _scanLock = new(1, 1);

    public async Task<ModbusScannerReadResult> ReadAsync(ModbusScannerReadRequest request, CancellationToken cancellationToken)
    {
        var normalized = NormalizeRequest(request);
        var functionCode = GetFunctionCode(normalized.RegisterKind);
        var blocks = BuildBlocks(normalized.StartRegister, normalized.RegisterCount, normalized.RegistersPerRequest);
        var result = new ModbusScannerReadResult
        {
            PortName = normalized.PortName,
            SlaveAddress = normalized.SlaveAddress,
            BaudRate = normalized.BaudRate,
            Parity = normalized.Parity,
            DataBits = normalized.DataBits,
            StopBits = normalized.StopBits,
            ResponseTimeoutMs = normalized.ResponseTimeoutMs,
            RetryCount = normalized.RetryCount,
            RegisterKind = normalized.RegisterKind,
            StartRegister = normalized.StartRegister,
            RegisterCount = normalized.RegisterCount,
            RegistersPerRequest = normalized.RegistersPerRequest,
            CollectedAtUtc = DateTime.UtcNow.ToString("O"),
            TotalRequests = blocks.Count
        };

        await _scanLock.WaitAsync(cancellationToken);
        try
        {
            using var serialPort = CreatePort(normalized);
            serialPort.Open();

            foreach (var block in blocks)
            {
                var data = await ReadBlockWithRetryAsync(serialPort, normalized, functionCode, block, cancellationToken);
                result.Blocks.Add(new ModbusScannerReadBlock
                {
                    StartAddress = block.StartAddress,
                    RegisterCount = block.RegisterCount,
                    Attempts = block.AttemptsUsed
                });

                for (var index = 0; index < block.RegisterCount; index++)
                {
                    var byteOffset = index * 2;
                    var highByte = data[byteOffset];
                    var lowByte = data[byteOffset + 1];
                    var value = (highByte << 8) | lowByte;
                    result.Registers.Add(new ModbusScannerRegisterValue
                    {
                        Address = block.StartAddress + index,
                        HighByte = highByte,
                        LowByte = lowByte,
                        UnsignedValue = value,
                        HexValue = $"0x{value:X4}"
                    });
                }
            }

            return result;
        }
        finally
        {
            _scanLock.Release();
        }
    }

    private async Task<byte[]> ReadBlockWithRetryAsync(
        SerialPort serialPort,
        ModbusScannerReadRequest request,
        byte functionCode,
        ModbusScanBlock block,
        CancellationToken cancellationToken)
    {
        Exception? lastError = null;

        for (var attempt = 1; attempt <= request.RetryCount + 1; attempt++)
        {
            block.AttemptsUsed = attempt;

            try
            {
                serialPort.DiscardInBuffer();
                serialPort.DiscardOutBuffer();

                var requestFrame = ModbusRtu.BuildReadRegistersRequest(
                    (byte)request.SlaveAddress,
                    functionCode,
                    (ushort)block.StartAddress,
                    (ushort)block.RegisterCount);
                var expectedLength = ModbusRtu.ExpectedReadResponseLength((ushort)block.RegisterCount);

                await serialPort.BaseStream.WriteAsync(requestFrame, cancellationToken);
                await serialPort.BaseStream.FlushAsync(cancellationToken);

                var response = await ModbusRtu.ReadResponseAsync(serialPort.BaseStream, expectedLength, request.ResponseTimeoutMs, cancellationToken);
                return ModbusRtu.ValidateAndExtractData(response, (byte)request.SlaveAddress, functionCode).ToArray();
            }
            catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
            {
                lastError = exception;
                logger.LogDebug(
                    exception,
                    "Modbus scanner read attempt failed. Port={PortName}, Slave={SlaveAddress}, StartRegister={StartRegister}, RegisterCount={RegisterCount}, Attempt={Attempt}/{AttemptCount}.",
                    request.PortName,
                    request.SlaveAddress,
                    block.StartAddress,
                    block.RegisterCount,
                    attempt,
                    request.RetryCount + 1);

                if (attempt > request.RetryCount)
                {
                    break;
                }
            }
        }

        throw new InvalidOperationException(
            $"Unable to read {request.RegisterKind} registers {block.StartAddress}-{block.StartAddress + block.RegisterCount - 1} after {request.RetryCount + 1} attempt(s).",
            lastError);
    }

    private static SerialPort CreatePort(ModbusScannerReadRequest request)
    {
        return new SerialPort(request.PortName)
        {
            BaudRate = request.BaudRate,
            DataBits = request.DataBits,
            Parity = ParseParity(request.Parity),
            StopBits = ParseStopBits(request.StopBits),
            ReadTimeout = request.ResponseTimeoutMs,
            WriteTimeout = request.ResponseTimeoutMs,
            Handshake = Handshake.None
        };
    }

    public static ModbusScannerReadRequest NormalizeRequest(ModbusScannerReadRequest request)
    {
        var portName = request.PortName.Trim();
        if (string.IsNullOrWhiteSpace(portName))
        {
            throw new InvalidOperationException("A COM port is required.");
        }

        var slaveAddress = Math.Clamp(request.SlaveAddress, 1, 247);
        var baudRate = Math.Clamp(request.BaudRate, 300, 921600);
        var dataBits = Math.Clamp(request.DataBits, 5, 8);
        var stopBits = request.StopBits is 2 ? 2 : 1;
        var responseTimeoutMs = Math.Clamp(request.ResponseTimeoutMs, 50, 30000);
        var retryCount = Math.Clamp(request.RetryCount, 0, 10);
        var startRegister = Math.Clamp(request.StartRegister, 0, ushort.MaxValue);
        var remainingRegisters = ushort.MaxValue - startRegister + 1;
        var registerCount = Math.Clamp(request.RegisterCount, 1, remainingRegisters);
        var registersPerRequest = Math.Clamp(request.RegistersPerRequest, 1, 125);
        var registerKind = NormalizeRegisterKind(request.RegisterKind);

        return new ModbusScannerReadRequest
        {
            PortName = portName,
            SlaveAddress = slaveAddress,
            BaudRate = baudRate,
            Parity = NormalizeParity(request.Parity),
            DataBits = dataBits,
            StopBits = stopBits,
            ResponseTimeoutMs = responseTimeoutMs,
            RetryCount = retryCount,
            StartRegister = startRegister,
            RegisterCount = registerCount,
            RegistersPerRequest = Math.Min(registersPerRequest, registerCount),
            RegisterKind = registerKind
        };
    }

    private static List<ModbusScanBlock> BuildBlocks(int startRegister, int registerCount, int registersPerRequest)
    {
        var blocks = new List<ModbusScanBlock>();
        var currentStart = startRegister;
        var remaining = registerCount;

        while (remaining > 0)
        {
            var blockCount = Math.Min(remaining, registersPerRequest);
            blocks.Add(new ModbusScanBlock
            {
                StartAddress = currentStart,
                RegisterCount = blockCount
            });

            currentStart += blockCount;
            remaining -= blockCount;
        }

        return blocks;
    }

    private static string NormalizeRegisterKind(string? registerKind)
    {
        return string.Equals(registerKind, "input", StringComparison.OrdinalIgnoreCase) ? "input" : "holding";
    }

    private static byte GetFunctionCode(string registerKind)
        => string.Equals(registerKind, "input", StringComparison.OrdinalIgnoreCase) ? (byte)0x04 : (byte)0x03;

    private static string NormalizeParity(string? parity)
        => Enum.TryParse<Parity>(parity, ignoreCase: true, out var value)
            ? value.ToString()
            : Parity.None.ToString();

    private static Parity ParseParity(string? parity)
        => Enum.TryParse<Parity>(parity, ignoreCase: true, out var value)
            ? value
            : Parity.None;

    private static StopBits ParseStopBits(int stopBits)
        => stopBits switch
        {
            2 => StopBits.Two,
            _ => StopBits.One
        };

    private sealed class ModbusScanBlock
    {
        public required int StartAddress { get; init; }
        public required int RegisterCount { get; init; }
        public int AttemptsUsed { get; set; }
    }
}
