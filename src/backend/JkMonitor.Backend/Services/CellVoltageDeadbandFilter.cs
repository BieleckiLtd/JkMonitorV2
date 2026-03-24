using System.Collections.Concurrent;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Smooths cell-voltage measurement noise using an exponential moving average (EMA)
/// with output hysteresis to eliminate rounding oscillation at millivolt boundaries,
/// while preserving immediate response to genuine step changes via a breakout threshold.
/// Thread-safe: each device gets its own independent state.
/// </summary>
public sealed class CellVoltageSmoothingFilter
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<int, (decimal Ema, decimal Reported)>> _deviceState = new();

    /// <summary>
    /// Returns a new snapshot with cell voltages smoothed via EMA,
    /// and min/max/avg/delta recalculated from the smoothed values.
    /// If the device has no smoothing configured (factor ≤ 0 or ≥ 1), the snapshot is returned unchanged.
    /// </summary>
    public DeviceTelemetrySnapshot Apply(DeviceConfiguration device, DeviceTelemetrySnapshot snapshot)
    {
        var alpha = device.CellVoltageSmoothingFactor;
        if (alpha <= 0m || alpha >= 1m || snapshot.Cells.Count == 0)
            return snapshot;

        var breakoutVolts = device.CellVoltageSmoothingBreakoutMillivolts / 1000m;
        var cellState = _deviceState.GetOrAdd(device.DeviceId, _ => new ConcurrentDictionary<int, (decimal, decimal)>());

        var smoothedCells = new CellVoltageSnapshot[snapshot.Cells.Count];
        for (var i = 0; i < snapshot.Cells.Count; i++)
        {
            var cell = snapshot.Cells[i];
            var raw = cell.VoltageVolts;

            decimal ema, reported;
            if (!cellState.TryGetValue(cell.Index, out var prev))
            {
                // First reading – accept as-is.
                ema = raw;
                reported = raw;
            }
            else if (breakoutVolts > 0m && Math.Abs(raw - prev.Ema) > breakoutVolts)
            {
                // Step change exceeds breakout – snap to raw immediately.
                ema = raw;
                reported = raw;
            }
            else
            {
                // EMA: smoothed = α * raw + (1 − α) * previous
                ema = alpha * raw + (1m - alpha) * prev.Ema;

                // Output hysteresis: hold the reported value until the smoothed
                // EMA has moved at least 1 mV away, preventing rounding oscillation
                // at millivolt boundaries.
                reported = Math.Abs(ema - prev.Reported) >= 0.001m
                    ? decimal.Round(ema, 3)
                    : prev.Reported;
            }

            cellState[cell.Index] = (ema, reported);
            smoothedCells[i] = cell with { VoltageVolts = reported };
        }

        // Recalculate aggregate stats from smoothed values.
        var minVoltage = smoothedCells.Min(c => c.VoltageVolts);
        var maxVoltage = smoothedCells.Max(c => c.VoltageVolts);
        var avgVoltage = decimal.Round(smoothedCells.Average(c => c.VoltageVolts), 3);
        var deltaVoltage = decimal.Round(maxVoltage - minVoltage, 3);

        return snapshot with
        {
            Cells = smoothedCells,
            MinCellVoltageVolts = minVoltage,
            MaxCellVoltageVolts = maxVoltage,
            AverageCellVoltageVolts = avgVoltage,
            DeltaCellVoltageVolts = deltaVoltage,
        };
    }
}
