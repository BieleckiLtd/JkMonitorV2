using System.Reflection;
using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DeviceConfigStoreTests
{
    [Fact]
    public void StoredDeviceRow_Uses_Property_Based_Materialization()
    {
        var rowType = typeof(DeviceConfigStore).GetNestedType("StoredDeviceRow", BindingFlags.NonPublic);

        Assert.NotNull(rowType);
        Assert.NotNull(rowType!.GetConstructor(Type.EmptyTypes));

        var expectedProperties = new[]
        {
            "DeviceId",
            "DeviceKey",
            "DisplayName",
            "SortOrder",
            "DefinitionId",
            "DefinitionVersion",
            "DefinitionJson",
            "DefinitionHash",
            "HasDefinitionOverride",
            "TransportPortName",
            "BleSettingsPin",
            "Address",
            "IsMaster",
            "PollIntervalMilliseconds",
            "Enabled",
            "CellVoltageSmoothingFactor",
            "CellVoltageSmoothingBreakoutMillivolts",
            "DisplayPrecisionJson",
            "TemperatureUnit"
        };

        foreach (var propertyName in expectedProperties)
        {
            var property = rowType.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public);
            Assert.NotNull(property);
            Assert.True(property!.CanWrite, $"{propertyName} must be writable for Dapper materialization.");
        }
    }
}
