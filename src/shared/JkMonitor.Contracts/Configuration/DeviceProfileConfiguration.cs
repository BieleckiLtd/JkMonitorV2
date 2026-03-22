namespace JkMonitor.Contracts.Configuration;

public sealed class DeviceProfileConfiguration
{
    public required string ProfileId { get; init; }

    public required string DisplayName { get; init; }

    public required string ProtocolHandler { get; init; }

    public TransportConfiguration? Transport { get; init; }

    public IReadOnlyList<RegisterDefinition> Registers { get; init; } = [];
}

public sealed class TransportConfiguration
{
    public string Type { get; init; } = "serial";

    public string? PortName { get; init; }

    public int BaudRate { get; init; } = 115200;

    public int DataBits { get; init; } = 8;

    public string Parity { get; init; } = "None";

    public string StopBits { get; init; } = "One";

    public int ReadTimeoutMs { get; init; } = 1000;

    public int WriteTimeoutMs { get; init; } = 1000;
}

public sealed class RegisterDefinition
{
    public required string RegisterId { get; init; }

    public required string Key { get; init; }

    public required string DisplayName { get; init; }

    public string? Unit { get; init; }

    public string Category { get; init; } = "General";

    public decimal ScaleFactor { get; init; } = 1m;

    public string DataType { get; init; } = "auto";

    public int SortOrder { get; init; }

    public bool Enabled { get; init; } = true;
}
