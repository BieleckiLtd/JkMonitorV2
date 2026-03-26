using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

public interface IBuildMetadataProvider
{
    BuildRuntimeInfo GetBuildInfo();
}
