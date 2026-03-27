using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class GenericBlePollingClientFrameTests
{
    [Fact]
    public void TryExtractValidatedFrame_RealignsBufferToNextPreamble()
    {
        var validFrame = BuildFrame(300, 0x02);
        var buffer = new List<byte>();
        buffer.AddRange(new byte[] { 0x00, 0x11, 0x22, 0x33, 0x44 });
        buffer.AddRange(validFrame);

        var extracted = GenericBlePollingClient.TryExtractValidatedFrame(
            buffer,
            300,
            "sum8",
            out var frame,
            out var discardedInvalidFrame);

        Assert.True(extracted);
        Assert.False(discardedInvalidFrame);
        Assert.NotNull(frame);
        Assert.Equal(300, frame!.Length);
        Assert.Equal(0x02, frame[4]);
        Assert.Empty(buffer);
    }

    [Fact]
    public void TryExtractValidatedFrame_DropsInvalidCandidateAndFindsFollowingValidFrame()
    {
        var invalidFrame = BuildFrame(300, 0x02);
        invalidFrame[299] ^= 0xFF;

        var validFrame = BuildFrame(300, 0x02);
        var buffer = new List<byte>();
        buffer.AddRange(invalidFrame);
        buffer.AddRange(validFrame);

        var extracted = GenericBlePollingClient.TryExtractValidatedFrame(
            buffer,
            300,
            "sum8",
            out var frame,
            out var discardedInvalidFrame);

        Assert.True(extracted);
        Assert.True(discardedInvalidFrame);
        Assert.NotNull(frame);
        Assert.Equal(validFrame, frame);
        Assert.Empty(buffer);
    }

    private static byte[] BuildFrame(int size, byte frameType)
    {
        var frame = new byte[size];
        frame[0] = 0x55;
        frame[1] = 0xAA;
        frame[2] = 0xEB;
        frame[3] = 0x90;
        frame[4] = frameType;

        for (var i = 5; i < size - 1; i++)
            frame[i] = (byte)(i & 0xFF);

        byte checksum = 0;
        for (var i = 0; i < size - 1; i++)
            checksum += frame[i];

        frame[^1] = checksum;
        return frame;
    }
}
