using System.IO.Ports;
using System.Runtime.Versioning;
using System.Text.Json;
using JkMonitor.Backend.Models;
using JkMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Microsoft.Win32;

namespace JkMonitor.Backend.Services;

public sealed class SetupConfigurationService(
    IHostEnvironment environment,
    IOptions<MonitorConfiguration> configuration,
    ManagedRestartService managedRestartService,
    ILogger<SetupConfigurationService> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    private readonly string _contentRoot = environment.ContentRootPath;
    private readonly MonitorConfiguration _configuration = configuration.Value;

    public SetupStateResponse GetState()
    {
        var startupMode = GetStartupMode(_configuration.SerialBus.PortName);
        var serialPort = startupMode == "Hardware" ? _configuration.SerialBus.PortName : null;

        return new SetupStateResponse
        {
            CurrentStartupMode = startupMode,
            EnvironmentName = environment.EnvironmentName,
            UseDatabase = string.Equals(_configuration.Storage.Provider, "TimescaleDb", StringComparison.OrdinalIgnoreCase),
            ConnectionString = _configuration.Storage.ConnectionString,
            SerialPort = serialPort,
            SerialPorts = GetSerialPorts(),
            CanAutoRestart = managedRestartService.CanAutoRestart,
            ApplyMessage = managedRestartService.GetApplyMessage()
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
            WriteJson(Path.Combine(_contentRoot, "appsettings.Development.Local.json"), new
            {
                Monitor = new
                {
                    Storage = new
                    {
                        Provider = useDatabase ? "TimescaleDb" : "None",
                        ConnectionString = connectionString
                    }
                }
            });

            UpdateManagedEnvironmentFile("Development");
        }
        else
        {
            WriteJson(Path.Combine(_contentRoot, "appsettings.Production.Local.json"), new
            {
                Monitor = new
                {
                    SerialBus = new
                    {
                        PortName = request.SerialPort!.Trim()
                    },
                    Storage = new
                    {
                        Provider = useDatabase ? "TimescaleDb" : "None",
                        ConnectionString = connectionString
                    },
                    Devices = new[]
                    {
                        new
                        {
                            DeviceId = "jk-master-01",
                            DisplayName = "Main Battery Rack",
                            Protocol = "jk-rs485",
                            RegisterProfile = "jk-inverter-v15",
                            Address = 1,
                            IsMaster = true,
                            PollIntervalMilliseconds = 1000,
                            Enabled = true
                        }
                    }
                }
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
        return string.Equals(portName, "SIMULATED", StringComparison.OrdinalIgnoreCase)
            ? "Simulator"
            : "Hardware";
    }

    private static string NormalizeStartupMode(string startupMode)
    {
        return startupMode.Trim().ToLowerInvariant() switch
        {
            "simulator" or "sim" or "development" => "Simulator",
            "hardware" or "production" or "hw" => "Hardware",
            _ => throw new InvalidOperationException($"Unsupported startup mode '{startupMode}'.")
        };
    }

    private static void WriteJson(string path, object value)
    {
        var json = JsonSerializer.Serialize(value, JsonOptions);
        File.WriteAllText(path, json + Environment.NewLine);
    }
}