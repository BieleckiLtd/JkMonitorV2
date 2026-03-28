using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.DeviceDefinition;
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
            JkResponsePreamble,
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
            JkResponsePreamble,
            "sum8",
            out var frame,
            out var discardedInvalidFrame);

        Assert.True(extracted);
        Assert.True(discardedInvalidFrame);
        Assert.NotNull(frame);
        Assert.Equal(validFrame, frame);
        Assert.Empty(buffer);
    }

    [Fact]
    public void ResolveFrameWriteTarget_MapsConfiguredByteOffsetStrategyToHoldingRegister()
    {
        var entity = CreateEntity("charge_switch", 112, "uint32");
        var write = new DataSourceWriteDefinition
        {
            Type = "frame-register",
            AddressBase = 1,
            AddressStepBytes = 4
        };

        var target = GenericBlePollingClient.ResolveFrameWriteTarget(entity, write);

        Assert.Equal(0x1D, target.RegisterAddress);
        Assert.Equal(0x04, target.ValueLength);
    }

    [Fact]
    public void ResolveFrameWriteTarget_HonorsEntityWriteOverride()
    {
        var entity = new EntityDefinition
        {
            Id = "custom_write",
            Type = "number",
            Name = "custom_write",
            Category = "Config",
            Writable = true,
            Source = new EntitySourceDefinition
            {
                Bank = "config",
                ByteOffset = 167,
                DataType = "uint8"
            },
            Write = new EntityWriteDefinition
            {
                Address = 0xB7,
                ValueLength = 0x01
            }
        };
        var write = new DataSourceWriteDefinition
        {
            Type = "frame-register",
            AddressBase = 1,
            AddressStepBytes = 4
        };

        var target = GenericBlePollingClient.ResolveFrameWriteTarget(entity, write);

        Assert.Equal(0xB7, target.RegisterAddress);
        Assert.Equal(0x01, target.ValueLength);
    }

    [Fact]
    public void ResolveFrameWriteTarget_RejectsUnalignedOffsetsWithoutConfiguredOverride()
    {
        var entity = CreateEntity("state_of_charge", 167, "uint8");
        var write = new DataSourceWriteDefinition
        {
            Type = "frame-register",
            AddressBase = 1,
            AddressStepBytes = 4
        };

        var exception = Assert.Throws<InvalidOperationException>(() => GenericBlePollingClient.ResolveFrameWriteTarget(entity, write));

        Assert.Contains("cannot be mapped", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void BuildBleFrameWriteCommand_EncodesPayloadAndChecksum()
    {
        var frame = GenericBlePollingClient.BuildBleFrameWriteCommand(
            new BleFrameWriteTarget(0x1D, 0x04),
            0x01020304,
            CreateJkProtocolSettings());

        Assert.Equal(
            new byte[]
            {
                0xAA, 0x55, 0x90, 0xEB, 0x1D, 0x04, 0x04, 0x03, 0x02, 0x01,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xA5
            },
            frame);
    }

    [Fact]
    public void BuildBleFrameWriteCommand_HonorsConfiguredOffsetsAndByteOrder()
    {
        var settings = new ProtocolSettings
        {
            RequestFrameSize = 12,
            RequestPreamble = [0x10, 0x20],
            ChecksumType = "none",
            WriteRegisterOffset = 2,
            WriteValueLengthOffset = 3,
            WriteValueOffset = 4,
            WriteValueByteOrder = "big-endian"
        };

        var frame = GenericBlePollingClient.BuildBleFrameWriteCommand(
            new BleFrameWriteTarget(0x2A, 0x02),
            0x00001234,
            settings);

        Assert.Equal(
            new byte[]
            {
                0x10, 0x20, 0x2A, 0x02, 0x12, 0x34,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00
            },
            frame);
    }

    [Fact]
    public void TryReadRawValue_ReadsLittleEndianUInt32()
    {
        var entity = CreateEntity("max_charge_current", 44, "uint32");
        var payload = new byte[80];
        payload[44] = 0xB8;
        payload[45] = 0x0B;
        payload[46] = 0x00;
        payload[47] = 0x00;

        var read = GenericBlePollingClient.TryReadRawValue(entity, payload, "little-endian", out var rawValue);

        Assert.True(read);
        Assert.Equal(3000u, rawValue);
    }

    private static byte[] BuildFrame(int size, byte frameType)
    {
        var frame = new byte[size];
        frame[0] = JkResponsePreamble[0];
        frame[1] = JkResponsePreamble[1];
        frame[2] = JkResponsePreamble[2];
        frame[3] = JkResponsePreamble[3];
        frame[4] = frameType;

        for (var i = 5; i < size - 1; i++)
            frame[i] = (byte)(i & 0xFF);

        byte checksum = 0;
        for (var i = 0; i < size - 1; i++)
            checksum += frame[i];

        frame[^1] = checksum;
        return frame;
    }

    private static ProtocolSettings CreateJkProtocolSettings()
        => new()
        {
            RequestFrameSize = 20,
            RequestPreamble = [0xAA, 0x55, 0x90, 0xEB],
            ChecksumType = "sum8",
            WriteRegisterOffset = 4,
            WriteValueLengthOffset = 5,
            WriteValueOffset = 6,
            WriteValueByteOrder = "little-endian"
        };

    private static readonly byte[] JkResponsePreamble = [0x55, 0xAA, 0xEB, 0x90];

    private static EntityDefinition CreateEntity(string id, int byteOffset, string dataType)
        => new()
        {
            Id = id,
            Type = "number",
            Name = id,
            Category = "Config",
            Writable = true,
            Source = new EntitySourceDefinition
            {
                Bank = "config",
                ByteOffset = byteOffset,
                DataType = dataType
            }
        };
}
