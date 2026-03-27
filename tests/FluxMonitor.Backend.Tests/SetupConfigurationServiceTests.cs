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

    private SetupConfigurationService CreateService()
    {
        Directory.CreateDirectory(_tempRootPath);

        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Monitor:Storage:Provider"] = "TimescaleDb",
                ["Monitor:Storage:ConnectionString"] = "Host=localhost;Database=seed;",
                ["Monitor:Storage:Retention:RawSecondsWindowMinutes"] = "10",
                ["Monitor:Storage:Retention:OneMinuteWindowHours"] = "1",
                ["Monitor:Storage:Retention:FiveMinuteWindowDays"] = "7",
                ["Monitor:ApiSecurity:TunnelProvider"] = "none"
            })
            .Build();

        var environment = new TestHostEnvironment { ContentRootPath = _tempRootPath };
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
