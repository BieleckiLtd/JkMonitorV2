using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class GenericBlePollingClientTests
{
    [Theory]
    [InlineData("4F:11:72:D1:5B:D3", "4F:11:72:D1:5B:D3")]
    [InlineData("4f:11:72:d1:5b:d3", "4F1172D15BD3")]
    [InlineData("4F1172D15BD3", "4F:11:72:D1:5B:D3")]
    public void IdentifierMatches_MatchesBleAddressFormats(string identifier, string candidate)
    {
        var matched = GenericBlePollingClient.IdentifierMatches(identifier, candidate);

        Assert.True(matched);
    }

    [Theory]
    [InlineData("jk", null, "JK B2A8S20P", null)]
    [InlineData("b2a8", null, null, "JK B2A8S20P")]
    public void IdentifierMatches_MatchesAliasAndNameFragments(string identifier, string? address, string? alias, string? name)
    {
        var matched = GenericBlePollingClient.IdentifierMatches(identifier, address, alias, name);

        Assert.True(matched);
    }

    [Fact]
    public void IdentifierMatches_IgnoresMissingCandidates()
    {
        var matched = GenericBlePollingClient.IdentifierMatches("4F:11:72:D1:5B:D3", null, "", "   ");

        Assert.False(matched);
    }
}
