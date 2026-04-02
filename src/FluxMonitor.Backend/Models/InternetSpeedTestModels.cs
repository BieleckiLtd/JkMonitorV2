namespace FluxMonitor.Backend.Models;

public sealed record class InternetSpeedTestSnapshot
{
    public bool Supported { get; init; }

    public string Status { get; init; } = "unsupported";

    public string Backend { get; init; } = "speedtest-cli";

    public bool CanStart { get; init; }

    public bool IsRunning { get; init; }

    public string? StatusMessage { get; init; }

    public DateTimeOffset? StartedAt { get; init; }

    public DateTimeOffset? CompletedAt { get; init; }

    public DateTimeOffset? LastUpdatedAt { get; init; }

    public string? Stage { get; init; }

    public int? StepIndex { get; init; }

    public int? StepCount { get; init; }

    public int? StagePercentComplete { get; init; }

    public int? PercentComplete { get; init; }

    public InternetSpeedTestResult? Result { get; init; }
}

public sealed record class InternetSpeedTestResult
{
    public double? DownloadBitsPerSecond { get; init; }

    public double? UploadBitsPerSecond { get; init; }

    public double? PingMilliseconds { get; init; }

    public long? BytesReceived { get; init; }

    public long? BytesSent { get; init; }

    public DateTimeOffset? TestedAt { get; init; }

    public string? ShareUrl { get; init; }

    public string? ConnectionMode { get; init; }

    public InternetSpeedTestServerSnapshot? Server { get; init; }

    public InternetSpeedTestClientSnapshot? Client { get; init; }
}

public sealed record class InternetSpeedTestServerSnapshot
{
    public string? Id { get; init; }

    public string? Sponsor { get; init; }

    public string? Name { get; init; }

    public string? Country { get; init; }

    public double? DistanceKilometers { get; init; }

    public double? LatencyMilliseconds { get; init; }
}

public sealed record class InternetSpeedTestClientSnapshot
{
    public string? IpAddress { get; init; }

    public string? InternetServiceProvider { get; init; }

    public string? Country { get; init; }
}

public sealed record class InternetSpeedTestCommandResult
{
    public bool Success { get; init; }

    public required string Message { get; init; }

    public required InternetSpeedTestSnapshot Snapshot { get; init; }
}
