using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class CloudflareTunnelServiceTests
{
    [Fact]
    public void BuildStartupReconcileArguments_UsesNoBlockSystemctlInvocation()
    {
        var arguments = CloudflareTunnelService.BuildStartupReconcileArguments("start");

        Assert.Equal(["--no-block", "start", "cloudflared.service"], arguments);
    }

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
    public void NormalizeTunnelToken_ExtractsEmbeddedJwtTokenFromPastedCommand()
    {
        var token = CloudflareTunnelService.NormalizeTunnelToken(
            "sudo cloudflared tunnel token --some-flag https://example.com eyJhIjoiZXhhbXBsZS10b2tlbiJ9");

        Assert.Equal("eyJhIjoiZXhhbXBsZS10b2tlbiJ9", token);
    }

    [Fact]
    public void NormalizeTunnelToken_RejectsUnparseableCommand()
    {
        var exception = Assert.Throws<InvalidOperationException>(() =>
            CloudflareTunnelService.NormalizeTunnelToken("cloudflared service install"));

        Assert.Contains("could not be parsed", exception.Message);
    }

    [Fact]
    public void MaskToken_ReturnsPrefixOnly()
    {
        var masked = CloudflareTunnelService.MaskToken("eyJhIjoiNm9yLWxlc3MtbG9uZy10b2tlbiI");

        Assert.Equal("eyJhIjoiNm...", masked);
    }

    [Fact]
    public void MaskToken_ReturnsNullForEmptyValue()
    {
        Assert.Null(CloudflareTunnelService.MaskToken(" "));
    }
}
