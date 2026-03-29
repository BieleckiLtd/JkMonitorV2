using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.Status;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public class CellVoltageSmoothingFilterTests
{
    private static DeviceConfiguration CreateDevice(
        decimal smoothingFactor = 0.3m,
        int breakoutMillivolts = 5,
        string deviceId = "test-device") => new()
    {
        DeviceId = deviceId,
        DisplayName = "Test Device",
        DefinitionId = "test-profile",
        CellVoltageSmoothingFactor = smoothingFactor,
        CellVoltageSmoothingBreakoutMillivolts = breakoutMillivolts,
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
        var filter = new CellVoltageSmoothingFilter();
        var snapshot = CreateSnapshot(3.300m, 3.310m);

        var result = filter.Apply(CreateDevice(), snapshot);

        Assert.Equal(3.300m, result.Cells[0].VoltageVolts);
        Assert.Equal(3.310m, result.Cells[1].VoltageVolts);
    }

    [Fact]
    public void NoisyReading_HeldByHysteresis()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m);

        filter.Apply(device, CreateSnapshot(3.300m));

        // +2mV noise: EMA = 0.3×3.302 + 0.7×3.300 = 3.3006
        // |3.3006 − 3.300| = 0.0006 < 0.001 → hysteresis holds at 3.300.
        var result = filter.Apply(device, CreateSnapshot(3.302m));

        Assert.Equal(3.300m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void NoisyOscillation_RemainsStable()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.2m);

        filter.Apply(device, CreateSnapshot(3.300m));

        // Alternating ±2mV noise – output must stay locked at 3.300.
        var noise = new[] { 3.302m, 3.298m, 3.302m, 3.298m };
        foreach (var reading in noise)
        {
            var result = filter.Apply(device, CreateSnapshot(reading));
            Assert.Equal(3.300m, result.Cells[0].VoltageVolts);
        }
    }

    [Fact]
    public void GradualTrend_Tracked()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m);

        // Start at 3.300.
        filter.Apply(device, CreateSnapshot(3.300m));

        // Consistent +1mV per sample: hysteresis delays the first step but
        // the trend comes through cleanly.
        var r1 = filter.Apply(device, CreateSnapshot(3.301m));
        Assert.Equal(3.300m, r1.Cells[0].VoltageVolts); // EMA 3.3003, below threshold

        var r2 = filter.Apply(device, CreateSnapshot(3.302m));
        Assert.Equal(3.300m, r2.Cells[0].VoltageVolts); // EMA 3.30081, still below

        var r3 = filter.Apply(device, CreateSnapshot(3.303m));
        Assert.Equal(3.301m, r3.Cells[0].VoltageVolts); // EMA ~3.3015, crosses 1mV

        var r4 = filter.Apply(device, CreateSnapshot(3.304m));
        Assert.Equal(3.302m, r4.Cells[0].VoltageVolts); // EMA ~3.3022, crosses 1mV
    }

    [Fact]
    public void StepChange_BreakoutSnapsToRaw()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 5);

        filter.Apply(device, CreateSnapshot(3.300m));

        // +10mV sudden jump – exceeds 5mV breakout.
        var result = filter.Apply(device, CreateSnapshot(3.310m));

        Assert.Equal(3.310m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void StepChangeNegative_BreakoutSnapsToRaw()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 5);

        filter.Apply(device, CreateSnapshot(3.310m));

        // −8mV sudden drop – exceeds 5mV breakout.
        var result = filter.Apply(device, CreateSnapshot(3.302m));

        Assert.Equal(3.302m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void ChangeWithinBreakout_SmoothedByEma()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 5);

        filter.Apply(device, CreateSnapshot(3.300m));

        // +4mV – within breakout: EMA = 0.3×3.304 + 0.7×3.300 = 3.3012.
        // |3.3012 − 3.300| = 0.0012 ≥ 0.001 → reported = round(3.3012) = 3.301.
        var result = filter.Apply(device, CreateSnapshot(3.304m));

        Assert.Equal(3.301m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void AggregateStats_RecalculatedFromSmoothedValues()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 5);

        // First reading: cells at 3.300 and 3.310.
        filter.Apply(device, CreateSnapshot(3.300m, 3.310m));

        // Cell 1: +2mV noise → hysteresis holds at 3.300.
        // Cell 2: +10mV jump → breakout → 3.320.
        var result = filter.Apply(device, CreateSnapshot(3.302m, 3.320m));

        Assert.Equal(3.300m, result.MinCellVoltageVolts);
        Assert.Equal(3.320m, result.MaxCellVoltageVolts);
        Assert.Equal(0.020m, result.DeltaCellVoltageVolts);
    }

    [Fact]
    public void Disabled_PassesThrough()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0m);

        filter.Apply(device, CreateSnapshot(3.300m));

        var result = filter.Apply(device, CreateSnapshot(3.302m));

        Assert.Equal(3.302m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void FactorOne_PassesThrough()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 1m);

        filter.Apply(device, CreateSnapshot(3.300m));

        var result = filter.Apply(device, CreateSnapshot(3.302m));

        Assert.Equal(3.302m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void EmptyCells_ReturnsUnchanged()
    {
        var filter = new CellVoltageSmoothingFilter();
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
        var filter = new CellVoltageSmoothingFilter();
        var deviceA = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 10, deviceId: "device-a");
        var deviceB = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 10, deviceId: "device-b");

        filter.Apply(deviceA, CreateSnapshot(3.300m));
        filter.Apply(deviceB, CreateSnapshot(3.310m));

        var resultA = filter.Apply(deviceA, CreateSnapshot(3.302m));
        var resultB = filter.Apply(deviceB, CreateSnapshot(3.302m));

        // A: EMA 3.3006, |0.0006| < 0.001 → hysteresis holds at 3.300
        Assert.Equal(3.300m, resultA.Cells[0].VoltageVolts);
        // B: EMA 3.3076, |3.3076−3.310| = 0.0024 ≥ 0.001 → round(3.3076) = 3.308
        Assert.Equal(3.308m, resultB.Cells[0].VoltageVolts);
    }

    [Fact]
    public void NoBreakout_PureEmaForLargeChange()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 0);

        filter.Apply(device, CreateSnapshot(3.300m));

        // +10mV but breakout disabled – EMA still applies.
        // EMA = 0.3×3.310 + 0.7×3.300 = 3.303. |3.303−3.300| = 0.003 ≥ 0.001 → 3.303.
        var result = filter.Apply(device, CreateSnapshot(3.310m));

        Assert.Equal(3.303m, result.Cells[0].VoltageVolts);
    }

    [Fact]
    public void RandomNoise_StaysStable()
    {
        var filter = new CellVoltageSmoothingFilter();
        var device = CreateDevice(smoothingFactor: 0.3m, breakoutMillivolts: 5);

        // Simulated noise around 3.300V: +2, −1, +2, −2, +1 mV
        filter.Apply(device, CreateSnapshot(3.300m));

        var values = new[] { 3.302m, 3.299m, 3.302m, 3.298m, 3.301m };
        foreach (var v in values)
        {
            var r = filter.Apply(device, CreateSnapshot(v));
            // Hysteresis keeps output locked at 3.300.
            Assert.Equal(3.300m, r.Cells[0].VoltageVolts);
        }
    }
}
