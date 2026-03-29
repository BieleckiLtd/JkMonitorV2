using System.Text.Json;
using FluxMonitor.Backend.Configuration;

namespace FluxMonitor.Backend.Services;

public sealed class ManagedInstallAuditRecord
{
    public string InstallKind { get; init; } = string.Empty;

    public string? Repository { get; init; }

    public string? Branch { get; init; }

    public string? ReleaseTag { get; init; }

    public string? AssetName { get; init; }

    public string? Checksum { get; init; }

    public string? Destination { get; init; }

    public string? InstalledBy { get; init; }

    public string? InstalledAtUtc { get; init; }

    public string? MachineName { get; init; }
}

public static class ManagedInstallAudit
{
    private const string AuditFileName = "install-audit.json";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static async Task TryPersistPendingAuditAsync(
        string contentRootPath,
        PostgresLogStore logStore,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(contentRootPath);
        ArgumentNullException.ThrowIfNull(logStore);

        var auditPath = GetAuditPath(contentRootPath);
        if (!File.Exists(auditPath))
        {
            return;
        }

        ManagedInstallAuditRecord? record;
        try
        {
            var json = await File.ReadAllTextAsync(auditPath, cancellationToken);
            record = JsonSerializer.Deserialize<ManagedInstallAuditRecord>(json, JsonOptions);
        }
        catch
        {
            return;
        }

        if (record is null)
        {
            return;
        }

        var timestamp = DateTimeOffset.TryParse(record.InstalledAtUtc, out var installedAt)
            ? installedAt
            : DateTimeOffset.UtcNow;

        var message =
            "Flux Monitor installation recorded. " +
            $"InstallKind={NullToMarker(record.InstallKind)}, " +
            $"Repository={NullToMarker(record.Repository)}, " +
            $"Branch={NullToMarker(record.Branch)}, " +
            $"ReleaseTag={NullToMarker(record.ReleaseTag)}, " +
            $"AssetName={NullToMarker(record.AssetName)}, " +
            $"Checksum={NullToMarker(record.Checksum)}, " +
            $"Destination={NullToMarker(record.Destination)}, " +
            $"InstalledBy={NullToMarker(record.InstalledBy)}, " +
            $"InstalledAtUtc={timestamp:O}, " +
            $"MachineName={NullToMarker(record.MachineName)}.";

        var persisted = await logStore.PersistRecordAsync(
            timestamp,
            "Information",
            "FluxMonitor.Installation",
            message,
            exception: null,
            cancellationToken);

        if (persisted)
        {
            File.Delete(auditPath);
        }
    }

    private static string GetAuditPath(string contentRootPath)
    {
        var installRoot = Directory.GetParent(contentRootPath)?.FullName ?? contentRootPath;
        return Path.Combine(installRoot, AuditFileName);
    }

    private static string NullToMarker(string? value)
        => string.IsNullOrWhiteSpace(value) ? "<none>" : value.Trim();
}
