using JkMonitor.Backend.Services;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;
using Xunit;

namespace JkMonitor.Backend.Tests;

public class CellVoltageDeadbandFilterTests
{
    private static DeviceConfiguration CreateDevice(int deadbandMillivolts = 2, string deviceId = "test-device") => new()
    {
        DeviceId = deviceId,
        DisplayName = "Test Device",
        ProfileId = "test-profile",
        CellVoltageDeadbandMillivolts = deadbandMillivolts,
    };

    private static DeviceTelemetrySnapshot CreateSnapshot(params decimal[] cellVoltages)
    {
        var cells = cellVoltages.Select((v, i) => new CellVoltageSnapshot { Index = i + 1, VoltageVolts = v }).ToArray();
        return new DeviceTelemetrySnapshot
        {
            CollectedAt = DateTimeOffset.UtcNow,
            Cells = cells,
            ActiveWarnings = [],
            MinCellVoltageVolts = cells.Min(c => c.VoltageVolts),
            MaxCellVoltageVolts = cells.Max(c => c.VoltageVolts),
            AverageCellVoltageVolts = cells.Average(c => c.VoltageVolts),
            DeltaCellVoltageVolts = cells.Max(c => c.VoltageVolts) - cells.Min(c => c.VoltageVolts),
        };
    }

    [Fact]
    public void FirstReading_AlwaysAccepted()
    {
        var filter = new CellVoltageDeadbandFilter();
        var snapshot = CreateSnapshot(3.300m, 3.310m);

        var result = filter.Apply(CreateDevice(), snapshot);

        Assert.Equal(3.300m, result.Cells[0].VoltageVolts);
        Assert.Equal(3.310m, result.Cells[1].VoltageVolts);
    }

    [Fact]
    public void SmallFluctuation_Suppressed()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 2);

        // First reading – accepted.
        filter.Apply(device, CreateSnapshot(3.300m, 3.310m));

        // Second reading – +1mV change on cell 1, within deadband.
        var result = filter.Apply(device, CreateSnapshot(3.301m, 3.310m));

        Assert.Equal(3.300m, result.Cells[0].VoltageVolts); // held at previous
        Assert.Equal(3.310m, result.Cells[1].VoltageVolts);
    }

    [Fact]
    public void ChangeExceedingDeadband_Accepted()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 2);

        filter.Apply(device, CreateSnapshot(3.300m));

        // +3mV change – exceeds 2mV deadband.
        var result = filter.Apply(device, CreateSnapshot(3.303m));

        Assert.Equal(3.303m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void ChangeExactlyAtDeadband_Suppressed()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 2);

        filter.Apply(device, CreateSnapshot(3.300m));

        // Exactly +2mV – within (≤) deadband.
        var result = filter.Apply(device, CreateSnapshot(3.302m));

        Assert.Equal(3.300m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void NegativeFluctuation_Suppressed()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 2);

        filter.Apply(device, CreateSnapshot(3.300m));

        // −1mV change – within deadband.
        var result = filter.Apply(device, CreateSnapshot(3.299m));

        Assert.Equal(3.300m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void AggregateStats_RecalculatedAfterFiltering()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 2);

        // First reading: cells at 3.300 and 3.310.
        filter.Apply(device, CreateSnapshot(3.300m, 3.310m));

        // Second: cell 1 noisy +1mV, cell 2 real jump +5mV.
        var result = filter.Apply(device, CreateSnapshot(3.301m, 3.315m));

        // Cell 1 stays 3.300, cell 2 jumps to 3.315.
        Assert.Equal(3.300m, result.MinCellVoltageVolts);
        Assert.Equal(3.315m, result.MaxCellVoltageVolts);
        Assert.Equal(0.015m, result.DeltaCellVoltageVolts);
    }

    [Fact]
    public void DisabledDeadband_PassesThrough()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 0);

        filter.Apply(device, CreateSnapshot(3.300m));

        var result = filter.Apply(device, CreateSnapshot(3.301m));

        Assert.Equal(3.301m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void EmptyCells_ReturnsUnchanged()
    {
        var filter = new CellVoltageDeadbandFilter();
        var snapshot = new DeviceTelemetrySnapshot
        {
            CollectedAt = DateTimeOffset.UtcNow,
            Cells = [],
            ActiveWarnings = [],
        };

        var result = filter.Apply(CreateDevice(), snapshot);

        Assert.Same(snapshot, result);
    }

    [Fact]
    public void IndependentDevices_HaveSeparateState()
    {
        var filter = new CellVoltageDeadbandFilter();
        var deviceA = CreateDevice(deadbandMillivolts: 2, deviceId: "device-a");
        var deviceB = CreateDevice(deadbandMillivolts: 2, deviceId: "device-b");

        filter.Apply(deviceA, CreateSnapshot(3.300m));
        filter.Apply(deviceB, CreateSnapshot(3.310m));

        // Same reading for both: only device A should suppress.
        var resultA = filter.Apply(deviceA, CreateSnapshot(3.301m));
        var resultB = filter.Apply(deviceB, CreateSnapshot(3.301m));

        Assert.Equal(3.300m, resultA.Cells[0].VoltageVolts); // within A's deadband
        Assert.Equal(3.301m, resultB.Cells[0].VoltageVolts); // exceeds B's deadband (9mV change)
    }

    [Fact]
    public void GradualDrift_EventuallyAccepted()
    {
        var filter = new CellVoltageDeadbandFilter();
        var device = CreateDevice(deadbandMillivolts: 2);

        // Start at 3.300.
        filter.Apply(device, CreateSnapshot(3.300m));

        // +1mV increments: suppressed until cumulative exceeds deadband.
        var r1 = filter.Apply(device, CreateSnapshot(3.301m));
        Assert.Equal(3.300m, r1.Cells[0].VoltageVolts);

        var r2 = filter.Apply(device, CreateSnapshot(3.302m));
        Assert.Equal(3.300m, r2.Cells[0].VoltageVolts);

        // +3mV from last accepted (3.300) → accepted.
        var r3 = filter.Apply(device, CreateSnapshot(3.303m));
        Assert.Equal(3.303m, r3.Cells[0].VoltageVolts);
    }
}
