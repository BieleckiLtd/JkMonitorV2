using FluxMonitor.Backend.Protocol;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class ModbusRtuTests
{
    [Fact]
    public void BuildWriteMultipleRegistersRequest_EncodesFullRegisterBlock()
    {
        var request = ModbusRtu.BuildWriteMultipleRegistersRequest(
            slaveAddress: 0x01,
            startRegister: 696,
            registerValues: [2026, 4, 18, 13, 47, 15]);

        Assert.Equal(21, request.Length);
        Assert.Equal(new byte[]
        {
            0x01, 0x10, 0x02, 0xB8, 0x00, 0x06, 0x0C,
            0x07, 0xEA, 0x00, 0x04, 0x00, 0x12, 0x00, 0x0D, 0x00, 0x2F, 0x00, 0x0F
        }, request[..19]);

        var crc = ModbusRtu.ComputeCrc16(request.AsSpan(0, 19));
        var frameCrc = (ushort)(request[19] | (request[20] << 8));
        Assert.Equal(crc, frameCrc);
    }

    [Fact]
    public void BuildWriteSingleRegisterRequest_EncodesSingleRegisterFrame()
    {
        var request = ModbusRtu.BuildWriteSingleRegisterRequest(
            slaveAddress: 0x01,
            registerAddress: 606,
            registerValue: 2300);

        Assert.Equal(8, request.Length);
        Assert.Equal(new byte[]
        {
            0x01, 0x06, 0x02, 0x5E, 0x08, 0xFC
        }, request[..6]);

        var crc = ModbusRtu.ComputeCrc16(request.AsSpan(0, 6));
        var frameCrc = (ushort)(request[6] | (request[7] << 8));
        Assert.Equal(crc, frameCrc);
    }

    [Theory]
    [InlineData(0x1234u, 1, 0x1234, 0)]
    [InlineData(0x12345678u, 2, 0x1234, 0x5678)]
    public void EncodeRegisterValues_MapsScalarValuesToRegisters(uint rawValue, int registerCount, ushort expectedHigh, ushort expectedLow)
    {
        var encoded = ModbusRtu.EncodeRegisterValues(rawValue, registerCount);

        if (registerCount == 1)
        {
            Assert.Equal([expectedHigh], encoded);
            return;
        }

        Assert.Equal([expectedHigh, expectedLow], encoded);
    }

    [Fact]
    public void ValidateAndExtractData_AcceptsWriteSingleRegisterResponse()
    {
        var response = ModbusRtu.BuildWriteSingleRegisterRequest(
            slaveAddress: 0x01,
            registerAddress: 607,
            registerValue: 5000);

        var payload = ModbusRtu.ValidateAndExtractData(response, expectedSlaveAddress: 0x01, expectedFunctionCode: 0x06);
        Assert.Empty(payload.ToArray());
    }
}
