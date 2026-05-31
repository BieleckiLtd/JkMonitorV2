using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class AutomationExpressionSyntaxValidatorTests
{
    [Fact]
    public void TryValidate_AllowsLegacyEqualityAndAndSyntax()
    {
        var isValid = AutomationExpressionSyntaxValidator.TryValidate(
            "time.hour=5 and time.minute=55",
            out var error);

        Assert.True(isValid);
        Assert.Equal(string.Empty, error);
    }

    [Fact]
    public void TryValidate_ReturnsFalseForBrokenExpression()
    {
        var isValid = AutomationExpressionSyntaxValidator.TryValidate(
            "time.hour ==",
            out var error);

        Assert.False(isValid);
        Assert.False(string.IsNullOrWhiteSpace(error));
    }
}