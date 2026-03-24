using System.Collections.Concurrent;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Smooths cell-voltage measurement noise using an exponential moving average (EMA)
/// while preserving immediate response to genuine step changes via a breakout threshold.
/// Thread-safe: each device gets its own independent state.
/// </summary>
public sealed class CellVoltageSmoothingFilter
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<int, decimal>> _deviceState = new();

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
        var cellState = _deviceState.GetOrAdd(device.DeviceId, _ => new ConcurrentDictionary<int, decimal>());

        var smoothedCells = new CellVoltageSnapshot[snapshot.Cells.Count];
        for (var i = 0; i < snapshot.Cells.Count; i++)
        {
            var cell = snapshot.Cells[i];
            var raw = cell.VoltageVolts;

            decimal smoothed;
            if (!cellState.TryGetValue(cell.Index, out var previous))
            {
                // First reading – accept as-is.
                smoothed = raw;
            }
            else if (breakoutVolts > 0m && Math.Abs(raw - previous) > breakoutVolts)
            {
                // Step change exceeds breakout – snap to raw immediately.
                smoothed = raw;
            }
            else
            {
                // EMA: smoothed = α * raw + (1 − α) * previous
                smoothed = decimal.Round(alpha * raw + (1m - alpha) * previous, 3);
            }

            cellState[cell.Index] = smoothed;
            smoothedCells[i] = cell with { VoltageVolts = smoothed };
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
