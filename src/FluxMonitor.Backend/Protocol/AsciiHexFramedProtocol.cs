using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Protocol;

/// <summary>
/// Generic helper for serial protocols that exchange ASCII-hex framed messages.
///
/// Layout is defined by <see cref="AsciiHexFrameSettings"/> rather than hardcoded
/// per-vendor constants. The payload passed to <see cref="BuildCommand"/> is expected
/// to already be ASCII-hex encoded when present.
/// </summary>
internal static class AsciiHexFramedProtocol
{
    public static byte[] BuildCommand(
        byte address,
        byte command,
        AsciiHexFrameSettings framing,
        ReadOnlySpan<byte> payloadAsciiHex = default)
    {
        var requiredPrefixLength = GetRequiredPrefixLength(framing);
        var bodyLength = requiredPrefixLength + payloadAsciiHex.Length;
        var encodedLength = EncodeLength(payloadAsciiHex.Length, framing.LengthEncoding);

        Span<byte> body = stackalloc byte[bodyLength];
        FormatHex(body, framing.VersionOffsetChars, framing.Version, 2);
        FormatHex(body, framing.AddressOffsetChars, address, 2);
        FormatHex(body, framing.RequestCommandSetOffsetChars, framing.RequestCommandSet, 2);
        FormatHex(body, framing.CommandOffsetChars, command, 2);
        FormatHex(body, framing.LengthOffsetChars, encodedLength, framing.LengthCharCount);
        payloadAsciiHex.CopyTo(body[framing.PayloadOffsetChars..]);

        var checksum = ComputeChecksum(body, framing.FrameChecksumType);
        var frame = new byte[1 + bodyLength + framing.ChecksumCharCount + 1];
        frame[0] = framing.StartByte;
        body.CopyTo(frame.AsSpan(1));
        FormatHex(frame.AsSpan(1 + bodyLength), 0, checksum, framing.ChecksumCharCount);
        frame[^1] = framing.EndByte;

        return frame;
    }

    public static byte[] ValidateAndExtractPayload(ReadOnlySpan<byte> rawFrame, AsciiHexFrameSettings framing)
    {
        var requiredPrefixLength = GetRequiredPrefixLength(framing);
        var minimumLength = 1 + requiredPrefixLength + framing.ChecksumCharCount + 1;
        if (rawFrame.Length < minimumLength)
            throw new InvalidDataException($"ASCII-hex frame too short ({rawFrame.Length} bytes).");

        if (rawFrame[0] != framing.StartByte)
            throw new InvalidDataException($"ASCII-hex frame missing SOF. Got 0x{rawFrame[0]:X2}.");

        if (rawFrame[^1] != framing.EndByte)
            throw new InvalidDataException($"ASCII-hex frame missing EOF. Got 0x{rawFrame[^1]:X2}.");

        var bodyEnd = rawFrame.Length - framing.ChecksumCharCount - 1;
        var body = rawFrame[1..bodyEnd];
        if (body.Length < requiredPrefixLength)
            throw new InvalidDataException("ASCII-hex frame body too short for configured header.");

        var receivedChecksum = ParseHex(rawFrame.Slice(bodyEnd, framing.ChecksumCharCount));
        var computedChecksum = ComputeChecksum(body, framing.FrameChecksumType);
        if (receivedChecksum != computedChecksum)
        {
            throw new InvalidDataException(
                $"ASCII-hex checksum mismatch. Computed 0x{computedChecksum:X}, received 0x{receivedChecksum:X}.");
        }

        var status = ParseHex(body.Slice(framing.CommandOffsetChars, 2));
        if (status != framing.ResponseSuccessCode)
            throw new InvalidDataException($"ASCII-hex error response. Status=0x{status:X2}.");

        var encodedLength = ParseHex(body.Slice(framing.LengthOffsetChars, framing.LengthCharCount));
        if (!TryDecodeLength(encodedLength, framing.LengthEncoding, out var payloadHexLength))
            throw new InvalidDataException($"ASCII-hex length field invalid: 0x{encodedLength:X}.");

        var payloadHex = body[framing.PayloadOffsetChars..];
        if (payloadHex.Length != payloadHexLength)
        {
            throw new InvalidDataException(
                $"ASCII-hex payload length mismatch. Expected {payloadHexLength} chars, got {payloadHex.Length}.");
        }

        return HexToBytes(payloadHex);
    }

    public static async Task<byte[]> ReadFrameAsync(
        Stream stream,
        AsciiHexFrameSettings framing,
        int readTimeoutMs,
        CancellationToken cancellationToken)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(readTimeoutMs);
        var linkedToken = timeoutCts.Token;

        var buffer = new byte[4096];
        var totalRead = 0;

