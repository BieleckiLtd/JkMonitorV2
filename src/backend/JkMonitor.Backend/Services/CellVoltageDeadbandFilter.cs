using System.Collections.Concurrent;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Suppresses cell-voltage measurement noise by holding the last accepted value
/// until the new reading deviates by more than the configured deadband.
/// Thread-safe: each device gets its own independent state.
/// </summary>
public sealed class CellVoltageDeadbandFilter
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<int, decimal>> _deviceState = new();

    /// <summary>
    /// Returns a new snapshot with cell voltages filtered through the deadband,
    /// and min/max/avg/delta recalculated from the filtered values.
    /// If the device has no deadband configured (0), the snapshot is returned unchanged.
    /// </summary>
    public DeviceTelemetrySnapshot Apply(DeviceConfiguration device, DeviceTelemetrySnapshot snapshot)
    {
        if (device.CellVoltageDeadbandMillivolts <= 0 || snapshot.Cells.Count == 0)
            return snapshot;

        var deadbandVolts = device.CellVoltageDeadbandMillivolts / 1000m;
        var cellState = _deviceState.GetOrAdd(device.DeviceId, _ => new ConcurrentDictionary<int, decimal>());

        var filteredCells = new CellVoltageSnapshot[snapshot.Cells.Count];
        for (var i = 0; i < snapshot.Cells.Count; i++)
        {
            var cell = snapshot.Cells[i];
            var newVoltage = cell.VoltageVolts;

            if (cellState.TryGetValue(cell.Index, out var lastAccepted)
                && Math.Abs(newVoltage - lastAccepted) <= deadbandVolts)
            {
                // Within deadband – keep previous accepted value.
                filteredCells[i] = cell with { VoltageVolts = lastAccepted };
            }
            else
            {
                // Outside deadband (or first reading) – accept new value.
                cellState[cell.Index] = newVoltage;
                filteredCells[i] = cell;
            }
        }

        // Recalculate aggregate stats from filtered values.
        var minVoltage = filteredCells.Min(c => c.VoltageVolts);
        var maxVoltage = filteredCells.Max(c => c.VoltageVolts);
        var avgVoltage = decimal.Round(filteredCells.Average(c => c.VoltageVolts), 3);
        var deltaVoltage = decimal.Round(maxVoltage - minVoltage, 3);

        return snapshot with
        {
            Cells = filteredCells,
            MinCellVoltageVolts = minVoltage,
            MaxCellVoltageVolts = maxVoltage,
            AverageCellVoltageVolts = avgVoltage,
            DeltaCellVoltageVolts = deltaVoltage,
        };
    }
}
