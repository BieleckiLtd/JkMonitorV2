using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Services;

public interface IBuildMetadataProvider
{
    BuildRuntimeInfo GetBuildInfo();
}
