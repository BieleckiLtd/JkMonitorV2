namespace JkMonitor.Contracts.Status;

public sealed record DeviceParameter
{
    public required string Key { get; init; }

    public required string DisplayName { get; init; }

    public required string Category { get; init; }

    public decimal? NumericValue { get; init; }

    public string? StringValue { get; init; }

    public bool? BooleanValue { get; init; }

    public string? Unit { get; init; }

    public int SortOrder { get; init; }

    public bool IsWritable { get; init; }

    public long? RawValue { get; init; }
}
