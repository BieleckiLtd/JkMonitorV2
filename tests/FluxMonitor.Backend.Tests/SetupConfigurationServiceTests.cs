using System.Text.Json.Nodes;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class SetupConfigurationServiceTests : IDisposable
{
    private readonly string _tempRootPath = Path.Combine(Path.GetTempPath(), $"FluxMonitor-setup-{Guid.NewGuid():N}");

    [Fact]
    public void Apply_RejectsMissingConnectionString()
    {
        var service = CreateService();

        var ex = Assert.Throws<InvalidOperationException>(() => service.Apply(new ApplySetupRequest
        {
            StartupMode = "hardware",
            UseDatabase = false,
            ConnectionString = "",
            SerialPort = "/dev/ttyUSB0",
            RestartApplication = false
        }));

        Assert.Contains("PostgreSQL connection string is required", ex.Message);
    }

    [Fact]
    public void Apply_AlwaysWritesTimescaleDbStorage()
    {
        var service = CreateService();

        service.Apply(new ApplySetupRequest
        {
            StartupMode = "hardware",
            UseDatabase = false,
            ConnectionString = "Host=127.0.0.1;Database=fluxmonitor;Username=fluxmonitor;Password=secret",
            SerialPort = "/dev/ttyUSB0",
            RestartApplication = false
        });

        var path = Path.Combine(_tempRootPath, "appsettings.Production.Local.json");
        var root = JsonNode.Parse(File.ReadAllText(path))?.AsObject();

        Assert.NotNull(root);
        Assert.Equal("TimescaleDb", root!["Monitor"]?["Storage"]?["Provider"]?.GetValue<string>());
        Assert.Equal(
            "Host=127.0.0.1;Database=fluxmonitor;Username=fluxmonitor;Password=secret",
            root["Monitor"]?["Storage"]?["ConnectionString"]?.GetValue<string>());
    }

    [Fact]
    public void Apply_WritesDualStackUrlsToManagedEnvironmentFile()
    {
        var installRoot = Path.Combine(_tempRootPath, "managed-install");
        var contentRoot = Path.Combine(installRoot, "app");
        var service = CreateService(contentRoot);

        service.Apply(new ApplySetupRequest
        {
            StartupMode = "hardware",
            UseDatabase = false,
            ConnectionString = "Host=127.0.0.1;Database=fluxmonitor;Username=fluxmonitor;Password=secret",
            SerialPort = "/dev/ttyUSB0",
            RestartApplication = false
        });

        var envPath = Path.Combine(installRoot, "fluxmonitor.env");
        var lines = File.ReadAllLines(envPath);

        Assert.Contains("ASPNETCORE_ENVIRONMENT=Production", lines);
        Assert.Contains(
            "ASPNETCORE_URLS=http://[::]:5074",
            lines);
    }

    [Fact]
    public void GetDatabaseSettings_ReturnsEffectiveRetentionAndCompression()
    {
        var service = CreateService(environmentName: "Production");

        var result = service.GetDatabaseSettings();

        Assert.Equal(10, result.RawSecondsWindowMinutes);
        Assert.Equal(5, result.PersistedBucketMinutes);
    }

    [Fact]
    public void SaveDatabaseSettings_WritesRetentionAndCompressionToCurrentEnvironmentFile()
    {
        var service = CreateService(environmentName: "Production");

        var response = service.SaveDatabaseSettings(new SaveDatabaseSettingsRequest
        {
            RawSecondsWindowMinutes = 10,
            PersistedBucketMinutes = 30,
            RestartApplication = false
        });

        var path = Path.Combine(_tempRootPath, "appsettings.Production.Local.json");
        var root = JsonNode.Parse(File.ReadAllText(path))?.AsObject();

        Assert.NotNull(root);
        Assert.False(response.RestartScheduled);
        Assert.Equal(10, root!["Monitor"]?["Storage"]?["Retention"]?["RawSecondsWindowMinutes"]?.GetValue<int>());
        Assert.Equal(30, root["Monitor"]?["Storage"]?["Retention"]?["PersistedBucketMinutes"]?.GetValue<int>());
        Assert.Equal(0, root["Monitor"]?["Storage"]?["Retention"]?["FiveMinuteWindowDays"]?.GetValue<int>());
        Assert.Equal(0, root["Monitor"]?["Storage"]?["Compression"]?["CompressAfterMinutes"]?.GetValue<int>());
    }

    [Fact]
    public void SaveDatabaseSettings_RejectsUnsupportedPersistedBucketMinutes()
    {
        var service = CreateService(environmentName: "Production");

        var ex = Assert.Throws<InvalidOperationException>(() => service.SaveDatabaseSettings(new SaveDatabaseSettingsRequest
        {
            RawSecondsWindowMinutes = 10,
            PersistedBucketMinutes = 7,
            RestartApplication = false
        }));

        Assert.Contains("PersistedBucketMinutes must be one of", ex.Message);
    }

    [Fact]
    public void SaveDatabaseSettings_RejectsUnsupportedTemporaryHistoryMinutes()
    {
        var service = CreateService(environmentName: "Production");

        var ex = Assert.Throws<InvalidOperationException>(() => service.SaveDatabaseSettings(new SaveDatabaseSettingsRequest
        {
            RawSecondsWindowMinutes = 2,
            PersistedBucketMinutes = 5,
            RestartApplication = false
        }));

        Assert.Contains("RawSecondsWindowMinutes must be one of", ex.Message);
    }

    private SetupConfigurationService CreateService(string? contentRootPath = null, string environmentName = "Test")
    {
        var effectiveContentRoot = contentRootPath ?? _tempRootPath;
        Directory.CreateDirectory(effectiveContentRoot);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Monitor:Storage:Provider"] = "TimescaleDb",
                ["Monitor:Storage:ConnectionString"] = "Host=localhost;Database=seed;",
                ["Monitor:Storage:Retention:RawSecondsWindowMinutes"] = "10",
                ["Monitor:Storage:Retention:PersistedBucketMinutes"] = "5",
                ["Monitor:Storage:Retention:FiveMinuteWindowDays"] = "7",
                ["Monitor:ApiSecurity:TunnelProvider"] = "none"
            })
            .Build();

        var environment = new TestHostEnvironment
        {
            EnvironmentName = environmentName,
            ContentRootPath = effectiveContentRoot
        };
        var lifetime = new TestHostApplicationLifetime();
        var restartService = new ManagedRestartService(
            environment,
            lifetime,
            NullLogger<ManagedRestartService>.Instance);

        return new SetupConfigurationService(
            environment,
            configuration,
            restartService,
            NullLogger<SetupConfigurationService>.Instance);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempRootPath))
        {
            Directory.Delete(_tempRootPath, recursive: true);
        }
    }

    private sealed class TestHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "FluxMonitor.Backend.Tests";
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestHostApplicationLifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication()
        {
        }
    }
}
