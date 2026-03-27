using System.Collections.Concurrent;
using System.Text.Json;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Loads and caches device definition JSON files from the configured directory
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

    // Hardwired source of built-in device definitions.
    private const string GitHubRepository = "BieleckiLtd/JkMonitorV2";
    private const string GitHubBranch = "dev";
    private const string GitHubDevicesFolder = "devices";
    private const string GitHubDevicesManifest = "index.json";

    private readonly ConcurrentDictionary<string, DeviceDefinition> _definitions = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _definitionsPath;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<DeviceDefinitionLoader> _logger;

    public DeviceDefinitionLoader(string definitionsPath, IHttpClientFactory httpClientFactory, ILogger<DeviceDefinitionLoader> logger)
    {
        _definitionsPath = Path.GetFullPath(definitionsPath);
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// Load all device definitions from the definitions directory.
    /// Call once at startup; definitions are cached in memory.
    /// </summary>
    public void LoadAll()
    {
        if (!Directory.Exists(_definitionsPath))
        {
            _logger.LogWarning("Device definitions directory does not exist: {Path}", _definitionsPath);
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
    /// Fetch built-in device definitions from the canonical GitHub repository.
    /// Uses a manifest stored on raw.githubusercontent.com so startup does not
    /// depend on the GitHub REST API rate limit.
    /// Already-loaded definitions (e.g. user-uploaded local files) are not overwritten.
    /// </summary>
    public async Task LoadFromGitHubAsync(CancellationToken cancellationToken = default)
    {
        var manifestUrl = $"https://raw.githubusercontent.com/{GitHubRepository}/{GitHubBranch}/{GitHubDevicesFolder}/{GitHubDevicesManifest}";
        _logger.LogInformation("Fetching built-in device definitions list from GitHub.");

        try
        {
            using var client = _httpClientFactory.CreateClient();
            client.DefaultRequestHeaders.Add("User-Agent", "FluxMonitor-DeviceDefinitionLoader");

            var manifest = await client.GetFromJsonAsync<DeviceDefinitionManifest>(manifestUrl, JsonOptions, cancellationToken);
            if (manifest?.Files is null || manifest.Files.Count == 0)
            {
                _logger.LogWarning("GitHub device definition manifest returned no files.");
                return;
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
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch device definitions from GitHub.");
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
    /// Save a device definition JSON to the definitions directory and load it into the cache.
    /// </summary>
    public DeviceDefinition SaveAndLoad(string json)
    {
        var definition = JsonSerializer.Deserialize<DeviceDefinition>(json, JsonOptions)
            ?? throw new InvalidOperationException("Invalid device definition JSON.");

        if (string.IsNullOrWhiteSpace(definition.Device.Id))
            throw new InvalidOperationException("Device definition must have a device.id.");

        var fileName = $"{definition.Device.Id}.json";
        if (fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new InvalidOperationException("Device definition id contains invalid file name characters.");

        if (!Directory.Exists(_definitionsPath))
            Directory.CreateDirectory(_definitionsPath);

        var path = Path.Combine(_definitionsPath, fileName);
        File.WriteAllText(path, json);

        _definitions[definition.Device.Id] = definition;
        _logger.LogInformation("Saved and loaded device definition '{Id}' to {File}.", definition.Device.Id, fileName);

        return definition;
    }
}
