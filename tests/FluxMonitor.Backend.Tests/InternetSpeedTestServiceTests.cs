using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class InternetSpeedTestServiceTests
{
    [Fact]
    public void ParseResult_MapsSpeedtestCliJsonPayload()
    {
        const string payload = """
            {
              "download": 125678901.23,
              "upload": 23456789.01,
              "ping": 18.456,
              "server": {
                "id": "1234",
                "sponsor": "Example Host",
                "name": "London",
                "country": "United Kingdom",
                "d": 42.34,
                "latency": 18.456
              },
              "timestamp": "2026-03-29T17:45:12.123456Z",
              "bytes_sent": 23000000,
              "bytes_received": 120000000,
              "share": null,
              "client": {
                "ip": "203.0.113.5",
                "isp": "Example ISP",
                "country": "GB"
              }
            }
            """;

        var result = InternetSpeedTestService.ParseResult(payload);

        Assert.Equal(125678901.23, result.DownloadBitsPerSecond);
        Assert.Equal(23456789.01, result.UploadBitsPerSecond);
        Assert.Equal(18.456, result.PingMilliseconds);
        Assert.Equal(120000000, result.BytesReceived);
        Assert.Equal(23000000, result.BytesSent);
        Assert.Equal("203.0.113.5", result.Client?.IpAddress);
        Assert.Equal("Example ISP", result.Client?.InternetServiceProvider);
        Assert.Equal("1234", result.Server?.Id);
        Assert.Equal("Example Host", result.Server?.Sponsor);
        Assert.Equal(42.34, result.Server?.DistanceKilometers);
    }

    [Fact]
    public async Task RunSpeedTestAsync_StoresCompletedSnapshot()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var runner = new StubCommandRunner(new CommandResult(
            true,
            """
            {"download":98000000.0,"upload":41000000.0,"ping":14.2,"server":{"id":"77","sponsor":"Host","name":"Manchester","country":"United Kingdom","d":"12.8","latency":14.2},"timestamp":"2026-03-29T17:45:12.123456Z","bytes_sent":4100000,"bytes_received":9800000,"share":null,"client":{"ip":"203.0.113.7","isp":"ISP","country":"GB"}}
            """,
            string.Empty,
            0));
        var service = new InternetSpeedTestService(runner, NullLogger<InternetSpeedTestService>.Instance);

        await service.RunSpeedTestAsync(DateTimeOffset.Parse("2026-03-29T17:44:00Z"));
        var snapshot = await service.GetSnapshotAsync(cancellationToken);

        Assert.True(snapshot.Supported);
        Assert.Equal("succeeded", snapshot.Status);
        Assert.False(snapshot.IsRunning);
        Assert.True(snapshot.CanStart);
        Assert.NotNull(snapshot.CompletedAt);
        Assert.Equal(98_000_000.0, snapshot.Result?.DownloadBitsPerSecond);
        Assert.Equal(41_000_000.0, snapshot.Result?.UploadBitsPerSecond);
        Assert.Equal("Manchester", snapshot.Result?.Server?.Name);
    }

    [Fact]
    public async Task RunSpeedTestAsync_StoresFailureSnapshot_WhenCommandFails()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var runner = new StubCommandRunner(new CommandResult(
            false,
            string.Empty,
            "Cannot retrieve speedtest configuration",
            1));
        var service = new InternetSpeedTestService(runner, NullLogger<InternetSpeedTestService>.Instance);

        await service.RunSpeedTestAsync(DateTimeOffset.Parse("2026-03-29T17:44:00Z"));
        var snapshot = await service.GetSnapshotAsync(cancellationToken);

        Assert.True(snapshot.Supported);
        Assert.Equal("failed", snapshot.Status);
        Assert.False(snapshot.IsRunning);
        Assert.True(snapshot.CanStart);
        Assert.Contains("could not reach the speed test service", snapshot.StatusMessage ?? string.Empty, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class StubCommandRunner(CommandResult result) : ICommandRunner
    {
        public Task<CommandResult> RunAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
        {
            return Task.FromResult(result);
        }
    }
}
