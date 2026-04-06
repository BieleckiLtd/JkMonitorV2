using System.Text;
using FluxMonitor.Backend.Protocol;
using FluxMonitor.Contracts.DeviceDefinition;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class AsciiHexFramedProtocolTests
{
    [Fact]
    public void EncodeAndDecodeLength_RoundTripsNibbleChecksumEncoding()
    {
        var encoded = AsciiHexFramedProtocol.EncodeLength(8, "nibble-checksum-12bit");

        var valid = AsciiHexFramedProtocol.TryDecodeLength(encoded, "nibble-checksum-12bit", out var decoded);

        Assert.True(valid);
        Assert.Equal(8, decoded);
    }

    [Fact]
    public void BuildCommand_UsesConfiguredAsciiHexFrameFields()
    {
        var frame = AsciiHexFramedProtocol.BuildCommand(0x02, 0x42, CreateFraming(), "FF"u8);
        var text = Encoding.ASCII.GetString(frame);

        Assert.StartsWith("~20024642E002FF", text);
        Assert.EndsWith("\r", text);
    }

    [Fact]
    public void ValidateAndExtractPayload_DecodesConfiguredSuccessFrame()
    {
        var frame = AsciiHexFramedProtocol.BuildCommand(0x02, 0x00, CreateFraming(), "01020304"u8);

        var payload = AsciiHexFramedProtocol.ValidateAndExtractPayload(frame, CreateFraming());

        Assert.Equal(new byte[] { 0x01, 0x02, 0x03, 0x04 }, payload);
    }

    [Fact]
    public void ValidateAndExtractPayload_RejectsNonSuccessStatus()
    {
        var frame = AsciiHexFramedProtocol.BuildCommand(0x02, 0x91, CreateFraming(), "00"u8);

        var ex = Assert.Throws<InvalidDataException>(() =>
            AsciiHexFramedProtocol.ValidateAndExtractPayload(frame, CreateFraming()));

        Assert.Contains("Status=0x91", ex.Message);
    }

    private static AsciiHexFrameSettings CreateFraming()
        => new()
        {
            StartByte = 126,
            EndByte = 13,
            Version = 32,
            VersionOffsetChars = 0,
            AddressOffsetChars = 2,
            RequestCommandSet = 70,
            RequestCommandSetOffsetChars = 4,
            CommandOffsetChars = 6,
            LengthOffsetChars = 8,
            PayloadOffsetChars = 12,
            LengthCharCount = 4,
            ChecksumCharCount = 4,
            LengthEncoding = "nibble-checksum-12bit",
            FrameChecksumType = "ones-complement-sum16",
            ResponseSuccessCode = 0
        };
}