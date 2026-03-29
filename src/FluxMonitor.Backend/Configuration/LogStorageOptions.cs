namespace FluxMonitor.Backend.Configuration;

public sealed class LogStorageOptions
{
    public bool Enabled { get; init; } = true;

    public string ConnectionString { get; init; } = string.Empty;

    public string? AdminConnectionString { get; init; }

    public bool AutoCreateDatabase { get; init; }

    public string AdminDatabase { get; init; } = "postgres";

    public string SchemaName { get; init; } = "public";

    public string TableName { get; init; } = "application_logs";
}