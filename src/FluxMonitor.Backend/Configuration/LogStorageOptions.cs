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

    public static LogStorageOptions Resolve(LogStorageOptions? configured, string? monitorStorageConnectionString)
    {
        configured ??= new LogStorageOptions();

        if (!string.IsNullOrWhiteSpace(configured.ConnectionString))
        {
            return configured;
        }

        if (string.IsNullOrWhiteSpace(monitorStorageConnectionString))
        {
            return configured;
        }

        return new LogStorageOptions
        {
            Enabled = true,
            ConnectionString = monitorStorageConnectionString,
            AdminConnectionString = configured.AdminConnectionString,
            AutoCreateDatabase = configured.AutoCreateDatabase,
            AdminDatabase = configured.AdminDatabase,
            SchemaName = configured.SchemaName,
            TableName = configured.TableName
        };
    }
}
