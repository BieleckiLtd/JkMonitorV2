namespace FluxMonitor.Backend.Models;

public sealed class ModbusScannerReadRequest
{
    public string PortName { get; set; } = string.Empty;
    public int SlaveAddress { get; set; } = 1;
    public int BaudRate { get; set; } = 9600;
    public string Parity { get; set; } = "None";
    public int DataBits { get; set; } = 8;
    public int StopBits { get; set; } = 1;
    public int ResponseTimeoutMs { get; set; } = 1000;
    public int RetryCount { get; set; } = 0;
    public int StartRegister { get; set; }
    public int RegisterCount { get; set; } = 16;
    public int RegistersPerRequest { get; set; } = 16;
    public string RegisterKind { get; set; } = "holding";
}

public sealed class ModbusScannerReadResult
{
    public required string PortName { get; set; }
    public int SlaveAddress { get; set; }
    public int BaudRate { get; set; }
    public required string Parity { get; set; }
    public int DataBits { get; set; }
    public int StopBits { get; set; }
    public int ResponseTimeoutMs { get; set; }
    public int RetryCount { get; set; }
    public required string RegisterKind { get; set; }
    public int StartRegister { get; set; }
    public int RegisterCount { get; set; }
    public int RegistersPerRequest { get; set; }
    public string CollectedAtUtc { get; set; } = DateTime.UtcNow.ToString("O");
    public int TotalRequests { get; set; }
    public List<ModbusScannerReadBlock> Blocks { get; set; } = [];
    public List<ModbusScannerRegisterValue> Registers { get; set; } = [];
}

public sealed class ModbusScannerReadBlock
{
    public int StartAddress { get; set; }
    public int RegisterCount { get; set; }
    public int Attempts { get; set; }
}

public sealed class ModbusScannerRegisterValue
{
    public int Address { get; set; }
    public int HighByte { get; set; }
    public int LowByte { get; set; }
    public int UnsignedValue { get; set; }
    public string HexValue { get; set; } = string.Empty;
}
