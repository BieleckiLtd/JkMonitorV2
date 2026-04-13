using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DeviceConfigurationApiMapperTests
{
    [Fact]
    public void ToConfiguration_SerializesDeviceDefinitionSnapshot()
    {
        var model = new DeviceConfigurationApiModel
        {
            PersistedId = 42,
            DeviceId = "battery-1",
            DisplayName = "Battery 1",
            SortOrder = 3,
            DefinitionId = "jk-inverter-bms",
            DefinitionVersion = "1.0.0",
            TransportPortName = "COM3",
            BleSettingsPin = null,
            Address = 1,
            IsMaster = false,
            PollIntervalMilliseconds = 2500,
            Enabled = true,
            CellVoltageSmoothingFactor = 0.25m,
            CellVoltageSmoothingBreakoutMillivolts = 5,
            DisplayPrecision = new DisplayPrecisionConfiguration(),
            TemperatureUnit = "f",
            HasDefinitionOverride = true,
            Definition = CreateDefinition(2500)
        };

        var configuration = DeviceConfigurationApiMapper.ToConfiguration(model);

        Assert.Equal("battery-1", configuration.DeviceId);
        Assert.Equal("jk-inverter-bms", configuration.DefinitionId);
        Assert.Equal(3, configuration.SortOrder);
        Assert.Equal("f", configuration.TemperatureUnit);
        Assert.Contains(@"""intervalMs"":2500", configuration.DefinitionJson);
    }

    [Fact]
    public void ToApiModel_PreservesPersistedMetadata()
    {
        var configuration = new DeviceConfiguration
        {
            DeviceId = "battery-1",
            DisplayName = "Battery 1",
            SortOrder = 2,
            DefinitionId = "jk-inverter-bms",
            DefinitionVersion = "1.0.0",
            TransportPortName = "COM3",
            Address = 1,
            IsMaster = false,
            PollIntervalMilliseconds = 2500,
            Enabled = true,
            CellVoltageSmoothingFactor = 0.25m,
            CellVoltageSmoothingBreakoutMillivolts = 5,
            DisplayPrecision = new DisplayPrecisionConfiguration(),
            TemperatureUnit = "f",
            HasDefinitionOverride = true,
            DefinitionJson = "{}"
        };

        var apiModel = DeviceConfigurationApiMapper.ToApiModel(configuration, 42, CreateDefinition(2500));

        Assert.Equal(42, apiModel.PersistedId);
        Assert.True(apiModel.HasDefinitionOverride);
        Assert.NotNull(apiModel.Definition);
        Assert.Equal(2, apiModel.SortOrder);
        Assert.Equal("f", apiModel.TemperatureUnit);
        Assert.Equal(2500, apiModel.Definition!.PollGroups["fast"].IntervalMs);
    }

    private static DeviceDefinition CreateDefinition(int intervalMs)
    {
        return new DeviceDefinition
        {
            Version = "1.0.0",
            Device = new DeviceMetadata
            {
                Id = "jk-inverter-bms",
                Name = "JK Inverter BMS",
                Manufacturer = "JK",
                Model = "JK-PB2A16S20P",
                Category = "Battery"
            },
            Connection = new ConnectionDefinition
            {
                Transport = new TransportDefinition
                {
                    Type = "serial",
                    Defaults = new TransportDefaults()
                },
                Protocol = new ProtocolDefinition
                {
                    Type = "modbus",
                    Settings = new ProtocolSettings()
                }
            },
            DataSources = [],
            PollGroups = new Dictionary<string, PollGroupDefinition>
            {
                ["fast"] = new() { IntervalMs = intervalMs }
            },
            Entities = []
        };
    }
}
