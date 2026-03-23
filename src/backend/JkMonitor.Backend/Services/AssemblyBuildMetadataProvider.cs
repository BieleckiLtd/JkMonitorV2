using System.Reflection;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

public sealed class AssemblyBuildMetadataProvider : IBuildMetadataProvider
{
    private readonly BuildRuntimeInfo _buildInfo;

    public AssemblyBuildMetadataProvider()
        : this(typeof(Program).Assembly)
    {
    }

    internal AssemblyBuildMetadataProvider(Assembly assembly)
    {
        ArgumentNullException.ThrowIfNull(assembly);

        var metadata = assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .GroupBy(attribute => attribute.Key, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Last().Value, StringComparer.OrdinalIgnoreCase);

        _buildInfo = new BuildRuntimeInfo
        {
            ReleaseTag = GetMetadataValue(metadata, "JkMonitorReleaseTag"),
            SourceRevisionId = GetMetadataValue(metadata, "JkMonitorSourceRevisionId"),
            InformationalVersion = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion,
            WorkflowRunNumber = GetMetadataValue(metadata, "JkMonitorWorkflowRunNumber"),
            WorkflowRunAttempt = GetMetadataValue(metadata, "JkMonitorWorkflowRunAttempt"),
            BuiltAt = GetMetadataValue(metadata, "JkMonitorBuiltAt")
        };
    }

    public BuildRuntimeInfo GetBuildInfo() => _buildInfo;

    private static string? GetMetadataValue(IReadOnlyDictionary<string, string?> metadata, string key)
    {
        return metadata.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value)
            ? value
            : null;
    }
}
