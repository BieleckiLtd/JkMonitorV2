namespace FluxMonitor.Backend.Protocol;

/// <summary>
/// Generic Modbus RTU framing utilities: CRC, request builders, response validation.
/// Extracted from JkModbusProtocol for reuse by the definition-driven polling client.
/// </summary>
internal static class ModbusRtu
{
    public static ushort ComputeCrc16(ReadOnlySpan<byte> data)
    {
        ushort crc = 0xFFFF;
        foreach (var b in data)
        {
            crc ^= b;
            for (var i = 0; i < 8; i++)
            {
                if ((crc & 1) != 0)
                {
                    crc >>= 1;
                    crc ^= 0xA001;
                }
                else
                {
                    crc >>= 1;
                }
            }
        }
        return crc;
    }

    /// <summary>
    /// Build a Modbus RTU "Read Holding Registers" (function code 0x03) request.
    /// </summary>
    public static byte[] BuildReadHoldingRegistersRequest(byte slaveAddress, ushort startRegister, ushort registerCount)
    {
        var request = new byte[8];
        request[0] = slaveAddress;
        request[1] = 0x03;
        request[2] = (byte)(startRegister >> 8);
        request[3] = (byte)(startRegister & 0xFF);
        request[4] = (byte)(registerCount >> 8);
        request[5] = (byte)(registerCount & 0xFF);
        var crc = ComputeCrc16(request.AsSpan(0, 6));
        request[6] = (byte)(crc & 0xFF);
        request[7] = (byte)((crc >> 8) & 0xFF);
        return request;
    }

    /// <summary>
    /// Build a Modbus RTU "Write Multiple Registers" (function code 0x10) request.
    /// Writes a UINT32 value (2 registers) at the specified address.
    /// </summary>
    public static byte[] BuildWriteMultipleRegistersRequest(byte slaveAddress, ushort startRegister, uint value)
    {
        var request = new byte[13];
        request[0] = slaveAddress;
        request[1] = 0x10;
        request[2] = (byte)(startRegister >> 8);
        request[3] = (byte)(startRegister & 0xFF);
        request[4] = 0x00;
        request[5] = 0x02;
        request[6] = 0x04;
        request[7] = (byte)(value >> 24);
        request[8] = (byte)(value >> 16);
        request[9] = (byte)(value >> 8);
        request[10] = (byte)(value & 0xFF);
        var crc = ComputeCrc16(request.AsSpan(0, 11));
        request[11] = (byte)(crc & 0xFF);
        request[12] = (byte)((crc >> 8) & 0xFF);
        return request;
    }

    /// <summary>
    /// Expected response length for a Modbus RTU read response.
    /// </summary>
    public static int ExpectedReadResponseLength(ushort registerCount)
        => 3 + registerCount * 2 + 2;

    /// <summary>
    /// Expected response length for a Modbus function 0x10 write response (always 8 bytes).
    /// </summary>
    public const int WriteResponseLength = 8;

    /// <summary>
    /// Validate a Modbus RTU response frame. Returns the data payload (excluding header and CRC).
    /// </summary>
    public static ReadOnlySpan<byte> ValidateAndExtractData(byte[] frame, byte expectedSlaveAddress, byte expectedFunctionCode)
    {
        if (frame.Length < 5)
            throw new InvalidDataException($"Modbus response too short ({frame.Length} bytes).");

        if (frame[0] != expectedSlaveAddress)
            throw new InvalidDataException($"Modbus response slave address mismatch. Expected 0x{expectedSlaveAddress:X2}, got 0x{frame[0]:X2}.");

        if ((frame[1] & 0x80) != 0)
        {
            var exceptionCode = frame.Length > 2 ? frame[2] : 0;
            throw new InvalidDataException($"Modbus exception response: function 0x{frame[1]:X2}, exception code 0x{exceptionCode:X2}.");
        }

        if (frame[1] != expectedFunctionCode)
            throw new InvalidDataException($"Modbus response function code mismatch. Expected 0x{expectedFunctionCode:X2}, got 0x{frame[1]:X2}.");

        if (expectedFunctionCode == 0x10)
        {
            if (frame.Length < 8)
                throw new InvalidDataException($"Modbus write response too short ({frame.Length} bytes, expected 8).");
            var crc = ComputeCrc16(frame.AsSpan(0, 6));
            var receivedCrc = (ushort)(frame[6] | (frame[7] << 8));
            if (crc != receivedCrc)
                throw new InvalidDataException($"Modbus CRC mismatch. Computed 0x{crc:X4}, received 0x{receivedCrc:X4}.");
            return ReadOnlySpan<byte>.Empty;
        }

        var byteCount = frame[2];
        var expectedLength = 3 + byteCount + 2;
        if (frame.Length < expectedLength)
            throw new InvalidDataException($"Modbus response length mismatch. Expected {expectedLength}, got {frame.Length}.");

        var readCrc = ComputeCrc16(frame.AsSpan(0, frame.Length - 2));
        var readReceivedCrc = (ushort)(frame[^2] | (frame[^1] << 8));
        if (readCrc != readReceivedCrc)
            throw new InvalidDataException($"Modbus CRC mismatch. Computed 0x{readCrc:X4}, received 0x{readReceivedCrc:X4}.");

        return frame.AsSpan(3, byteCount);
    }

    /// <summary>
    /// Read a complete Modbus RTU response from a stream.
    /// </summary>
    public static async Task<byte[]> ReadResponseAsync(Stream stream, int expectedLength, int readTimeoutMs, CancellationToken cancellationToken)
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

                // Modbus exception response is always 5 bytes
                if (totalRead >= 5 && (buffer[1] & 0x80) != 0)
                    return buffer[..5];
            }

            return buffer;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException($"Timed out after {readTimeoutMs}ms waiting for Modbus RTU response (received {totalRead} of {expectedLength} bytes).");
        }
    }
}
