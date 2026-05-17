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

    [Theory]
    [InlineData(1000, 5000, true, 5000)]
    [InlineData(5000, 1000, true, 5000)]
    [InlineData(0, 5000, true, 0)]
    [InlineData(1000, 5000, false, 1000)]
    public void GetEffectiveBankCacheIntervalMilliseconds_UsesDeviceCadenceForNotifyStreams(
        int bankIntervalMs,
        int devicePollIntervalMs,
        bool isNotifyStream,
        int expectedIntervalMs)
    {
        var intervalMs = GenericBlePollingClient.GetEffectiveBankCacheIntervalMilliseconds(
            bankIntervalMs,
            devicePollIntervalMs,
            isNotifyStream);

        Assert.Equal(expectedIntervalMs, intervalMs);
    }

    [Theory]
    [InlineData(true, true, false, 0, true)]
    [InlineData(true, true, true, 0, false)]
    [InlineData(true, true, true, 1, true)]
    [InlineData(false, true, false, 0, false)]
    [InlineData(true, false, false, 0, false)]
    public void ShouldSendNotifyStreamRequest_PrimesOnceAndRefreshesAfterTimeout(
        bool supportsRequest,
        bool hasWriteCharacteristic,
        bool startRequestIssued,
        int consecutiveTimeouts,
        bool expected)
    {
        var shouldSend = GenericBlePollingClient.ShouldSendNotifyStreamRequest(
            supportsRequest,
            hasWriteCharacteristic,
            startRequestIssued,
            consecutiveTimeouts);

        Assert.Equal(expected, shouldSend);
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(2, false)]
    [InlineData(3, true)]
    public void ShouldResetNotifyStreamAfterTimeouts_ResetsAfterThreeConsecutiveMisses(
        int consecutiveTimeouts,
        bool expected)
    {
        var shouldReset = GenericBlePollingClient.ShouldResetNotifyStreamAfterTimeouts(consecutiveTimeouts);

        Assert.Equal(expected, shouldReset);
    }

    [Theory]
    [InlineData(5000, 1, 5000)]
    [InlineData(5000, 2, 10000)]
    [InlineData(5000, 4, 40000)]
    [InlineData(5000, 8, 60000)]
    [InlineData(0, 3, 0)]
    public void GetReconnectBackoffDelay_UsesConfiguredDelayWithCap(
        int reconnectDelayMs,
        int consecutiveFailures,
        int expectedDelayMs)
    {
        var delay = GenericBlePollingClient.GetReconnectBackoffDelay(
            reconnectDelayMs,
            consecutiveFailures);

        Assert.Equal(TimeSpan.FromMilliseconds(expectedDelayMs), delay);
    }

    [Fact]
    public void DefinitionRequiresWriteCharacteristic_IncludesNotifyStreamCommandFallback()
    {
        var notifyOnlyDefinition = CreateDefinition(CreateBank(0x96));

        Assert.True(GenericBlePollingClient.DefinitionRequiresWriteCharacteristic(notifyOnlyDefinition));
    }

    [Fact]
    public void DefinitionRequiresWriteCharacteristic_IncludesRequestResponseBanks()
    {
        var requestResponseDefinition = CreateDefinition(CreateBank(0x96, "request-response"));

        Assert.True(GenericBlePollingClient.DefinitionRequiresWriteCharacteristic(requestResponseDefinition));
    }

    [Fact]
    public void DefinitionRequiresWriteCharacteristic_IgnoresPassiveNotifyStreamWithoutCommand()
    {
        var passiveNotifyDefinition = CreateDefinition(CreateBank(0x00));

        Assert.False(GenericBlePollingClient.DefinitionRequiresWriteCharacteristic(passiveNotifyDefinition));
    }

    [Fact]
    public void DefinitionRequiresWriteCharacteristic_IncludesStartupCommands()
    {
        var startupCommandDefinition = CreateDefinition([0x97], CreateBank(0x00));

        Assert.True(GenericBlePollingClient.DefinitionRequiresWriteCharacteristic(startupCommandDefinition));
    }

    [Fact]
    public void GetUnsupportedDefinitionMessage_RequiresWriteCharacteristicForNotifyStreamCommandFallback()
    {
        var notifyFallbackDefinition = CreateDefinition(CreateBank(0x96));

        var message = GenericBlePollingClient.GetUnsupportedDefinitionMessage(notifyFallbackDefinition);

        Assert.Equal(
            "BLE writeCharacteristicUuid is required for request-response banks, notify-stream command fallback, or startup commands.",
            message);
    }

    [Fact]
    public void GetUnsupportedDefinitionMessage_RequiresWriteCharacteristicForStartupCommands()
    {
        var startupCommandDefinition = CreateDefinition([0x97], CreateBank(0x00));

        var message = GenericBlePollingClient.GetUnsupportedDefinitionMessage(startupCommandDefinition);

        Assert.Equal(
            "BLE writeCharacteristicUuid is required for request-response banks, notify-stream command fallback, or startup commands.",
            message);
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

    private static DeviceDefinition CreateDefinition(params DataSourceDefinition[] banks)
        => CreateDefinition([], banks);

    private static DeviceDefinition CreateDefinition(IReadOnlyList<byte> startupCommands, params DataSourceDefinition[] banks)
        => new()
        {
            Version = "1",
            Device = new DeviceMetadata
            {
                Id = "test-ble",
                Name = "Test BLE"
            },
            Connection = new ConnectionDefinition
            {
                Transport = new TransportDefinition
                {
                    Type = "ble",
                    Defaults = new TransportDefaults
                    {
                        ServiceUuid = "0000ffe0-0000-1000-8000-00805f9b34fb",
                        NotifyCharacteristicUuid = "0000ffe1-0000-1000-8000-00805f9b34fb"
                    }
                },
                Protocol = new ProtocolDefinition
                {
                    Type = "ble-frame",
                    Settings = new ProtocolSettings
                    {
                        ResponseFrameSize = 8,
                        ChecksumType = "sum8",
                        ResponsePreamble = [0x55],
                        RequestPreamble = [0xAA],
                        StartupCommands = startupCommands
                    }
                }
            },
            DataSources = banks,
            PollGroups = new Dictionary<string, PollGroupDefinition>
            {
                ["fast"] = new() { IntervalMs = 1000 }
            },
            Entities = []
        };

    private static DataSourceDefinition CreateBank(byte command, string readMode = "notify-stream")
        => new()
        {
            Id = "live",
            Name = "Live Data",
            PollGroup = "fast",
            ReadMode = readMode,
            Command = command,
            ResponseFrameType = 0x02
        };
}
