using FluxMonitor.Backend.Configuration;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class LogStorageOptionsTests
{
    [Fact]
    public void Resolve_ReturnsConfiguredOptions_WhenDedicatedConnectionStringIsPresent()
    {
        var configured = new LogStorageOptions
        {
            Enabled = true,
            ConnectionString = "Host=logs-db;Database=logs;",
            SchemaName = "monitoring",
            TableName = "logs"
        };

        var resolved = LogStorageOptions.Resolve(configured, "Host=main-db;Database=fluxmonitor;");

        Assert.Same(configured, resolved);
    }

    [Fact]
    public void Resolve_FallsBackToMonitorStorageConnection_WhenDedicatedConnectionStringIsMissing()
    {
        var configured = new LogStorageOptions
        {
            Enabled = false,
            ConnectionString = "",
            AdminConnectionString = "Host=admin-db;Database=postgres;",
            AutoCreateDatabase = true,
            AdminDatabase = "postgres",
            SchemaName = "monitoring",
            TableName = "logs"
        };

        var resolved = LogStorageOptions.Resolve(configured, "Host=main-db;Database=fluxmonitor;");

        Assert.NotSame(configured, resolved);
        Assert.True(resolved.Enabled);
        Assert.Equal("Host=main-db;Database=fluxmonitor;", resolved.ConnectionString);
        Assert.Equal("Host=admin-db;Database=postgres;", resolved.AdminConnectionString);
        Assert.True(resolved.AutoCreateDatabase);
        Assert.Equal("postgres", resolved.AdminDatabase);
        Assert.Equal("monitoring", resolved.SchemaName);
        Assert.Equal("logs", resolved.TableName);
    }

    [Fact]
    public void Resolve_LeavesDefaultsUntouched_WhenNoConnectionStringIsAvailable()
    {
        var resolved = LogStorageOptions.Resolve(configured: null, monitorStorageConnectionString: null);

        Assert.True(resolved.Enabled);
        Assert.Equal(string.Empty, resolved.ConnectionString);
        Assert.Equal("public", resolved.SchemaName);
        Assert.Equal("application_logs", resolved.TableName);
    }
}
