using System.Collections.Concurrent;
using System.Text.Json;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Loads and caches device definition JSON files from an optional local directory
/// and from the canonical GitHub repository.
/// </summary>
public sealed class DeviceDefinitionLoader
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true
    };

    // Hardwired source of the catalog definitions browsed from GitHub.
    private const string GitHubRepository = "BieleckiLtd/JkMonitorV2";
    private const string GitHubBranch = "dev";
    private const string GitHubDevicesFolder = "devices";
    private const string GitHubDevicesManifest = "index.json";

    private readonly ConcurrentDictionary<string, DeviceDefinition> _definitions = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _definitionsPath;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<DeviceDefinitionLoader> _logger;
    private readonly SemaphoreSlim _remoteLoadLock = new(1, 1);
    private volatile bool _remoteDefinitionsLoaded;

    public DeviceDefinitionLoader(
        string definitionsPath,
        string contentRootPath,
        IHttpClientFactory httpClientFactory,
        ILogger<DeviceDefinitionLoader> logger)
    {
        _definitionsPath = ResolveDefinitionsPath(definitionsPath, contentRootPath);
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    internal static string ResolveDefinitionsPath(string? definitionsPath, string? contentRootPath)
        => ResolveConfiguredPath(definitionsPath, contentRootPath);

    internal static string ResolveConfiguredPath(string? definitionsPath, string? contentRootPath)
    {
        var configuredPath = string.IsNullOrWhiteSpace(definitionsPath) ? "devices" : definitionsPath;
        var basePath = string.IsNullOrWhiteSpace(contentRootPath) ? AppContext.BaseDirectory : contentRootPath;

        return Path.IsPathRooted(configuredPath)
            ? Path.GetFullPath(configuredPath)
            : Path.GetFullPath(Path.Combine(basePath, configuredPath));
    }

    /// <summary>
    /// Load all device definitions from the optional local definitions directory.
    /// Call once at startup; definitions are cached in memory.
    /// </summary>
    public void LoadAll()
    {
        if (!Directory.Exists(_definitionsPath))
        {
            _logger.LogInformation(
                "No local device definitions directory found at {Path}. Continuing without local definition files.",
                _definitionsPath);
            return;
        }

        var files = Directory.GetFiles(_definitionsPath, "*.json");
        _logger.LogInformation("Loading device definitions from {Path} ({Count} files).", _definitionsPath, files.Length);

        foreach (var file in files)
        {
            if (string.Equals(Path.GetFileName(file), GitHubDevicesManifest, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            try
            {
                var json = File.ReadAllText(file);
                var definition = JsonSerializer.Deserialize<DeviceDefinition>(json, JsonOptions);
                if (definition is null)
                {
                    _logger.LogWarning("Skipping empty device definition: {File}", file);
                    continue;
                }

                _definitions[definition.Device.Id] = definition;
                _logger.LogInformation("Loaded device definition '{Id}' ({Name}) from {File}.",
                    definition.Device.Id, definition.Device.Name, Path.GetFileName(file));
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to load device definition from {File}.", file);
            }
        }
    }

    /// <summary>
    /// Ensure catalog device definitions are loaded from the canonical GitHub repository once per process.
    /// Subsequent calls are a no-op after the first successful load.
    /// </summary>
    public async Task EnsureRemoteDefinitionsLoadedAsync(CancellationToken cancellationToken = default)
    {
        if (_remoteDefinitionsLoaded)
        {
            return;
        }

        await _remoteLoadLock.WaitAsync(cancellationToken);
        try
        {
            if (_remoteDefinitionsLoaded)
            {
                return;
            }

            _remoteDefinitionsLoaded = await LoadFromGitHubAsync(cancellationToken);
        }
        finally
        {
            _remoteLoadLock.Release();
        }
    }

    /// <summary>
    /// Fetch catalog device definitions from the canonical GitHub repository.
    /// Uses a manifest stored on raw.githubusercontent.com so startup does not
    /// depend on the GitHub REST API rate limit.
    /// Already-loaded definitions (e.g. user-provided local files or in-memory uploads) are not overwritten.
    /// </summary>
    public async Task<bool> LoadFromGitHubAsync(CancellationToken cancellationToken = default)
    {
        var manifestUrl = $"https://raw.githubusercontent.com/{GitHubRepository}/{GitHubBranch}/{GitHubDevicesFolder}/{GitHubDevicesManifest}";
        _logger.LogInformation("Fetching device definitions catalog from GitHub.");

        try
        {
            using var client = _httpClientFactory.CreateClient();
            client.Timeout = TimeSpan.FromSeconds(10);
            client.DefaultRequestHeaders.Add("User-Agent", "FluxMonitor-DeviceDefinitionLoader");

            var manifest = await client.GetFromJsonAsync<DeviceDefinitionManifest>(manifestUrl, JsonOptions, cancellationToken);
            if (manifest?.Files is null || manifest.Files.Count == 0)
            {
                _logger.LogWarning("GitHub device definition manifest returned no files.");
                return false;
            }

            foreach (var fileName in manifest.Files
                .Where(fileName => fileName.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                .Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var relativePath = $"{GitHubDevicesFolder}/{fileName}";
                var rawUrl = $"https://raw.githubusercontent.com/{GitHubRepository}/{GitHubBranch}/{relativePath}";

                try
                {
                    var json = await client.GetStringAsync(rawUrl, cancellationToken);
                    var definition = JsonSerializer.Deserialize<DeviceDefinition>(json, JsonOptions);
                    if (definition is null)
                    {
                        _logger.LogWarning("Skipping empty GitHub definition: {File}.", fileName);
                        continue;
                    }

                    // Local user-uploaded definitions take precedence.
                    if (_definitions.ContainsKey(definition.Device.Id))
                    {
                        _logger.LogDebug("GitHub definition '{Id}' already loaded locally; skipping.", definition.Device.Id);
                        continue;
                    }

                    _definitions[definition.Device.Id] = definition;
                    _logger.LogInformation("Loaded device definition '{Id}' ({Name}) from GitHub.", definition.Device.Id, definition.Device.Name);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "Failed to load GitHub definition {File}.", fileName);
                }
            }

            return true;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch device definitions from GitHub.");
            return false;
        }
    }

    private sealed class DeviceDefinitionManifest
    {
        public List<string> Files { get; init; } = [];
    }

    /// <summary>
    /// Try to get a device definition by ID.
    /// </summary>
    public bool TryGet(string definitionId, out DeviceDefinition? definition)
        => _definitions.TryGetValue(definitionId, out definition);

    /// <summary>
    /// Get a device definition by ID. Throws if not found.
    /// </summary>
    public DeviceDefinition Get(string definitionId)
    {
        if (_definitions.TryGetValue(definitionId, out var definition))
            return definition;

        throw new InvalidOperationException($"Device definition '{definitionId}' not found. Available: {string.Join(", ", _definitions.Keys)}");
    }

    /// <summary>
    /// Get all loaded device definitions.
    /// </summary>
    public IReadOnlyDictionary<string, DeviceDefinition> GetAll()
        => _definitions;

    /// <summary>
    /// Load a device definition JSON into the in-memory catalog.
    /// This does not write to disk; configured device snapshots are persisted in the database.
    /// </summary>
    public DeviceDefinition LoadFromJson(string json)
    {
        var definition = JsonSerializer.Deserialize<DeviceDefinition>(json, JsonOptions)
            ?? throw new InvalidOperationException("Invalid device definition JSON.");

        if (string.IsNullOrWhiteSpace(definition.Device.Id))
            throw new InvalidOperationException("Device definition must have a device.id.");

        _definitions[definition.Device.Id] = definition;
        _logger.LogInformation("Loaded device definition '{Id}' into the in-memory catalog.", definition.Device.Id);

        return definition;
    }
}
