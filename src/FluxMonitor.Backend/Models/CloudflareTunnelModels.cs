namespace FluxMonitor.Backend.Models;

public sealed record class CloudflareTunnelStatusSnapshot
{
    public bool Supported { get; init; }

    public string? StatusMessage { get; init; }

    public required string TunnelProvider { get; init; }

    public bool HasStoredToken { get; init; }

    public string? MaskedToken { get; init; }

    public bool Configured { get; init; }

    public bool PackageInstalled { get; init; }

    public string? PackageVersion { get; init; }

    public bool ServiceInstalled { get; init; }

    public bool ServiceRunning { get; init; }

    public bool ServiceEnabled { get; init; }

    public string? ServiceLoadState { get; init; }

    public string? ServiceActiveState { get; init; }

    public string? ServiceSubState { get; init; }

    public string? ServiceUnitFileState { get; init; }

    public string? ServiceResult { get; init; }
}

public sealed record class SaveCloudflareTunnelRequest
{
    public bool Enabled { get; init; }

    public string? TunnelTokenOrCommand { get; init; }
}

public sealed record class SaveCloudflareTunnelResponse
{
    public bool Success { get; init; }

    public required string Message { get; init; }

    public required CloudflareTunnelStatusSnapshot Status { get; init; }
}
