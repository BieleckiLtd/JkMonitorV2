using System.Text.Json;
using FluxMonitor.Backend.Controllers;
using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class SystemControllerTests
{
    [Fact]
    public void SerializeUpdateProgressStream_UsesWebJsonNaming()
    {
        var payload = SystemController.SerializeUpdateProgressStream(new UpdateProgress
        {
            SessionId = "abcd1234",
            Status = "running",
            IsRunning = true,
            Stage = "Downloading update…",
            Detail = "Downloading the published release package from GitHub.",
            Success = null,
            CanCancel = true,
            CancelUnavailableReason = null,
            StepIndex = 2,
            StepCount = 11,
            PercentComplete = 18,
            StartedAt = DateTimeOffset.Parse("2026-04-02T14:00:00Z"),
            UpdatedAt = DateTimeOffset.Parse("2026-04-02T14:00:05Z")
        });

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;

        Assert.True(root.TryGetProperty("progress", out var progress));
        Assert.False(root.TryGetProperty("Progress", out _));
        Assert.Equal("abcd1234", progress.GetProperty("sessionId").GetString());
        Assert.True(progress.GetProperty("isRunning").GetBoolean());
        Assert.Equal(18, progress.GetProperty("percentComplete").GetInt32());
        Assert.False(progress.TryGetProperty("SessionId", out _));
    }

    [Fact]
    public void SerializeUpdateProgressStreamHeartbeat_UsesSseCommentFrame()
    {
        var payload = SystemController.SerializeUpdateProgressStreamHeartbeat();

        Assert.Equal(": keepalive\n\n", payload);
    }
}
