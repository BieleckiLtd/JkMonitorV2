using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class GenericSerialPollingClientTests
{
    [Fact]
    public void ShouldConsiderColdSlowBankDeferral_ReturnsFalse_ForDetailRefreshes()
    {
        var shouldDefer = GenericSerialPollingClient.ShouldConsiderColdSlowBankDeferral(
            includeDetailBanks: true,
            hasCachedBank: false,
            intervalMs: 30000,
            fastestPollIntervalMs: 5000);

        Assert.False(shouldDefer);
    }

    [Fact]
    public void ShouldConsiderColdSlowBankDeferral_ReturnsTrue_ForColdSlowBanksOutsideDetailRefreshes()
    {
        var shouldDefer = GenericSerialPollingClient.ShouldConsiderColdSlowBankDeferral(
            includeDetailBanks: false,
            hasCachedBank: false,
            intervalMs: 30000,
            fastestPollIntervalMs: 5000);

        Assert.True(shouldDefer);
    }
}