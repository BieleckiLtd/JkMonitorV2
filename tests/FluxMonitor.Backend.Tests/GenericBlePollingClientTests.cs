using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.DeviceDefinition;
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

    [Fact]
    public void GetNotifyStreamWaitTimeout_UsesTwoPollIntervalsWhenAvailable()
    {
        var timeout = GenericBlePollingClient.GetNotifyStreamWaitTimeout(TimeSpan.FromSeconds(20), 1000);

        Assert.Equal(TimeSpan.FromSeconds(2), timeout);
    }

    [Fact]
    public void GetNotifyStreamWaitTimeout_AppliesMinimumFloorForFastPollGroups()
    {
        var timeout = GenericBlePollingClient.GetNotifyStreamWaitTimeout(TimeSpan.FromSeconds(20), 250);

        Assert.Equal(TimeSpan.FromMilliseconds(1500), timeout);
    }

    [Fact]
    public void GetNotifyStreamWaitTimeout_CapsAtConnectionTimeout()
    {
        var timeout = GenericBlePollingClient.GetNotifyStreamWaitTimeout(TimeSpan.FromSeconds(3), 5000);

        Assert.Equal(TimeSpan.FromSeconds(3), timeout);
    }

    [Fact]
    public void SupportsNotifyStreamRequestFallback_RequiresConfiguredCommand()
    {
        var bankWithoutCommand = CreateBank(0x00);
        var bankWithCommand = CreateBank(0x96);

        Assert.False(GenericBlePollingClient.SupportsNotifyStreamRequestFallback(bankWithoutCommand));
        Assert.True(GenericBlePollingClient.SupportsNotifyStreamRequestFallback(bankWithCommand));
    }

    [Fact]
    public void ApplyAdvertisedServiceVerification_MarksMatchingCandidatesWithoutConnecting()
    {
        var candidate = new BleDiscoveredDevice(
            "AA:BB:CC:DD:EE:FF",
            "JK-BMS",
            "JK-BMS",
            "JK-BMS",
            false,
            false,
            -52,
            [],
            ["0000ffe0-0000-1000-8000-00805f9b34fb"],
            false,
            null,
            null);

        var verified = GenericBlePollingClient.ApplyAdvertisedServiceVerification(
            candidate,
            "0000ffe0-0000-1000-8000-00805f9b34fb");

        Assert.True(verified.IsDefinitionVerified);
        Assert.Equal("Service match", verified.VerificationLabel);
        Assert.Equal("Advertises the expected BLE service.", verified.VerificationDetails);
    }

    [Fact]
    public void ApplyAdvertisedServiceVerification_LeavesNonMatchingCandidatesUnverified()
    {
        var candidate = new BleDiscoveredDevice(
            "AA:BB:CC:DD:EE:FF",
            "Other",
            "Other",
            "Other",
            false,
            false,
            -72,
            [],
            ["0000180f-0000-1000-8000-00805f9b34fb"],
            false,
            null,
            null);

        var verified = GenericBlePollingClient.ApplyAdvertisedServiceVerification(
            candidate,
            "0000ffe0-0000-1000-8000-00805f9b34fb");

        Assert.False(verified.IsDefinitionVerified);
        Assert.Null(verified.VerificationLabel);
        Assert.Null(verified.VerificationDetails);
    }

    private static DataSourceDefinition CreateBank(byte command)
        => new()
        {
            Id = "live",
            Name = "Live Data",
            PollGroup = "fast",
            ReadMode = "notify-stream",
            Command = command,
            ResponseFrameType = 0x02
        };
}
