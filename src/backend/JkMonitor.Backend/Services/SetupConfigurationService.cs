using System.IO.Ports;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using JkMonitor.Backend.Models;
using JkMonitor.Contracts.Configuration;
using Microsoft.Win32;

namespace JkMonitor.Backend.Services;

public sealed class SetupConfigurationService(
    IHostEnvironment environment,
    IConfiguration appConfiguration,
    ManagedRestartService managedRestartService,
    ILogger<SetupConfigurationService> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    private readonly string _contentRoot = environment.ContentRootPath;

    public SetupStateResponse GetState()
    {
        var configuration = GetMonitorConfiguration();
        var startupMode = GetStartupMode(configuration.SerialBus.PortName);
        var serialPort = startupMode == "Hardware" ? configuration.SerialBus.PortName : null;

        return new SetupStateResponse
        {
            CurrentStartupMode = startupMode,
            EnvironmentName = environment.EnvironmentName,
            UseDatabase = string.Equals(configuration.Storage.Provider, "TimescaleDb", StringComparison.OrdinalIgnoreCase),
            ConnectionString = configuration.Storage.ConnectionString,
            SerialPort = serialPort,
            SerialPorts = GetSerialPorts(),
            CanAutoRestart = managedRestartService.CanAutoRestart,
            ApplyMessage = managedRestartService.GetApplyMessage()
        };
    }

    public DeviceConfigurationStateResponse GetDeviceConfiguration()
    {
        var configuration = GetMonitorConfiguration();
        var path = GetEnvironmentLocalSettingsPath(environment.EnvironmentName);

        return new DeviceConfigurationStateResponse
        {
            ConfigurationFile = Path.GetFileName(path),
            Devices = configuration.Devices.Select(CloneDevice).ToArray()
        };
    }

    public DeviceConfigurationStateResponse SaveDevices(SaveDeviceConfigurationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);

        var devices = NormalizeDevices(request.Devices);
        var path = GetEnvironmentLocalSettingsPath(environment.EnvironmentName);

        UpdateJson(path, monitor =>
        {
            monitor["Devices"] = JsonSerializer.SerializeToNode(devices, JsonOptions) ?? new JsonArray();
        });

        logger.LogInformation("Saved {DeviceCount} device definitions to {ConfigurationFile}.", devices.Count, Path.GetFileName(path));

        return new DeviceConfigurationStateResponse
        {
            ConfigurationFile = Path.GetFileName(path),
            Devices = devices
        };
    }

    public ApplySetupResponse Apply(ApplySetupRequest request)
    {
        var startupMode = NormalizeStartupMode(request.StartupMode);
        var useDatabase = request.UseDatabase;
        var connectionString = useDatabase ? (request.ConnectionString ?? string.Empty).Trim() : string.Empty;

        if (useDatabase && string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("A PostgreSQL connection string is required when database storage is enabled.");
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
                    storage["Provider"] = useDatabase ? "TimescaleDb" : "None";
                    storage["ConnectionString"] = connectionString;
                });
            });

            UpdateManagedEnvironmentFile("Development");
        }
        else
        {
            UpdateJson(GetEnvironmentLocalSettingsPath("Production"), monitor =>
            {
                UpsertObject(monitor, "SerialBus", serialBus =>
                {
                    serialBus["PortName"] = request.SerialPort!.Trim();
                });

                UpsertObject(monitor, "Storage", storage =>
                {
                    storage["Provider"] = useDatabase ? "TimescaleDb" : "None";
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
                ? $"JK Monitor saved your {startupMode.ToLowerInvariant()} configuration and is restarting now."
                : $"JK Monitor saved your {startupMode.ToLowerInvariant()} configuration. Restart the app to apply it."
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
            "ASPNETCORE_URLS=http://0.0.0.0:5074"
        };

        File.WriteAllLines(environmentFilePath, lines);
    }

    private static string GetStartupMode(string portName)
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

    private string GetEnvironmentLocalSettingsPath(string environmentName)
    {
        return Path.Combine(_contentRoot, $"appsettings.{environmentName}.Local.json");
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

    private static IReadOnlyList<DeviceConfiguration> NormalizeDevices(IReadOnlyList<DeviceConfiguration> devices)
    {
        ArgumentNullException.ThrowIfNull(devices);

        var normalized = new List<DeviceConfiguration>(devices.Count);
        var deviceIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (var index = 0; index < devices.Count; index++)
        {
            var device = devices[index] ?? throw new InvalidOperationException($"Device at index {index} is missing.");
            var normalizedDevice = new DeviceConfiguration
            {
                DeviceId = RequireValue(device.DeviceId, nameof(DeviceConfiguration.DeviceId), index),
                DisplayName = RequireValue(device.DisplayName, nameof(DeviceConfiguration.DisplayName), index),
                ProfileId = RequireValue(device.ProfileId, nameof(DeviceConfiguration.ProfileId), index),
                Address = device.Address,
                IsMaster = device.IsMaster,
                PollIntervalMilliseconds = device.PollIntervalMilliseconds,
                Enabled = device.Enabled
            };

            if (normalizedDevice.PollIntervalMilliseconds <= 0)
            {
                throw new InvalidOperationException($"Device '{normalizedDevice.DeviceId}' must use a positive poll interval.");
            }

            if (!deviceIds.Add(normalizedDevice.DeviceId))
            {
                throw new InvalidOperationException($"Device id '{normalizedDevice.DeviceId}' is duplicated.");
            }

            normalized.Add(normalizedDevice);
        }

        return normalized;
    }

    private static string RequireValue(string? value, string propertyName, int index)
    {
        var trimmed = value?.Trim();

        return string.IsNullOrWhiteSpace(trimmed)
            ? throw new InvalidOperationException($"Device at index {index} is missing {propertyName}.")
            : trimmed;
    }

    private static DeviceConfiguration CloneDevice(DeviceConfiguration device)
    {
        return new DeviceConfiguration
        {
            DeviceId = device.DeviceId,
            DisplayName = device.DisplayName,
            ProfileId = device.ProfileId,
            Address = device.Address,
            IsMaster = device.IsMaster,
            PollIntervalMilliseconds = device.PollIntervalMilliseconds,
            Enabled = device.Enabled
        };
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