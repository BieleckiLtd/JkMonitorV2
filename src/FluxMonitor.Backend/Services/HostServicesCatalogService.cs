using System.Diagnostics;
using System.Globalization;
using System.Text;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class HostServicesCatalogService(ILogger<HostServicesCatalogService> logger)
{
    public async Task<SystemServicesCatalogSnapshot> GetCatalogAsync(CancellationToken cancellationToken = default)
    {
        var packagesTask = GetPackagesAsync(cancellationToken);
        var servicesTask = GetServicesAsync(cancellationToken);

        await Task.WhenAll(packagesTask, servicesTask);

        var packagesSnapshot = await packagesTask;
        var servicesSnapshot = await servicesTask;

        var statusMessages = new[]
        {
            servicesSnapshot.StatusMessage,
            packagesSnapshot.StatusMessage
        }
            .Where(message => !string.IsNullOrWhiteSpace(message))
            .Distinct(StringComparer.Ordinal)
            .ToList();

        return new SystemServicesCatalogSnapshot
        {
            Supported = packagesSnapshot.Supported || servicesSnapshot.Supported,
            StatusMessage = statusMessages.Count > 0 ? string.Join(' ', statusMessages) : null,
            Summary = new SystemServicesCatalogSummary
            {
                PackageCount = packagesSnapshot.PackageCount,
                AutomaticPackageCount = packagesSnapshot.AutomaticPackageCount,
                ServiceCount = servicesSnapshot.ServiceCount,
                EnabledServiceCount = servicesSnapshot.EnabledServiceCount,
                RunningServiceCount = servicesSnapshot.RunningServiceCount
            },
            Packages = packagesSnapshot.Packages,
            Services = servicesSnapshot.Services
        };
    }

    public async Task<SystemServicesSnapshot> GetServicesAsync(CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new SystemServicesSnapshot
            {
                Supported = false,
                StatusMessage = "Service browsing is available on Linux hosts."
            };
        }

        var unitFilesTask = RunProcessAsync(
            "systemctl",
            ["list-unit-files", "--type=service", "--no-legend", "--no-pager", "--plain"],
            cancellationToken);
        var runtimeTask = RunProcessAsync(
            "systemctl",
            ["list-units", "--type=service", "--all", "--no-legend", "--no-pager", "--plain"],
            cancellationToken);

        await Task.WhenAll(unitFilesTask, runtimeTask);

        var unitFilesResult = await unitFilesTask;
        var runtimeResult = await runtimeTask;

        var runtimeByName = runtimeResult.Succeeded
            ? ParseUnitRuntimeLines(runtimeResult.StandardOutput)
                .ToDictionary(runtime => runtime.Name, StringComparer.OrdinalIgnoreCase)
            : new Dictionary<string, UnitRuntimeLine>(StringComparer.OrdinalIgnoreCase);
        var services = unitFilesResult.Succeeded
            ? ParseServiceUnits(unitFilesResult.StandardOutput, runtimeByName)
            : [];

        var statusMessages = new List<string>();
        if (!unitFilesResult.Succeeded)
        {
            statusMessages.Add("Services could not be loaded.");
            logger.LogWarning(
                "Failed to read service unit file list. ExitCode={ExitCode}. StdErr={ErrorOutput}",
                unitFilesResult.ExitCode,
                unitFilesResult.ErrorOutput);
        }

        if (!runtimeResult.Succeeded)
        {
            statusMessages.Add("Live service state is unavailable.");
            logger.LogDebug(
                "Failed to read service runtime state. ExitCode={ExitCode}. StdErr={ErrorOutput}",
                runtimeResult.ExitCode,
                runtimeResult.ErrorOutput);
        }

        return new SystemServicesSnapshot
        {
            Supported = unitFilesResult.Succeeded,
            StatusMessage = statusMessages.Count > 0 ? string.Join(' ', statusMessages) : null,
            ServiceCount = services.Count,
            EnabledServiceCount = services.Count(service => service.IsEnabled),
            RunningServiceCount = services.Count(service => service.IsRunning),
            Services = services
        };
    }

    public async Task<SystemPackagesSnapshot> GetPackagesAsync(CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new SystemPackagesSnapshot
            {
                Supported = false,
                StatusMessage = "Package browsing is available on Linux hosts."
            };
        }

        var packagesResult = await RunProcessAsync("apt", ["list", "--installed"], cancellationToken);
        var packages = packagesResult.Succeeded
            ? ParseInstalledPackages(packagesResult.StandardOutput)
            : [];

        if (!packagesResult.Succeeded)
        {
            logger.LogWarning(
                "Failed to read installed package list. ExitCode={ExitCode}. StdErr={ErrorOutput}",
                packagesResult.ExitCode,
                packagesResult.ErrorOutput);
        }

        return new SystemPackagesSnapshot
        {
            Supported = packagesResult.Succeeded,
            StatusMessage = packagesResult.Succeeded ? null : "Installed packages could not be loaded.",
            PackageCount = packages.Count,
            AutomaticPackageCount = packages.Count(package => package.IsAutomatic),
            Packages = packages
        };
    }

    public async Task<SystemServiceInsight> GetInsightAsync(string? kind, string? id, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return UnsupportedInsight(kind, id, "Package and service browsing is available on Linux hosts.");
        }

        if (string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(id))
        {
            return UnsupportedInsight(kind, id, "A package or service selection is required.");
        }

        return kind.Trim().ToLowerInvariant() switch
        {
            "package" => await GetPackageInsightAsync(id.Trim(), cancellationToken),
            "service" => await GetServiceInsightAsync(id.Trim(), cancellationToken),
            _ => UnsupportedInsight(kind, id, "Unknown insight type.")
        };
    }

    public async Task<ServiceCommandResponse> StopServiceAsync(string? serviceName, CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux())
        {
            return new ServiceCommandResponse
            {
                Success = false,
                Message = "Service control is available on Linux hosts."
            };
        }

        if (string.IsNullOrWhiteSpace(serviceName))
        {
            return new ServiceCommandResponse
            {
                Success = false,
                Message = "A service selection is required."
            };
        }

        var normalizedServiceName = serviceName.Trim();
        var stopResult = await RunProcessAsync("systemctl", ["stop", normalizedServiceName], cancellationToken);
        var snapshot = await TryGetServiceSnapshotAsync(normalizedServiceName, cancellationToken);

        if (!stopResult.Succeeded)
        {
            logger.LogWarning(
                "Failed to stop the requested service. ExitCode={ExitCode}.",
                stopResult.ExitCode);

            return new ServiceCommandResponse
            {
                Success = false,
                Message = BuildCommandFailureMessage(stopResult, $"Service '{normalizedServiceName}' could not be stopped."),
                Service = snapshot
            };
        }

        if (snapshot?.IsRunning == true)
        {
            return new ServiceCommandResponse
            {
                Success = false,
                Message = $"Service '{normalizedServiceName}' is still running.",
                Service = snapshot
            };
        }

        return new ServiceCommandResponse
        {
            Success = true,
            Message = $"Service '{normalizedServiceName}' was stopped.",
            Service = snapshot
        };
    }

    internal static InstalledPackageSummary? ParseInstalledPackageLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line)
            || line.StartsWith("Listing...", StringComparison.OrdinalIgnoreCase)
            || line.StartsWith("WARNING:", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var statusStart = line.LastIndexOf('[');
        var statusEnd = line.LastIndexOf(']');
        if (statusStart < 0 || statusEnd <= statusStart)
        {
            return null;
        }

        var beforeStatus = line[..statusStart].Trim();
        var statusText = line[(statusStart + 1)..statusEnd].Trim();
        var parts = beforeStatus.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3)
        {
            return null;
        }

        var packageToken = parts[0];
        var slashIndex = packageToken.IndexOf('/');
        if (slashIndex <= 0)
        {
            return null;
        }

        var statusFlags = statusText
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

        return new InstalledPackageSummary
        {
            Name = packageToken[..slashIndex],
            Channel = packageToken[(slashIndex + 1)..],
            Version = parts[1],
            Architecture = parts[2],
            Status = statusText,
            IsAutomatic = statusFlags.Any(flag => string.Equals(flag, "automatic", StringComparison.OrdinalIgnoreCase))
        };
    }

    internal static UnitFileLine? ParseUnitFileLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            return null;
        }

        return new UnitFileLine(
            parts[0].Trim(),
            parts[1].Trim(),
            parts.Length >= 3 ? parts[2].Trim() : null);
    }

    internal static UnitRuntimeLine? ParseUnitRuntimeLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        var parts = line.Split(' ', 5, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 4)
        {
            return null;
        }

        return new UnitRuntimeLine(
            parts[0].Trim(),
            parts[1].Trim(),
            parts[2].Trim(),
            parts[3].Trim(),
            parts.Length >= 5 ? parts[4].Trim() : null);
    }

    internal static Dictionary<string, string> ParseControlFields(string output)
    {
        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? currentKey = null;
        var currentValue = new StringBuilder();

        foreach (var rawLine in output.Replace("\r", string.Empty, StringComparison.Ordinal).Split('\n'))
        {
            if (string.IsNullOrWhiteSpace(rawLine))
            {
                continue;
            }

            if (char.IsWhiteSpace(rawLine[0]) && currentKey is not null)
            {
                if (currentValue.Length > 0)
                {
                    currentValue.Append('\n');
                }

                currentValue.Append(rawLine.TrimStart());
                fields[currentKey] = currentValue.ToString();
                continue;
            }

            var separatorIndex = rawLine.IndexOf(':');
            if (separatorIndex <= 0)
            {
                continue;
            }

            currentKey = rawLine[..separatorIndex].Trim();
            currentValue.Clear();
            currentValue.Append(rawLine[(separatorIndex + 1)..].Trim());
            fields[currentKey] = currentValue.ToString();
        }

        return fields;
    }

    internal static string? ParseDpkgOwner(string output)
    {
        var firstLine = output
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
        if (string.IsNullOrWhiteSpace(firstLine))
        {
            return null;
        }

        var colonIndex = firstLine.IndexOf(':');
        if (colonIndex <= 0)
        {
            return null;
        }

        var packageSegment = firstLine[..colonIndex].Trim();
        return packageSegment
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault();
    }

    private static SystemServiceInsight UnsupportedInsight(string? kind, string? id, string message)
    {
        return new SystemServiceInsight
        {
            Supported = false,
            StatusMessage = message,
            Kind = kind?.Trim() ?? string.Empty,
            Id = id?.Trim() ?? string.Empty,
            Title = "Unavailable"
        };
    }

    private async Task<SystemServiceInsight> GetPackageInsightAsync(string packageName, CancellationToken cancellationToken)
    {
        var statusTask = RunProcessAsync("dpkg-query", ["-s", packageName], cancellationToken);
        var filesTask = RunProcessAsync("dpkg-query", ["-L", packageName], cancellationToken);
        await Task.WhenAll(statusTask, filesTask);

        var statusResult = await statusTask;
        if (!statusResult.Succeeded)
        {
            logger.LogWarning(
                "Failed to read requested package details. ExitCode={ExitCode}.",
                statusResult.ExitCode);

            return new SystemServiceInsight
            {
                Supported = false,
                StatusMessage = BuildCommandFailureMessage(statusResult, $"Package '{packageName}' could not be inspected."),
                Kind = "package",
                Id = packageName,
                Title = packageName
            };
        }

        var fields = ParseControlFields(statusResult.StandardOutput);
        var version = fields.GetValueOrDefault("Version");
        var architecture = fields.GetValueOrDefault("Architecture");
        var summary = ExtractSummary(fields.GetValueOrDefault("Description"));
        var narrative = ExtractNarrative(fields.GetValueOrDefault("Description"));
        var installedSizeBytes = TryParseInstalledSizeBytes(fields.GetValueOrDefault("Installed-Size"));
        var dependencyCount = CountDependencyEntries(fields.GetValueOrDefault("Depends"))
            + CountDependencyEntries(fields.GetValueOrDefault("Pre-Depends"));
        var recommendationCount = CountDependencyEntries(fields.GetValueOrDefault("Recommends"));

        var relatedServiceNames = filesTask.Result.Succeeded
            ? ParsePackageServiceFiles(filesTask.Result.StandardOutput)
            : [];
        var relatedServices = new List<SystemServiceInsightRelatedItem>();
        foreach (var serviceName in relatedServiceNames)
        {
            var serviceSnapshot = await TryGetServiceSnapshotAsync(serviceName, cancellationToken);
            relatedServices.Add(new SystemServiceInsightRelatedItem
            {
                Kind = "service",
                Id = serviceName,
                Title = serviceSnapshot?.DisplayName ?? HumanizeUnitName(serviceName),
                Subtitle = BuildServiceSubtitle(serviceSnapshot?.UnitFileState, serviceSnapshot?.ActiveState)
            });
        }

        var highlights = new List<string>();
        if (dependencyCount > 0)
        {
            highlights.Add($"Depends on {dependencyCount} other package{Pluralize(dependencyCount)}.");
        }

        if (recommendationCount > 0)
        {
            highlights.Add($"Suggests {recommendationCount} optional component{Pluralize(recommendationCount)} for a fuller setup.");
        }

        if (relatedServices.Count > 0)
        {
            highlights.Add($"Provides {relatedServices.Count} background service{Pluralize(relatedServices.Count)}.");
        }

        if (installedSizeBytes is > 0)
        {
            highlights.Add($"Uses about {FormatBytes(installedSizeBytes.Value)} on disk.");
        }

        var subtitleParts = new List<string>();
        if (!string.IsNullOrWhiteSpace(version))
        {
            subtitleParts.Add(version);
        }

        if (!string.IsNullOrWhiteSpace(architecture))
        {
            subtitleParts.Add(architecture);
        }

        return new SystemServiceInsight
        {
            Supported = true,
            Kind = "package",
            Id = packageName,
            Title = packageName,
            Subtitle = subtitleParts.Count > 0 ? string.Join(" · ", subtitleParts) : null,
            Summary = summary,
            Narrative = narrative,
            Metrics =
            [
                new() { Label = "Installed size", Value = installedSizeBytes is > 0 ? FormatBytes(installedSizeBytes.Value) : "Unknown" },
                new() { Label = "Dependencies", Value = dependencyCount.ToString(CultureInfo.InvariantCulture) },
                new() { Label = "Services", Value = relatedServices.Count.ToString(CultureInfo.InvariantCulture) }
            ],
            Facts = BuildPackageFacts(fields),
            Highlights = highlights,
            RelatedItems = relatedServices
        };
    }

    private async Task<SystemServiceInsight> GetServiceInsightAsync(string serviceName, CancellationToken cancellationToken)
    {
        var showResult = await RunProcessAsync(
            "systemctl",
            [
                "show",
                serviceName,
                "--no-pager",
                "--property=Id",
                "--property=Description",
                "--property=LoadState",
                "--property=ActiveState",
                "--property=SubState",
                "--property=UnitFileState",
                "--property=UnitFilePreset",
                "--property=FragmentPath",
                "--property=MainPID",
                "--property=ExecMainStartTimestamp",
                "--property=ActiveEnterTimestamp",
                "--property=StateChangeTimestamp",
                "--property=User",
                "--property=Group"
            ],
            cancellationToken);

        if (!showResult.Succeeded)
        {
            logger.LogWarning(
                "Failed to read requested service details. ExitCode={ExitCode}.",
                showResult.ExitCode);

            return new SystemServiceInsight
            {
                Supported = false,
                StatusMessage = BuildCommandFailureMessage(showResult, $"Service '{serviceName}' could not be inspected."),
                Kind = "service",
                Id = serviceName,
                Title = HumanizeUnitName(serviceName)
            };
        }

        var fields = ParseShowProperties(showResult.StandardOutput);
        var title = fields.GetValueOrDefault("Description");
        var fragmentPath = NormalizeEmpty(fields.GetValueOrDefault("FragmentPath"));
        var unitFileState = NormalizeEmpty(fields.GetValueOrDefault("UnitFileState"));
        var activeState = NormalizeEmpty(fields.GetValueOrDefault("ActiveState"));
        var ownerPackage = await TryResolvePackageOwnerAsync(fragmentPath, cancellationToken);
        var relatedItems = new List<SystemServiceInsightRelatedItem>();
        string? ownerPackageSummary = null;
        string? ownerPackageVersion = null;

        if (!string.IsNullOrWhiteSpace(ownerPackage))
        {
            var packageStatus = await RunProcessAsync("dpkg-query", ["-s", ownerPackage], cancellationToken);
            if (packageStatus.Succeeded)
            {
                var packageFields = ParseControlFields(packageStatus.StandardOutput);
                ownerPackageSummary = ExtractSummary(packageFields.GetValueOrDefault("Description"));
                ownerPackageVersion = NormalizeEmpty(packageFields.GetValueOrDefault("Version"));
            }

            relatedItems.Add(new SystemServiceInsightRelatedItem
            {
                Kind = "package",
                Id = ownerPackage,
                Title = ownerPackage,
                Subtitle = string.Join(
                    " · ",
                    new[] { ownerPackageVersion, ownerPackageSummary }
                        .Where(value => !string.IsNullOrWhiteSpace(value)))
            });
        }

        var highlights = new List<string>();
        if (!string.IsNullOrWhiteSpace(activeState))
        {
            highlights.Add(string.Equals(activeState, "active", StringComparison.OrdinalIgnoreCase)
                ? "Running right now."
                : $"Currently {HumanizeState(activeState)}.");
        }

        if (!string.IsNullOrWhiteSpace(unitFileState))
        {
            highlights.Add($"{HumanizeStartupMode(unitFileState)} startup mode.");
        }

        if (!string.IsNullOrWhiteSpace(ownerPackage))
        {
            highlights.Add($"Installed as part of the {ownerPackage} package.");
        }
        else if (!string.IsNullOrWhiteSpace(fragmentPath))
        {
            highlights.Add("Looks like a local or custom service definition.");
        }

        var subtitle = string.Join(
            " · ",
            new[] { serviceName, HumanizeState(activeState) }
                .Where(value => !string.IsNullOrWhiteSpace(value)));

        return new SystemServiceInsight
        {
            Supported = true,
            Kind = "service",
            Id = serviceName,
            Title = string.IsNullOrWhiteSpace(title) ? HumanizeUnitName(serviceName) : title!,
            Subtitle = subtitle,
            Summary = NormalizeEmpty(fields.GetValueOrDefault("Description")),
            Narrative = ownerPackageSummary,
            Metrics =
            [
                new() { Label = "Current state", Value = HumanizeState(activeState) ?? "Unknown" },
                new() { Label = "Startup", Value = HumanizeStartupMode(unitFileState) },
                new() { Label = "Package", Value = ownerPackage ?? "Custom" }
            ],
            Facts = BuildServiceFacts(fields, ownerPackage),
            Highlights = highlights,
            RelatedItems = relatedItems
        };
    }

    private async Task<ServiceUnitSummary?> TryGetServiceSnapshotAsync(string serviceName, CancellationToken cancellationToken)
    {
        var unitFilesResult = await RunProcessAsync(
            "systemctl",
            ["list-unit-files", serviceName, "--type=service", "--no-legend", "--no-pager", "--plain"],
            cancellationToken);

        if (!unitFilesResult.Succeeded)
        {
            return null;
        }

        var unitFile = unitFilesResult.StandardOutput
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(ParseUnitFileLine)
            .FirstOrDefault(line => line is not null);
        if (unitFile is null)
        {
            return null;
        }

        var runtimeResult = await RunProcessAsync(
            "systemctl",
            ["list-units", serviceName, "--type=service", "--all", "--no-legend", "--no-pager", "--plain"],
            cancellationToken);

        var runtime = runtimeResult.Succeeded
            ? runtimeResult.StandardOutput
                .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
                .Select(ParseUnitRuntimeLine)
                .FirstOrDefault(line => line is not null)
            : null;

        return new ServiceUnitSummary
        {
            Name = unitFile.Name,
            DisplayName = !string.IsNullOrWhiteSpace(runtime?.Description)
                ? runtime.Description!
                : HumanizeUnitName(unitFile.Name),
            Description = runtime?.Description,
            UnitFileState = unitFile.State,
            VendorPreset = unitFile.Preset,
            ActiveState = runtime?.ActiveState,
            SubState = runtime?.SubState,
            IsEnabled = IsEnabledState(unitFile.State),
            IsRunning = IsRunningState(runtime?.ActiveState)
        };
    }

    private async Task<string?> TryResolvePackageOwnerAsync(string? fragmentPath, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(fragmentPath))
        {
            return null;
        }

        var ownerResult = await RunProcessAsync("dpkg-query", ["-S", fragmentPath], cancellationToken);
        return ownerResult.Succeeded ? ParseDpkgOwner(ownerResult.StandardOutput) : null;
    }

    private static List<InstalledPackageSummary> ParseInstalledPackages(string output)
    {
        return output
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(ParseInstalledPackageLine)
            .Where(package => package is not null)
            .Cast<InstalledPackageSummary>()
            .OrderBy(package => package.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static List<ServiceUnitSummary> ParseServiceUnits(
        string unitFilesOutput,
        IReadOnlyDictionary<string, UnitRuntimeLine> runtimeByName)
    {
        return unitFilesOutput
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(ParseUnitFileLine)
            .Where(unit => unit is not null && unit.Name.EndsWith(".service", StringComparison.OrdinalIgnoreCase))
            .Select(unit =>
            {
                var runtime = runtimeByName.GetValueOrDefault(unit!.Name);
                return new ServiceUnitSummary
                {
                    Name = unit.Name,
                    DisplayName = !string.IsNullOrWhiteSpace(runtime?.Description)
                        ? runtime.Description!
                        : HumanizeUnitName(unit.Name),
                    Description = runtime?.Description,
                    UnitFileState = unit.State,
                    VendorPreset = unit.Preset,
                    ActiveState = runtime?.ActiveState,
                    SubState = runtime?.SubState,
                    IsEnabled = IsEnabledState(unit.State),
                    IsRunning = IsRunningState(runtime?.ActiveState)
                };
            })
            .OrderByDescending(service => service.IsRunning)
            .ThenByDescending(service => service.IsEnabled)
            .ThenBy(service => service.DisplayName, StringComparer.OrdinalIgnoreCase)
            .ThenBy(service => service.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static IEnumerable<UnitRuntimeLine> ParseUnitRuntimeLines(string output)
    {
        return output
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(ParseUnitRuntimeLine)
            .Where(runtime => runtime is not null)
            .Cast<UnitRuntimeLine>();
    }

    private static Dictionary<string, string> ParseShowProperties(string output)
    {
        return output
            .Replace("\r", string.Empty, StringComparison.Ordinal)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line =>
            {
                var separatorIndex = line.IndexOf('=');
                return separatorIndex > 0
                    ? new KeyValuePair<string, string>(line[..separatorIndex], line[(separatorIndex + 1)..])
                    : default;
            })
            .Where(pair => !string.IsNullOrWhiteSpace(pair.Key))
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.OrdinalIgnoreCase);
    }

    private static List<SystemServiceInsightFact> BuildPackageFacts(IReadOnlyDictionary<string, string> fields)
    {
        return BuildFacts(
            ("Version", NormalizeEmpty(fields.GetValueOrDefault("Version"))),
            ("Architecture", NormalizeEmpty(fields.GetValueOrDefault("Architecture"))),
            ("Section", NormalizeEmpty(fields.GetValueOrDefault("Section"))),
            ("Priority", NormalizeEmpty(fields.GetValueOrDefault("Priority"))),
            ("Maintainer", NormalizeEmpty(fields.GetValueOrDefault("Maintainer"))),
            ("Homepage", NormalizeEmpty(fields.GetValueOrDefault("Homepage"))),
            ("Status", NormalizeEmpty(fields.GetValueOrDefault("Status"))));
    }

    private static List<SystemServiceInsightFact> BuildServiceFacts(
        IReadOnlyDictionary<string, string> fields,
        string? ownerPackage)
    {
        return BuildFacts(
            ("Service name", NormalizeEmpty(fields.GetValueOrDefault("Id"))),
            ("Package owner", ownerPackage),
            ("Service file", NormalizeEmpty(fields.GetValueOrDefault("FragmentPath"))),
            ("Load state", NormalizeEmpty(fields.GetValueOrDefault("LoadState"))),
            ("Current state", JoinValues(HumanizeState(fields.GetValueOrDefault("ActiveState")), HumanizeState(fields.GetValueOrDefault("SubState")))),
            ("Startup mode", HumanizeStartupMode(fields.GetValueOrDefault("UnitFileState"))),
            ("Preset", HumanizeStartupMode(fields.GetValueOrDefault("UnitFilePreset"))),
            ("Started", NormalizeTimestamp(fields.GetValueOrDefault("ActiveEnterTimestamp")) ?? NormalizeTimestamp(fields.GetValueOrDefault("ExecMainStartTimestamp"))),
            ("Runs as", JoinValues(NormalizeEmpty(fields.GetValueOrDefault("User")), NormalizeEmpty(fields.GetValueOrDefault("Group")), separator: " / ")),
            ("Main process", NormalizeNumeric(fields.GetValueOrDefault("MainPID"))));
    }

    private static List<SystemServiceInsightFact> BuildFacts(params (string Label, string? Value)[] pairs)
    {
        return pairs
            .Where(pair => !string.IsNullOrWhiteSpace(pair.Value))
            .Select(pair => new SystemServiceInsightFact
            {
                Label = pair.Label,
                Value = pair.Value!
            })
            .ToList();
    }

    private static string? ExtractSummary(string? description)
    {
        if (string.IsNullOrWhiteSpace(description))
        {
            return null;
        }

        return description
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(line => line == "." ? string.Empty : line)
            .FirstOrDefault(line => !string.IsNullOrWhiteSpace(line));
    }

    private static string? ExtractNarrative(string? description)
    {
        if (string.IsNullOrWhiteSpace(description))
        {
            return null;
        }

        var lines = description
            .Split('\n', StringSplitOptions.TrimEntries)
            .Select(line => line == "." ? string.Empty : line)
            .ToArray();
        if (lines.Length <= 1)
        {
            return null;
        }

        var narrative = string.Join(' ', lines.Skip(1).Where(line => !string.IsNullOrWhiteSpace(line))).Trim();
        return string.IsNullOrWhiteSpace(narrative) ? null : narrative;
    }

    private static long? TryParseInstalledSizeBytes(string? installedSizeKilobytes)
    {
        return long.TryParse(installedSizeKilobytes, NumberStyles.Integer, CultureInfo.InvariantCulture, out var kilobytes)
            ? kilobytes * 1024
            : null;
    }

    private static int CountDependencyEntries(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return 0;
        }

        return value
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Length;
    }

    private static List<string> ParsePackageServiceFiles(string output)
    {
        return output
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Where(path =>
                path.EndsWith(".service", StringComparison.OrdinalIgnoreCase)
                && path.Contains("/systemd/system/", StringComparison.OrdinalIgnoreCase))
            .Select(Path.GetFileName)
            .Where(fileName => !string.IsNullOrWhiteSpace(fileName))
            .Select(fileName => fileName!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(fileName => fileName, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string BuildServiceSubtitle(string? unitFileState, string? activeState)
    {
        var subtitle = string.Join(
            " · ",
            new[] { HumanizeStartupMode(unitFileState), HumanizeState(activeState) }
                .Where(value => !string.IsNullOrWhiteSpace(value)));

        return string.IsNullOrWhiteSpace(subtitle) ? "Service" : subtitle;
    }

    private static string? NormalizeEmpty(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        return string.Equals(trimmed, "[not set]", StringComparison.OrdinalIgnoreCase)
            || string.Equals(trimmed, "0", StringComparison.OrdinalIgnoreCase)
            ? null
            : trimmed;
    }

    private static string? NormalizeTimestamp(string? value)
    {
        var normalized = NormalizeEmpty(value);
        return string.Equals(normalized, "n/a", StringComparison.OrdinalIgnoreCase) ? null : normalized;
    }

    private static string? NormalizeNumeric(string? value)
    {
        if (!int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) || number <= 0)
        {
            return null;
        }

        return number.ToString(CultureInfo.InvariantCulture);
    }

    private static string? JoinValues(string? first, string? second, string separator = " · ")
    {
        return string.Join(separator, new[] { first, second }.Where(value => !string.IsNullOrWhiteSpace(value)));
    }

    private static string HumanizeUnitName(string unitName)
    {
        var name = unitName.EndsWith(".service", StringComparison.OrdinalIgnoreCase)
            ? unitName[..^8]
            : unitName;
        name = name.Replace('-', ' ').Replace('_', ' ');
        return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(name);
    }

    private static bool IsEnabledState(string? unitFileState)
    {
        return unitFileState?.StartsWith("enabled", StringComparison.OrdinalIgnoreCase) == true;
    }

    private static bool IsRunningState(string? activeState)
    {
        return string.Equals(activeState, "active", StringComparison.OrdinalIgnoreCase);
    }

    private static string HumanizeStartupMode(string? unitFileState)
    {
        return unitFileState?.ToLowerInvariant() switch
        {
            "enabled" or "enabled-runtime" => "Starts automatically",
            "static" => "Started by another app",
            "disabled" => "Starts manually",
            "masked" => "Blocked",
            "generated" => "Generated at runtime",
            null or "" => "Unknown",
            _ => CultureInfo.InvariantCulture.TextInfo.ToTitleCase(unitFileState.Replace('-', ' '))
        };
    }

    private static string? HumanizeState(string? state)
    {
        if (string.IsNullOrWhiteSpace(state))
        {
            return null;
        }

        return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(state.Replace('-', ' '));
    }

    private static string Pluralize(int count) => count == 1 ? string.Empty : "s";

    private static string BuildCommandFailureMessage(ProcessResult result, string fallbackMessage)
    {
        if (!string.IsNullOrWhiteSpace(result.ErrorOutput))
        {
            return result.ErrorOutput.Trim();
        }

        if (!string.IsNullOrWhiteSpace(result.StandardOutput))
        {
            return result.StandardOutput.Trim();
        }

        return fallbackMessage;
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var unitIndex = 0;
        double value = bytes;

        while (value >= 1024 && unitIndex < units.Length - 1)
        {
            value /= 1024;
            unitIndex += 1;
        }

        var decimals = value >= 100 || unitIndex == 0 ? 0 : 1;
        return $"{value.ToString($"F{decimals}", CultureInfo.InvariantCulture)} {units[unitIndex]}";
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        using var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        foreach (var argument in arguments)
        {
            process.StartInfo.ArgumentList.Add(argument);
        }

        try
        {
            process.Start();
        }
        catch (Exception exception)
        {
            return new ProcessResult(false, string.Empty, exception.Message, null);
        }

        try
        {
            var standardOutputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var standardErrorTask = process.StandardError.ReadToEndAsync(cancellationToken);

            await process.WaitForExitAsync(cancellationToken);

            return new ProcessResult(
                process.ExitCode == 0,
                await standardOutputTask,
                await standardErrorTask,
                process.ExitCode);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Best effort.
            }

            throw;
        }
    }

    internal sealed record UnitFileLine(string Name, string State, string? Preset);

    internal sealed record UnitRuntimeLine(string Name, string LoadState, string ActiveState, string SubState, string? Description);

    private sealed record ProcessResult(bool Succeeded, string StandardOutput, string ErrorOutput, int? ExitCode);
}
