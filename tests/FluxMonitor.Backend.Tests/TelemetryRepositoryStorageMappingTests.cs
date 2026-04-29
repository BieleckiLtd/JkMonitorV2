using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class TelemetryRepositoryStorageMappingTests
{
    [Fact]
    public void BuildNumericMeasurements_StoresOnlyConfiguredTimeSeriesEntities()
    {
        var definition = CreateDefinition(new StorageDefinition
        {
            TimeSeries =
            [
                new TimeSeriesMapping { Entity = "stored_hidden", Aggregate = "avg", Column = "stored_hidden" },
                new TimeSeriesMapping { Entity = "visible_temp", Aggregate = "avg", Column = "visible_temp" }
            ]
        });

        var sample = CreateSample(
            new Dictionary<string, decimal?>
            {
                ["stored_hidden"] = 12.3m,
                ["visible_temp"] = 24.5m,
                ["not_configured"] = 99m
            });

        var measurements = TimescaleTelemetryRepository.BuildNumericMeasurements(sample, definition);

        Assert.Equal(2, measurements.Count);
        Assert.Equal(12.3d, measurements["stored_hidden"]);
        Assert.Equal(24.5d, measurements["visible_temp"]);
        Assert.False(measurements.ContainsKey("not_configured"));
    }

    [Fact]
    public void BuildNumericMeasurements_DoesNotStoreCellsWithoutConfiguredCellVoltageMapping()
    {
        var definition = CreateDefinition(new StorageDefinition());
        var sample = CreateSample(
            new Dictionary<string, decimal?>(),
            [new CellVoltageSnapshot { Index = 1, VoltageVolts = 3.45m }]);

        var measurements = TimescaleTelemetryRepository.BuildNumericMeasurements(sample, definition);

        Assert.Empty(measurements);
    }

    [Fact]
    public void BuildNumericMeasurements_StoresCellsUsingConfiguredCellVoltageEntity()
    {
        var definition = CreateDefinition(new StorageDefinition
        {
            CellVoltages = new CellVoltageStorageMapping { Entity = "pack_cells", Aggregate = "avg" }
        });
        var sample = CreateSample(
            new Dictionary<string, decimal?>(),
            [
                new CellVoltageSnapshot { Index = 1, VoltageVolts = 3.45m },
                new CellVoltageSnapshot { Index = 2, VoltageVolts = 3.46m }
            ]);

        var measurements = TimescaleTelemetryRepository.BuildNumericMeasurements(sample, definition);

        Assert.Equal(2, measurements.Count);
        Assert.Equal(3.45d, measurements["pack_cells:1"]);
        Assert.Equal(3.46d, measurements["pack_cells:2"]);
    }

    private static DeviceDefinition CreateDefinition(StorageDefinition storage) => new()
    {
        Version = "test",
        Device = new DeviceMetadata { Id = "test-device", Name = "Test Device" },
        Connection = new ConnectionDefinition
        {
            Transport = new TransportDefinition { Type = "test" },
            Protocol = new ProtocolDefinition { Type = "test" }
        },
        DataSources = [],
        PollGroups = new Dictionary<string, PollGroupDefinition>(),
        Entities = [],
        Storage = storage
    };

    private static DevicePollResult CreateSample(
        IReadOnlyDictionary<string, decimal?> numericValues,
        IReadOnlyList<CellVoltageSnapshot>? cells = null)
    {
        return new DevicePollResult(
            new DeviceTelemetrySnapshot
            {
                CollectedAt = new DateTimeOffset(2026, 4, 29, 12, 0, 0, TimeSpan.Zero),
                Cells = cells ?? [],
                ActiveWarnings = []
            },
            new Dictionary<string, string>(),
            string.Empty,
            numericValues);
    }
}
