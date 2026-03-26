namespace FluxMonitor.Contracts.Status;

public sealed record class CellVoltageSnapshot
{
    public required int Index { get; init; }

    public decimal VoltageVolts { get; init; }
}

public sealed record class DeviceTelemetrySnapshot
{
    public required DateTimeOffset CollectedAt { get; init; }

    public int? CellCount { get; init; }

    public decimal? TotalVoltageVolts { get; init; }

    public decimal? CurrentAmps { get; init; }

    public decimal? PowerWatts { get; init; }

    public decimal? StateOfChargePercent { get; init; }

    public decimal? MinCellVoltageVolts { get; init; }

    public decimal? MaxCellVoltageVolts { get; init; }

    public decimal? AverageCellVoltageVolts { get; init; }

    public decimal? DeltaCellVoltageVolts { get; init; }

    public decimal? MosTemperatureCelsius { get; init; }

    public decimal? AmbientTemperatureCelsius { get; init; }

    public decimal? BatteryTemperatureCelsius { get; init; }

    public int? CycleCount { get; init; }

    public int? WarningFlags { get; init; }

    public int? StatusFlags { get; init; }

    public int? ProtocolVersion { get; init; }

    public string? SoftwareVersion { get; init; }

    public string? ManufacturerId { get; init; }

    public bool? ChargingEnabled { get; init; }

    public bool? DischargingEnabled { get; init; }

    public bool? BalancingEnabled { get; init; }

    public bool? BatteryOnline { get; init; }

    public required IReadOnlyList<CellVoltageSnapshot> Cells { get; init; }

    public required IReadOnlyList<string> ActiveWarnings { get; init; }

    public IReadOnlyList<DeviceParameter> Parameters { get; init; } = [];
}