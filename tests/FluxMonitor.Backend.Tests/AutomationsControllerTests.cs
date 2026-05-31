using FluxMonitor.Backend.Controllers;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class AutomationsControllerTests
{
    [Fact]
    public void BuildParameterList_UsesNumericValuesForDefinedEntities()
    {
        var definition = CreateDefinition(new EntityDefinition
        {
            Id = "state_of_charge",
            Type = "number",
            Name = "State of Charge",
            Category = "Battery",
            Source = new EntitySourceDefinition
            {
                Bank = "main",
                ByteOffset = 0,
                Unit = "%"
            }
        });

        var telemetry = new DeviceTelemetrySnapshot
        {
            CollectedAt = DateTimeOffset.UtcNow,
            Cells = [],
            ActiveWarnings = [],
            NumericValues = new Dictionary<string, decimal?>
            {
                ["state_of_charge"] = 84m
            }
        };

        var parameters = AutomationsController.BuildParameterList(definition, telemetry);

        var parameter = Assert.Single(parameters);
        Assert.Equal("state_of_charge", parameter.Id);
        Assert.Equal("State of Charge", parameter.Name);
        Assert.Equal(84m, parameter.NumericValue);
        Assert.Equal("%", parameter.Unit);
    }

    [Fact]
    public void BuildParameterList_AddsNumericValuesWithoutDefinitionMetadata()
    {
        var telemetry = new DeviceTelemetrySnapshot
        {
            CollectedAt = DateTimeOffset.UtcNow,
            Cells = [],
            ActiveWarnings = [],
            NumericValues = new Dictionary<string, decimal?>
            {
                ["pack_power"] = 512m
            }
        };

        var parameters = AutomationsController.BuildParameterList(definition: null, telemetry);

        var parameter = Assert.Single(parameters);
        Assert.Equal("pack_power", parameter.Id);
        Assert.Equal("pack_power", parameter.Name);
        Assert.Equal("Current", parameter.Category);
        Assert.Equal(512m, parameter.NumericValue);
    }

    private static DeviceDefinition CreateDefinition(params EntityDefinition[] entities)
        => new()
        {
            Version = "1.0",
            Device = new DeviceMetadata
            {
                Id = "test-device",
                Name = "Test Device"
            },
            Connection = new ConnectionDefinition
            {
                Transport = new TransportDefinition
                {
                    Type = "serial"
                },
                Protocol = new ProtocolDefinition
                {
                    Type = "modbus"
                }
            },
            DataSources = [],
            PollGroups = new Dictionary<string, PollGroupDefinition>(),
            Entities = entities,
            ComputedEntities = []
        };
}