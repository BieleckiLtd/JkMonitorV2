namespace FluxMonitor.Backend.Models;

public sealed class SystemServicesCatalogSnapshot
{
    public bool Supported { get; set; }
    public string? StatusMessage { get; set; }
    public SystemServicesCatalogSummary Summary { get; set; } = new();
    public List<InstalledPackageSummary> Packages { get; set; } = [];
    public List<ServiceUnitSummary> Services { get; set; } = [];
}

public sealed class SystemServicesCatalogSummary
{
    public int PackageCount { get; set; }
    public int AutomaticPackageCount { get; set; }
    public int ServiceCount { get; set; }
    public int EnabledServiceCount { get; set; }
    public int RunningServiceCount { get; set; }
}

public sealed class InstalledPackageSummary
{
    public required string Name { get; set; }
    public required string Version { get; set; }
    public required string Architecture { get; set; }
    public required string Channel { get; set; }
    public required string Status { get; set; }
    public bool IsAutomatic { get; set; }
}

public sealed class ServiceUnitSummary
{
    public required string Name { get; set; }
    public required string DisplayName { get; set; }
    public string? Description { get; set; }
    public required string UnitFileState { get; set; }
    public string? VendorPreset { get; set; }
    public string? ActiveState { get; set; }
    public string? SubState { get; set; }
    public bool IsEnabled { get; set; }
    public bool IsRunning { get; set; }
}

public sealed class SystemServiceInsight
{
    public bool Supported { get; set; }
    public string? StatusMessage { get; set; }
    public required string Kind { get; set; }
    public required string Id { get; set; }
    public required string Title { get; set; }
    public string? Subtitle { get; set; }
    public string? Summary { get; set; }
    public string? Narrative { get; set; }
    public List<SystemServiceInsightMetric> Metrics { get; set; } = [];
    public List<SystemServiceInsightFact> Facts { get; set; } = [];
    public List<string> Highlights { get; set; } = [];
    public List<SystemServiceInsightRelatedItem> RelatedItems { get; set; } = [];
}

public sealed class SystemServiceInsightMetric
{
    public required string Label { get; set; }
    public required string Value { get; set; }
}

public sealed class SystemServiceInsightFact
{
    public required string Label { get; set; }
    public required string Value { get; set; }
}

public sealed class SystemServiceInsightRelatedItem
{
    public required string Kind { get; set; }
    public required string Id { get; set; }
    public required string Title { get; set; }
    public string? Subtitle { get; set; }
}
