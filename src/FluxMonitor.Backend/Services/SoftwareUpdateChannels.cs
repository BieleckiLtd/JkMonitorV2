namespace FluxMonitor.Backend.Services;

internal static class SoftwareUpdateChannels
{
    public const string Dev = "dev";
    public const string Main = "main";
    public const string DevReleaseTag = "dev-latest";

    public static string FromReleaseTag(string? releaseTagOrChannel)
    {
        if (string.Equals(releaseTagOrChannel, Dev, StringComparison.OrdinalIgnoreCase)
            || string.Equals(releaseTagOrChannel, DevReleaseTag, StringComparison.OrdinalIgnoreCase))
        {
            return Dev;
        }

        return Main;
    }

    public static string NormalizeSelection(string? channel)
    {
        var normalized = channel?.Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            throw new InvalidOperationException("Update channel is required. Use 'dev' or 'main'.");
        }

        if (string.Equals(normalized, Dev, StringComparison.OrdinalIgnoreCase))
        {
            return Dev;
        }

        if (string.Equals(normalized, Main, StringComparison.OrdinalIgnoreCase))
        {
            return Main;
        }

        throw new InvalidOperationException(
            $"Unsupported update channel '{normalized}'. Use '{Dev}' or '{Main}'.");
    }
}
