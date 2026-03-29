using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class CloudflareTunnelServiceTests
{
    [Fact]
    public void NormalizeTunnelToken_ExtractsTokenFromInstallCommand()
    {
        var token = CloudflareTunnelService.NormalizeTunnelToken(
            "sudo cloudflared service install eyJhIjoiZXhhbXBsZS10b2tlbiJ9");

        Assert.Equal("eyJhIjoiZXhhbXBsZS10b2tlbiJ9", token);
    }

    [Fact]
    public void NormalizeTunnelToken_ExtractsTokenFromRunCommand()
    {
        var token = CloudflareTunnelService.NormalizeTunnelToken(
            "cloudflared tunnel run --token token-from-dashboard");

        Assert.Equal("token-from-dashboard", token);
    }

    [Fact]
    public void NormalizeTunnelToken_RejectsUnparseableCommand()
    {
        var exception = Assert.Throws<InvalidOperationException>(() =>
            CloudflareTunnelService.NormalizeTunnelToken("cloudflared service install"));

        Assert.Contains("could not be parsed", exception.Message);
    }

    [Fact]
    public void NormalizePublicUrl_AddsHttpsWhenMissing()
    {
        var normalized = CloudflareTunnelService.NormalizePublicUrl("monitor.example.com");

        Assert.Equal("https://monitor.example.com", normalized);
    }

    [Fact]
    public void NormalizePublicUrl_RejectsInvalidUrl()
    {
        var exception = Assert.Throws<InvalidOperationException>(() =>
            CloudflareTunnelService.NormalizePublicUrl("not a valid url"));

        Assert.Contains("Enter a valid public URL", exception.Message);
    }
}
