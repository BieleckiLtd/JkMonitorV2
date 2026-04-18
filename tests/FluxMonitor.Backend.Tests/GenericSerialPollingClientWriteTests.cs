using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.DeviceDefinition;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class GenericSerialPollingClientWriteTests
{
    [Fact]
    public void TryResolveGroupWrite_UsesEntityWriteMetadata()
    {
        var entity = new EntityDefinition
        {
            Id = "clock_hour",
            Type = "number",
            Name = "Clock Hour",
            Category = "F3 Time",
            Writable = true,
            Source = new EntitySourceDefinition
            {
                Bank = "info_fw",
                ByteOffset = 0
            },
            Write = new EntityWriteDefinition
            {
                Address = 699,
                GroupStartAddress = 696,
                GroupRegisterCount = 6
            }
        };

        var resolved = GenericSerialPollingClient.TryResolveGroupWrite(
            entity,
            registerAddress: 699,
            registersPerWrite: 1,
            out var groupWrite);

        Assert.True(resolved);
        Assert.Equal((ushort)696, groupWrite.StartAddress);
        Assert.Equal(6, groupWrite.RegisterCount);
        Assert.Equal(3, groupWrite.RegisterOffset);
    }

    [Fact]
    public void MergeGroupWriteRegisters_ReplacesOnlyTargetRegister()
    {
        var merged = GenericSerialPollingClient.MergeGroupWriteRegisters(
            existingRegisters: [2026, 4, 18, 12, 30, 15],
            registerOffset: 3,
            rawValue: 14,
            registersPerWrite: 1);

        Assert.Equal(new ushort[] { 2026, 4, 18, 14, 30, 15 }, merged);
    }
}