        try
        {
            while (totalRead < buffer.Length)
            {
                linkedToken.ThrowIfCancellationRequested();

                var bytesRead = await stream.ReadAsync(buffer.AsMemory(totalRead, buffer.Length - totalRead), linkedToken);
                if (bytesRead == 0)
                {
                    await Task.Delay(1, linkedToken);
                    continue;
                }

                totalRead += bytesRead;
                if (buffer[totalRead - 1] == framing.EndByte)
                    break;
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException($"ASCII-hex framed serial read timeout ({readTimeoutMs}ms). Read {totalRead} bytes.");
        }

        if (totalRead == 0)
            throw new InvalidDataException("ASCII-hex framed serial: no data received.");

        return buffer[..totalRead];
    }

    public static uint ComputeChecksum(ReadOnlySpan<byte> asciiBody, string checksumType)
    {
        return checksumType.ToLowerInvariant() switch
        {
            "none" => 0,
            "ones-complement-sum16" => ComputeOnesComplementSum16(asciiBody),
            _ => throw new NotSupportedException($"Unsupported ASCII-hex frame checksum type '{checksumType}'.")
        };
    }

    public static uint EncodeLength(int dataLength, string lengthEncoding)
    {
        return lengthEncoding.ToLowerInvariant() switch
        {
            "plain" => (uint)dataLength,
            "plain-12bit" => (uint)(dataLength & 0xFFF),
            "nibble-checksum-12bit" => EncodeNibbleChecksum12BitLength(dataLength),
            _ => throw new NotSupportedException($"Unsupported ASCII-hex length encoding '{lengthEncoding}'.")
        };
    }

    public static bool TryDecodeLength(uint encoded, string lengthEncoding, out int dataLength)
    {
        switch (lengthEncoding.ToLowerInvariant())
        {
            case "plain":
                dataLength = checked((int)encoded);
                return true;

            case "plain-12bit":
                dataLength = (int)(encoded & 0xFFF);
                return true;

            case "nibble-checksum-12bit":
                dataLength = (int)(encoded & 0xFFF);
                if (dataLength == 0 && encoded == 0)
                    return true;

                var expectedCheck = (int)((encoded >> 12) & 0xF);
                var nibbleSum = (dataLength & 0xF)
                              + ((dataLength >> 4) & 0xF)
                              + ((dataLength >> 8) & 0xF);
                var modulo = nibbleSum % 16;
                var actualCheck = (0xF - modulo + 1) & 0xF;
                return expectedCheck == actualCheck;

            default:
                throw new NotSupportedException($"Unsupported ASCII-hex length encoding '{lengthEncoding}'.");
        }
    }

    private static uint ComputeOnesComplementSum16(ReadOnlySpan<byte> asciiBody)
    {
        var sum = 0;
        foreach (var b in asciiBody)
            sum += b;

        sum = ~sum & 0xFFFF;
        sum = (sum + 1) & 0xFFFF;
        return (uint)sum;
    }

    private static uint EncodeNibbleChecksum12BitLength(int dataLength)
    {
        if (dataLength == 0)
            return 0;

        var nibbleSum = (dataLength & 0xF)
                      + ((dataLength >> 4) & 0xF)
                      + ((dataLength >> 8) & 0xF);
        var modulo = nibbleSum % 16;
        var check = (0xF - modulo + 1) & 0xF;
        return (uint)((check << 12) | (dataLength & 0xFFF));
    }

    private static int GetRequiredPrefixLength(AsciiHexFrameSettings framing)
    {
        return new[]
        {
            framing.VersionOffsetChars + 2,
            framing.AddressOffsetChars + 2,
            framing.RequestCommandSetOffsetChars + 2,
            framing.CommandOffsetChars + 2,
            framing.LengthOffsetChars + framing.LengthCharCount,
            framing.PayloadOffsetChars
        }.Max();
    }

    private static void FormatHex(Span<byte> dest, int offset, uint value, int charCount)
    {
        for (var i = charCount - 1; i >= 0; i--)
        {
            dest[offset + i] = ToHexChar((byte)(value & 0x0F));
            value >>= 4;
        }
    }

    private static byte ToHexChar(byte nibble)
        => nibble < 10 ? (byte)('0' + nibble) : (byte)('A' + nibble - 10);

    private static uint ParseHex(ReadOnlySpan<byte> hex)
    {
        uint value = 0;
        for (var i = 0; i < hex.Length; i++)
            value = (value << 4) | (uint)FromHexChar(hex[i]);
        return value;
    }

    private static int FromHexChar(byte c) => c switch
    {
        >= (byte)'0' and <= (byte)'9' => c - '0',
        >= (byte)'A' and <= (byte)'F' => c - 'A' + 10,
        >= (byte)'a' and <= (byte)'f' => c - 'a' + 10,
        _ => throw new InvalidDataException($"Invalid hex character: 0x{c:X2} ('{(char)c}').")
    };

    private static byte[] HexToBytes(ReadOnlySpan<byte> hex)
    {
        if (hex.Length % 2 != 0)
            throw new InvalidDataException($"ASCII-hex payload has odd length: {hex.Length}.");

        var result = new byte[hex.Length / 2];
        for (var i = 0; i < result.Length; i++)
            result[i] = (byte)((FromHexChar(hex[i * 2]) << 4) | FromHexChar(hex[i * 2 + 1]));

        return result;
    }
}