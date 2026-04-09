using System.IO.Ports;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Win32;

namespace FluxMonitor.Backend.Services;

public sealed class SetupConfigurationService(
    IHostEnvironment environment,
    IConfiguration appConfiguration,
    LocalDependencyInstallerService localDependencyInstallerService,
    ManagedRestartService managedRestartService,
    ILogger<SetupConfigurationService> logger)
{
    private const string ManagedAspNetCoreUrls = "http://[::]:5074";
    private static readonly int[] SupportedTemporaryHistoryMinutes = [1, 5, 10, 30];
    private static readonly int[] SupportedPersistedBucketMinutes = [1, 5, 10, 30];
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    private readonly string _contentRoot = environment.ContentRootPath;
    private readonly bool _storageConfiguredAtStartup = IsStorageConfigured(appConfiguration);

    public SetupStateResponse GetState()
    {
        var configuration = GetMonitorConfiguration();

        return new SetupStateResponse
        {
            CurrentStartupMode = "Hardware",
            EnvironmentName = environment.EnvironmentName,
            SetupRequired = !_storageConfiguredAtStartup,
            UseDatabase = _storageConfiguredAtStartup,
            ConnectionString = configuration.Storage.ConnectionString,
            SerialPort = null,
            SerialPorts = GetSerialPorts(),
            CanAutoRestart = managedRestartService.CanAutoRestart,
            ApplyMessage = managedRestartService.GetApplyMessage()
        };
    }

    public LocalDependenciesStateResponse GetLocalDependenciesState()
    {
        return localDependencyInstallerService.GetState();
    }

    public InstallLocalDependenciesResponse InstallLocalDependencies()
    {
        return localDependencyInstallerService.Install();
    }

    public RestartApplicationResponse Restart()
    {
        if (!managedRestartService.CanAutoRestart)
        {
            return new RestartApplicationResponse
            {
                RestartScheduled = false,
                Message = "Flux Monitor saved the local dependency setup. Restart the app to finish applying it."
            };
        }

        managedRestartService.ScheduleRestart();

        return new RestartApplicationResponse
        {
            RestartScheduled = true,
            Message = "Flux Monitor is restarting to finish applying the local dependency setup."
        };
    }

    public DatabaseSettingsStateResponse GetDatabaseSettings()
    {
        var configuration = GetMonitorConfiguration();

        return BuildDatabaseSettingsStateResponse(configuration);
    }

    public ApplySetupResponse Apply(ApplySetupRequest request)
    {
        var startupMode = NormalizeStartupMode(request.StartupMode);
        var connectionString = (request.ConnectionString ?? string.Empty).Trim();

        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("A PostgreSQL connection string is required. Flux Monitor does not support detached storage.");
        }

        if (startupMode == "Hardware" && string.IsNullOrWhiteSpace(request.SerialPort))
        {
            throw new InvalidOperationException("A serial port is required for hardware mode.");
        }

        if (startupMode == "Simulator")
        {
            UpdateJson(GetEnvironmentLocalSettingsPath("Development"), monitor =>
            {
                UpsertObject(monitor, "Storage", storage =>
                {
                    storage["Provider"] = "TimescaleDb";
                    storage["ConnectionString"] = connectionString;
                });
            });

            UpdateManagedEnvironmentFile("Development");
        }
        else
        {
            UpdateJson(GetEnvironmentLocalSettingsPath("Production"), monitor =>
            {
                UpsertObject(monitor, "Storage", storage =>
                {
                    storage["Provider"] = "TimescaleDb";
                    storage["ConnectionString"] = connectionString;
                });
            });

            UpdateManagedEnvironmentFile("Production");
        }

        logger.LogInformation("Applied setup from the browser using {StartupMode} mode.", startupMode);

        var restartScheduled = request.RestartApplication && managedRestartService.CanAutoRestart;
        if (restartScheduled)
        {
            managedRestartService.ScheduleRestart();
        }

        return new ApplySetupResponse
        {
            StartupMode = startupMode,
            RestartScheduled = restartScheduled,
            Message = restartScheduled
                ? $"Flux Monitor saved your {startupMode.ToLowerInvariant()} configuration and is restarting now."
                : $"Flux Monitor saved your {startupMode.ToLowerInvariant()} configuration. Restart the app to apply it."
        };
    }

    public SaveDatabaseSettingsResponse SaveDatabaseSettings(SaveDatabaseSettingsRequest request)
    {
        ValidateTemporaryHistoryMinutes(request.RawSecondsWindowMinutes);
        ValidatePersistedBucketMinutes(request.PersistedBucketMinutes);

        var localSettingsPath = GetCurrentEnvironmentLocalSettingsPath();
        UpdateJson(localSettingsPath, monitor =>
        {
            UpsertObject(monitor, "Storage", storage =>
            {
                UpsertObject(storage, "Retention", retention =>
                {
                    retention["RawSecondsWindowMinutes"] = request.RawSecondsWindowMinutes;
                    retention["PersistedBucketMinutes"] = request.PersistedBucketMinutes;
                    retention["FiveMinuteWindowDays"] = 0;
                });

                UpsertObject(storage, "Compression", compression =>
                {
                    compression["CompressAfterMinutes"] = 0;
                });
            });
        });

        var updatedSettings = BuildDatabaseSettingsStateResponse(new MonitorConfiguration
        {
            Storage = new StorageConfiguration
            {
                Provider = GetMonitorConfiguration().Storage.Provider,
                ConnectionString = GetMonitorConfiguration().Storage.ConnectionString,
                Retention = new RetentionConfiguration
                {
                    RawSecondsWindowMinutes = request.RawSecondsWindowMinutes,
                    PersistedBucketMinutes = request.PersistedBucketMinutes,
                    FiveMinuteWindowDays = 0
                },
                Compression = new CompressionConfiguration
                {
                    CompressAfterMinutes = 0
                }
            },
            ApiSecurity = GetMonitorConfiguration().ApiSecurity,
            DeviceDefinitionsPath = GetMonitorConfiguration().DeviceDefinitionsPath
        });

        logger.LogInformation(
            "Saved database settings. RawSecondsWindowMinutes={RawSecondsWindowMinutes}, PersistedBucketMinutes={PersistedBucketMinutes}.",
            request.RawSecondsWindowMinutes,
            request.PersistedBucketMinutes);

        return new SaveDatabaseSettingsResponse
        {
            RestartScheduled = false,
            Message = "Database settings were saved and applied immediately.",
            Settings = updatedSettings
        };
    }

    private IReadOnlyList<string> GetSerialPorts()
    {
        var ports = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            foreach (var port in SerialPort.GetPortNames())
            {
                if (!string.IsNullOrWhiteSpace(port))
                {
                    ports.Add(port);
                }
            }
        }
        catch
        {
        }

        if (OperatingSystem.IsWindows())
        {
            TryAddWindowsRegistryPorts(ports);
        }

        if (OperatingSystem.IsLinux())
        {
            foreach (var pattern in new[] { "ttyUSB*", "ttyACM*", "ttyAMA*", "ttyS*" })
            {
                TryAddPortsFromPattern(ports, "/dev", pattern);
            }

            var byIdPath = "/dev/serial/by-id";
            if (Directory.Exists(byIdPath))
            {
                foreach (var path in Directory.GetFiles(byIdPath))
                {
                    ports.Add(path);
                }
            }
        }

        return ports.OrderBy(port => port, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    [SupportedOSPlatform("windows")]
    private void TryAddWindowsRegistryPorts(HashSet<string> ports)
    {
        try
        {
            using var registryKey = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DEVICEMAP\SERIALCOMM");

            if (registryKey is null)
            {
                return;
            }

            foreach (var valueName in registryKey.GetValueNames())
            {
                if (registryKey.GetValue(valueName) is string portName && !string.IsNullOrWhiteSpace(portName))
                {
                    ports.Add(portName.Trim());
                }
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Windows registry serial port discovery failed.");
        }
    }

    private static void TryAddPortsFromPattern(HashSet<string> ports, string directory, string pattern)
    {
        if (!Directory.Exists(directory))
        {
            return;
        }

        foreach (var path in Directory.GetFiles(directory, pattern))
        {
            ports.Add(path);
        }
    }

    private void UpdateManagedEnvironmentFile(string environmentName)
    {
        var environmentFilePath = managedRestartService.GetEnvironmentFilePath();
        if (environmentFilePath is null)
        {
            return;
        }

        var lines = new[]
        {
            $"ASPNETCORE_ENVIRONMENT={environmentName}",
            $"ASPNETCORE_URLS={ManagedAspNetCoreUrls}"
        };

        File.WriteAllLines(environmentFilePath, lines);
    }

    private static string GetStartupMode()
    {
        return "Hardware";
    }

    private static string NormalizeStartupMode(string startupMode)
    {
        return startupMode.Trim().ToLowerInvariant() switch
        {
            "hardware" or "production" or "hw" => "Hardware",
            _ => throw new InvalidOperationException($"Unsupported startup mode '{startupMode}'.")
        };
    }

    private MonitorConfiguration GetMonitorConfiguration()
    {
        return appConfiguration.GetSection("Monitor").Get<MonitorConfiguration>()
            ?? throw new InvalidOperationException("Monitor configuration is missing or invalid.");
    }

    private static bool IsStorageConfigured(IConfiguration configuration)
    {
        var provider = configuration.GetValue<string>("Monitor:Storage:Provider");
        var connectionString = configuration.GetValue<string>("Monitor:Storage:ConnectionString");

        return string.Equals(provider, "TimescaleDb", StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(connectionString);
    }

    private string GetEnvironmentLocalSettingsPath(string environmentName)
    {
        return Path.Combine(_contentRoot, $"appsettings.{environmentName}.Local.json");
    }

    private string GetCurrentEnvironmentLocalSettingsPath()
    {
        return GetEnvironmentLocalSettingsPath(environment.EnvironmentName);
    }

    private DatabaseSettingsStateResponse BuildDatabaseSettingsStateResponse(MonitorConfiguration configuration)
    {
        return new DatabaseSettingsStateResponse
        {
            RawSecondsWindowMinutes = configuration.Storage.Retention.RawSecondsWindowMinutes,
            PersistedBucketMinutes = configuration.Storage.Retention.PersistedBucketMinutes
        };
    }

    private static void ValidateTemporaryHistoryMinutes(int value)
    {
        if (!SupportedTemporaryHistoryMinutes.Contains(value))
        {
            throw new InvalidOperationException(
                $"RawSecondsWindowMinutes must be one of: {string.Join(", ", SupportedTemporaryHistoryMinutes)}.");
        }
    }

    private static void ValidatePersistedBucketMinutes(int value)
    {
        if (!SupportedPersistedBucketMinutes.Contains(value))
        {
            throw new InvalidOperationException(
                $"PersistedBucketMinutes must be one of: {string.Join(", ", SupportedPersistedBucketMinutes)}.");
        }
    }

    private void UpdateJson(string path, Action<JsonObject> updateMonitor)
    {
        var root = LoadJsonObject(path);
        var monitor = GetOrCreateObject(root, "Monitor");

        updateMonitor(monitor);

        WriteJson(path, root);
    }

    private static JsonObject LoadJsonObject(string path)
    {
        if (!File.Exists(path))
        {
            return new JsonObject();
        }

        var json = File.ReadAllText(path);

        if (string.IsNullOrWhiteSpace(json))
        {
            return new JsonObject();
        }

        return JsonNode.Parse(json) as JsonObject
            ?? throw new InvalidOperationException($"Configuration file '{Path.GetFileName(path)}' must contain a JSON object.");
    }

    private static JsonObject GetOrCreateObject(JsonObject parent, string propertyName)
    {
        if (parent[propertyName] is JsonObject existing)
        {
            return existing;
        }

        if (parent[propertyName] is not null)
        {
            throw new InvalidOperationException($"Configuration section '{propertyName}' must be a JSON object.");
        }

        var created = new JsonObject();
        parent[propertyName] = created;
        return created;
    }

    private static void UpsertObject(JsonObject parent, string propertyName, Action<JsonObject> updateChild)
    {
        var child = GetOrCreateObject(parent, propertyName);
        updateChild(child);
    }

    private static void WriteJson(string path, JsonNode value)
    {
        var directory = Path.GetDirectoryName(path);

        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var json = value.ToJsonString(JsonOptions);
        File.WriteAllText(path, json + Environment.NewLine);
    }
}
