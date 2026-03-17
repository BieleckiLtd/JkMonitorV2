using System.Globalization;
using System.Text;
using JkMonitor.Backend.Protocol;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

public sealed class SimulatedJkPollingClient(
    IOptions<MonitorConfiguration> configuration,
    ILogger<SimulatedJkPollingClient> logger) : IJkPollingClient
{
    private readonly SimulationConfiguration _simulation = configuration.Value.Simulation;

    public Task<JkParsedSample> PollAsync(BmsDeviceConfiguration device, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var collectedAt = DateTimeOffset.UtcNow;
        var phase = (collectedAt.ToUnixTimeMilliseconds() / 1000d / 9d) + (device.Address * 0.37d);
        var cellCount = Math.Clamp(_simulation.CellCount, 4, 24);
        var cells = new List<CellVoltageSnapshot>(cellCount);

        for (var index = 0; index < cellCount; index++)
        {
            var cellPhase = phase + (index * 0.41d);
            var millivolts = _simulation.BaseCellMillivolts + (int)Math.Round(Math.Sin(cellPhase) * _simulation.CellSwingMillivolts);
            cells.Add(new CellVoltageSnapshot
            {
                Index = index + 1,
                VoltageVolts = decimal.Round(millivolts / 1000m, 3)
            });
        }

        var current = decimal.Round((decimal)Math.Sin(phase / 2.2d) * _simulation.MaxCurrentAmps, 2);
        var stateOfCharge = decimal.Round(
            Math.Clamp(
                _simulation.BaseStateOfChargePercent + (decimal)Math.Sin(phase / 5d) * _simulation.StateOfChargeSwingPercent,
                0m,
                100m),
            1);
        var totalVoltage = decimal.Round(cells.Sum(cell => cell.VoltageVolts), 2);
        var minCellVoltage = cells.Min(cell => cell.VoltageVolts);
        var maxCellVoltage = cells.Max(cell => cell.VoltageVolts);
        var deltaCellVoltage = decimal.Round(maxCellVoltage - minCellVoltage, 3);
        var power = decimal.Round(totalVoltage * current, 2);
        var mosTemperature = decimal.Round(_simulation.BaseMosTemperatureCelsius + (decimal)Math.Sin(phase / 3d) * 6m, 1);
        var ambientTemperature = decimal.Round(_simulation.BaseAmbientTemperatureCelsius + (decimal)Math.Cos(phase / 4d) * 3m, 1);
        var batteryTemperature = decimal.Round(_simulation.BaseBatteryTemperatureCelsius + (decimal)Math.Sin(phase / 3.4d) * 4m, 1);

        var warningFlags = 0;
        var warnings = new List<string>();
        if (deltaCellVoltage >= 0.020m)
        {
            warningFlags |= 1 << 7;
            warnings.Add("Cell pressure difference");
        }

        if (mosTemperature >= 45m)
        {
            warningFlags |= 1 << 1;
            warnings.Add("Power tube overtemperature");
        }

        if (batteryTemperature <= 10m)
        {
            warningFlags |= 1 << 9;
            warnings.Add("Battery low temperature");
        }

        var chargingEnabled = current > 0;
        var dischargingEnabled = current < 0;
        var balancingEnabled = deltaCellVoltage >= 0.010m;
        var batteryOnline = true;
        var statusFlags = 0;
        if (chargingEnabled)
        {
            statusFlags |= 1;
        }

        if (dischargingEnabled)
        {
            statusFlags |= 1 << 1;
        }

        if (balancingEnabled)
        {
            statusFlags |= 1 << 2;
        }

        if (batteryOnline)
        {
            statusFlags |= 1 << 3;
        }

        var snapshot = new DeviceTelemetrySnapshot
        {
            CollectedAt = collectedAt,
            CellCount = cellCount,
            TotalVoltageVolts = totalVoltage,
            CurrentAmps = current,
            PowerWatts = power,
            StateOfChargePercent = stateOfCharge,
            MinCellVoltageVolts = minCellVoltage,
            MaxCellVoltageVolts = maxCellVoltage,
            AverageCellVoltageVolts = decimal.Round(cells.Average(cell => cell.VoltageVolts), 3),
            DeltaCellVoltageVolts = deltaCellVoltage,
            MosTemperatureCelsius = mosTemperature,
            AmbientTemperatureCelsius = ambientTemperature,
            BatteryTemperatureCelsius = batteryTemperature,
            CycleCount = 100 + (int)((collectedAt.ToUnixTimeSeconds() / 60) % 500),
            WarningFlags = warningFlags,
            StatusFlags = statusFlags,
            ProtocolVersion = 1,
            SoftwareVersion = $"SIM-{device.RegisterProfile}",
            ManufacturerId = $"SIM-{device.DeviceId.ToUpperInvariant()}",
            ChargingEnabled = chargingEnabled,
            DischargingEnabled = dischargingEnabled,
            BalancingEnabled = balancingEnabled,
            BatteryOnline = batteryOnline,
            Cells = cells,
            ActiveWarnings = warnings
        };

        var rawRegisters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["79"] = string.Join(string.Empty, cells.Select(cell => $"{cell.Index:X2}{(int)(cell.VoltageVolts * 1000m):X4}")),
            ["80"] = ToHexWord((int)(mosTemperature + 0m)),
            ["81"] = ToHexWord((int)(ambientTemperature + 0m)),
            ["82"] = ToHexWord((int)(batteryTemperature + 0m)),
            ["83"] = ToHexWord((int)(totalVoltage * 100m)),
            ["84"] = ToHexWord(EncodeCurrent(current)),
            ["85"] = $"{(int)stateOfCharge:X2}",
            ["87"] = ToHexWord(snapshot.CycleCount ?? 0),
            ["8B"] = ToHexWord(warningFlags),
            ["8C"] = ToHexWord(statusFlags),
            ["B7"] = Convert.ToHexString(Encoding.ASCII.GetBytes((snapshot.SoftwareVersion ?? string.Empty).PadRight(15, '_').Substring(0, 15))),
            ["BA"] = Convert.ToHexString(Encoding.ASCII.GetBytes((snapshot.ManufacturerId ?? string.Empty).PadRight(24, '_').Substring(0, 24))),
            ["C0"] = "01"
        };

        logger.LogDebug("Generated simulated JK telemetry for {DeviceId} ({Profile}).", device.DeviceId, device.RegisterProfile);

        return Task.FromResult(new JkParsedSample(
            snapshot,
            rawRegisters,
            Convert.ToHexString(Encoding.ASCII.GetBytes($"SIM|{device.DeviceId}|{collectedAt:O}"))));
    }

    private static string ToHexWord(int value)
    {
        return value.ToString("X4", CultureInfo.InvariantCulture);
    }

    private static int EncodeCurrent(decimal current)
    {
        var magnitude = (int)Math.Round(Math.Abs(current) * 100m);
        return current >= 0 ? (0x8000 | magnitude) : magnitude;
    }
}