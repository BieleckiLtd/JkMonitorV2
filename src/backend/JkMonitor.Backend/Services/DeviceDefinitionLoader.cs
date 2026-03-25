using System.Collections.Concurrent;
using System.Text.Json;
using JkMonitor.Contracts.DeviceDefinition;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Loads and caches device definition JSON files from the configured directory.
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

    private readonly ConcurrentDictionary<string, DeviceDefinition> _definitions = new(StringComparer.OrdinalIgnoreCase);
    private readonly string _definitionsPath;
    private readonly ILogger<DeviceDefinitionLoader> _logger;

    public DeviceDefinitionLoader(string definitionsPath, ILogger<DeviceDefinitionLoader> logger)
    {
        _definitionsPath = Path.GetFullPath(definitionsPath);
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
}
