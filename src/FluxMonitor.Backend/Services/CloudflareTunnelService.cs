using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class CloudflareTunnelService(
    IHostEnvironment environment,
    IConfiguration appConfiguration,
    ManagedRestartService managedRestartService,
    ICommandRunner commandRunner,
    ILogger<CloudflareTunnelService> logger)
{
    private const string CloudflaredBinary = "cloudflared";
    private const string CloudflaredServiceName = "cloudflared.service";
    private const string CloudflareTunnelProvider = "cloudflared";
    private const string NoTunnelProvider = "none";
    private const string TunnelTokenVariableName = "CLOUDFLARED_TUNNEL_TOKEN";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    private static readonly Regex CommandTokenRegex = new(
        @"(?:--token|service\s+install)\s+['""]?(?<token>[^\s'""]+)['""]?",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VersionRegex = new(
        @"\bversion\s+(?<version>[^\s]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly string _contentRoot = environment.ContentRootPath;
    private readonly string _environmentName = environment.EnvironmentName;

    public async Task<CloudflareTunnelStatusSnapshot> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        if (!OperatingSystem.IsLinux() || !managedRestartService.IsManagedInstall)
        {
            return new CloudflareTunnelStatusSnapshot
            {
                Supported = false,
                StatusMessage = "Cloudflare Tunnel is available on managed Linux installs.",
                TunnelProvider = GetSavedSettings().TunnelProvider
            };
        }

        var savedSettings = GetSavedSettings();
        var savedToken = TryReadStoredTunnelToken();

        var versionTask = commandRunner.RunAsync(CloudflaredBinary, ["--version"], cancellationToken);
        var serviceTask = commandRunner.RunAsync(
            "systemctl",
            [
                "show",
                CloudflaredServiceName,
                "--no-pager",
                "--property=LoadState",
                "--property=ActiveState",
                "--property=SubState",
                "--property=UnitFileState",
                "--property=Result"
            ],
            cancellationToken);

        await Task.WhenAll(versionTask, serviceTask);

        var versionResult = await versionTask;
        var serviceResult = await serviceTask;
        var serviceProperties = serviceResult.Succeeded
            ? ParseSystemctlProperties(serviceResult.StandardOutput)
            : new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var packageVersion = TryParseCloudflaredVersion(versionResult.StandardOutput);
        var serviceLoadState = NormalizeProperty(serviceProperties.GetValueOrDefault("LoadState"));
        var serviceActiveState = NormalizeProperty(serviceProperties.GetValueOrDefault("ActiveState"));
        var serviceSubState = NormalizeProperty(serviceProperties.GetValueOrDefault("SubState"));
        var serviceUnitFileState = NormalizeProperty(serviceProperties.GetValueOrDefault("UnitFileState"));
        var serviceSystemdResult = NormalizeProperty(serviceProperties.GetValueOrDefault("Result"));
        var packageInstalled = versionResult.Succeeded;
        var serviceInstalled = !string.Equals(serviceLoadState, "not-found", StringComparison.OrdinalIgnoreCase);
        var serviceRunning = string.Equals(serviceActiveState, "active", StringComparison.OrdinalIgnoreCase);
        var serviceEnabled = serviceUnitFileState?.StartsWith("enabled", StringComparison.OrdinalIgnoreCase) == true;
        var configured = string.Equals(savedSettings.TunnelProvider, CloudflareTunnelProvider, StringComparison.OrdinalIgnoreCase)
            && !string.IsNullOrWhiteSpace(savedToken);

        return new CloudflareTunnelStatusSnapshot
        {
            Supported = true,
            StatusMessage = BuildStatusMessage(
                savedSettings.TunnelProvider,
                savedSettings.PublicUrl,
                savedToken,
                packageInstalled,
                serviceInstalled,
                serviceRunning,
                serviceActiveState,
                serviceSystemdResult),
            TunnelProvider = savedSettings.TunnelProvider,
            PublicUrl = savedSettings.PublicUrl,
            HasStoredToken = !string.IsNullOrWhiteSpace(savedToken),
            Configured = configured,
            PackageInstalled = packageInstalled,
            PackageVersion = packageVersion,
            ServiceInstalled = serviceInstalled,
            ServiceRunning = serviceRunning,
            ServiceEnabled = serviceEnabled,
            ServiceLoadState = serviceLoadState,
            ServiceActiveState = serviceActiveState,
            ServiceSubState = serviceSubState,
            ServiceUnitFileState = serviceUnitFileState,
            ServiceResult = serviceSystemdResult
        };
    }

    public async Task<SaveCloudflareTunnelResponse> SaveAsync(
        SaveCloudflareTunnelRequest request,
        CancellationToken cancellationToken = default)
    {
        var currentStatus = await GetStatusAsync(cancellationToken);

        if (!currentStatus.Supported)
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = currentStatus.StatusMessage ?? "Cloudflare Tunnel is not available in this environment.",
                Status = currentStatus
            };
        }

        if (!currentStatus.PackageInstalled)
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = "cloudflared is not installed yet. Run the installer or updater on this device first.",
                Status = currentStatus
            };
        }

        if (!currentStatus.ServiceInstalled)
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = "The managed cloudflared service is missing. Run the installer or updater on this device first.",
                Status = currentStatus
            };
        }

        var enabled = request.Enabled;
        var existingToken = TryReadStoredTunnelToken();
        string? normalizedToken;
        string? normalizedPublicUrl;

        try
        {
            normalizedToken = NormalizeTunnelToken(request.TunnelTokenOrCommand);
            normalizedPublicUrl = NormalizePublicUrl(request.PublicUrl);
        }
        catch (InvalidOperationException exception)
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = exception.Message,
                Status = currentStatus
            };
        }

        var effectiveToken = enabled
            ? !string.IsNullOrWhiteSpace(normalizedToken)
                ? normalizedToken
                : existingToken
            : null;

        if (enabled && string.IsNullOrWhiteSpace(effectiveToken))
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = "Paste the Cloudflare install command or the tunnel token before enabling the tunnel.",
                Status = currentStatus
            };
        }

        try
        {
            UpdateJson(GetEnvironmentLocalSettingsPath(), monitor =>
            {
                UpsertObject(monitor, "ApiSecurity", apiSecurity =>
                {
                    apiSecurity["TunnelProvider"] = enabled ? CloudflareTunnelProvider : NoTunnelProvider;

                    UpsertObject(apiSecurity, "CloudflareTunnel", cloudflareTunnel =>
                    {
                        cloudflareTunnel["PublicUrl"] = normalizedPublicUrl ?? string.Empty;
                    });
                });
            });

            WriteStoredTunnelToken(enabled ? effectiveToken : null);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to save Cloudflare Tunnel configuration.");
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = "Flux Monitor could not save the Cloudflare Tunnel configuration.",
                Status = await GetStatusAsync(cancellationToken)
            };
        }

        var command = enabled ? "restart" : "stop";
        var serviceCommandResult = await commandRunner.RunAsync(
            "systemctl",
            [command, CloudflaredServiceName],
            cancellationToken);

        await Task.Delay(TimeSpan.FromMilliseconds(400), cancellationToken);
        var updatedStatus = await GetStatusAsync(cancellationToken);

        if (!serviceCommandResult.Succeeded)
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = enabled
                    ? $"Settings were saved, but cloudflared could not be restarted. {BuildCommandFailureMessage(serviceCommandResult)}"
                    : $"Settings were saved, but cloudflared could not be stopped. {BuildCommandFailureMessage(serviceCommandResult)}",
                Status = updatedStatus
            };
        }

        if (enabled && !updatedStatus.ServiceRunning)
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = updatedStatus.StatusMessage ?? "Settings were saved, but the cloudflared service did not stay running.",
                Status = updatedStatus
            };
        }

        return new SaveCloudflareTunnelResponse
        {
            Success = true,
            Message = enabled
                ? "Cloudflare Tunnel settings were saved and the service was restarted."
                : "Cloudflare Tunnel was disabled and the service was stopped.",
            Status = updatedStatus
        };
    }

    internal static string? NormalizeTunnelToken(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return null;
        }

        var match = CommandTokenRegex.Match(trimmed);
        if (match.Success)
        {
            return match.Groups["token"].Value.Trim();
        }

        if (trimmed.Contains(' ', StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The Cloudflare command could not be parsed. Paste the full install command or just the tunnel token.");
        }

        return trimmed;
    }

    internal static string? NormalizePublicUrl(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return null;
        }

        if (!trimmed.Contains("://", StringComparison.Ordinal))
        {
            trimmed = $"https://{trimmed}";
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrWhiteSpace(uri.Host))
        {
            throw new InvalidOperationException("Enter a valid public URL, for example https://monitor.example.com.");
        }

        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    private TunnelSettings GetSavedSettings()
    {
        var root = LoadJsonObject(GetEnvironmentLocalSettingsPath(), optional: true);
        var configuredProvider = ReadNestedString(root, "Monitor", "ApiSecurity", "TunnelProvider");
        var configuredPublicUrl = ReadNestedString(root, "Monitor", "ApiSecurity", "CloudflareTunnel", "PublicUrl");

        var provider = configuredProvider
            ?? appConfiguration["Monitor:ApiSecurity:TunnelProvider"]
            ?? NoTunnelProvider;
        var publicUrl = configuredPublicUrl
            ?? appConfiguration["Monitor:ApiSecurity:CloudflareTunnel:PublicUrl"];

        return new TunnelSettings(
            string.IsNullOrWhiteSpace(provider) ? NoTunnelProvider : provider.Trim(),
            string.IsNullOrWhiteSpace(publicUrl) ? null : publicUrl.Trim());
    }

    private string GetEnvironmentLocalSettingsPath()
    {
        return Path.Combine(_contentRoot, $"appsettings.{_environmentName}.Local.json");
    }

    private string GetTunnelEnvironmentFilePath()
    {
        var installRoot = Directory.GetParent(_contentRoot)?.FullName ?? _contentRoot;
        return Path.Combine(installRoot, "cloudflared.env");
    }

    private string? TryReadStoredTunnelToken()
    {
        var path = GetTunnelEnvironmentFilePath();
        if (!File.Exists(path))
        {
            return null;
        }

        foreach (var line in File.ReadLines(path))
        {
            if (TryParseEnvironmentValue(line, TunnelTokenVariableName, out var value))
            {
                return value;
            }
        }

        return null;
    }

    private void WriteStoredTunnelToken(string? token)
    {
        var path = GetTunnelEnvironmentFilePath();
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        if (string.IsNullOrWhiteSpace(token))
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            return;
        }

        File.WriteAllText(path, $"{TunnelTokenVariableName}={token.Trim()}{Environment.NewLine}");
    }

    private void UpdateJson(string path, Action<JsonObject> updateMonitor)
    {
        var root = LoadJsonObject(path, optional: true);
        var monitor = GetOrCreateObject(root, "Monitor");

        updateMonitor(monitor);

        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(path, root.ToJsonString(JsonOptions) + Environment.NewLine);
    }

    private static JsonObject LoadJsonObject(string path, bool optional)
    {
        if (!File.Exists(path))
        {
            return optional ? new JsonObject() : throw new InvalidOperationException($"Configuration file '{path}' does not exist.");
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

    private static string? ReadNestedString(JsonObject parent, params string[] segments)
    {
        JsonNode? current = parent;
        foreach (var segment in segments)
        {
            if (current is not JsonObject currentObject || currentObject[segment] is not JsonNode next)
            {
                return null;
            }

            current = next;
        }

        return current?.GetValue<string>();
    }

    private static Dictionary<string, string> ParseSystemctlProperties(string output)
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

    private static string? TryParseCloudflaredVersion(string output)
    {
        var match = VersionRegex.Match(output);
        return match.Success ? match.Groups["version"].Value : null;
    }

    private static string? NormalizeProperty(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        return string.Equals(trimmed, "[not set]", StringComparison.OrdinalIgnoreCase) ? null : trimmed;
    }

    private static string BuildStatusMessage(
        string tunnelProvider,
        string? publicUrl,
        string? savedToken,
        bool packageInstalled,
        bool serviceInstalled,
        bool serviceRunning,
        string? activeState,
        string? serviceResult)
    {
        if (!packageInstalled)
        {
            return "cloudflared is not installed on this device yet. Run the installer or updater again.";
        }

        if (!serviceInstalled)
        {
            return "The managed cloudflared service is missing. Run the installer or updater again.";
        }

        if (!string.Equals(tunnelProvider, CloudflareTunnelProvider, StringComparison.OrdinalIgnoreCase))
        {
            return !string.IsNullOrWhiteSpace(savedToken)
                ? "A tunnel token is stored, but Cloudflare Tunnel is currently disabled."
                : "Cloudflare Tunnel is disabled.";
        }

        if (string.IsNullOrWhiteSpace(savedToken))
        {
            return "Paste the Cloudflare install command or tunnel token to connect this device.";
        }

        if (serviceRunning)
        {
            return !string.IsNullOrWhiteSpace(publicUrl)
                ? $"Cloudflare Tunnel is running. Open {publicUrl} from outside your network."
                : "Cloudflare Tunnel is running. Add the public hostname here if you want a quick link in the UI.";
        }

        if (string.Equals(activeState, "activating", StringComparison.OrdinalIgnoreCase))
        {
            return "Cloudflare Tunnel is starting.";
        }

        if (string.Equals(serviceResult, "condition-failed", StringComparison.OrdinalIgnoreCase))
        {
            return "Cloudflare Tunnel is enabled, but the service does not have a saved token yet.";
        }

        return "Cloudflare Tunnel is configured, but the service is not running.";
    }

    private static string BuildCommandFailureMessage(CommandResult result)
    {
        if (!string.IsNullOrWhiteSpace(result.StandardError))
        {
            return result.StandardError.Trim();
        }

        if (!string.IsNullOrWhiteSpace(result.StandardOutput))
        {
            return result.StandardOutput.Trim();
        }

        return "Check the cloudflared service status on the device for more detail.";
    }

    private static bool TryParseEnvironmentValue(string line, string key, out string? value)
    {
        var prefix = key + "=";
        if (line.StartsWith(prefix, StringComparison.Ordinal))
        {
            value = line[prefix.Length..].Trim().Trim('"', '\'');
            return !string.IsNullOrWhiteSpace(value);
        }

        value = null;
        return false;
    }

    private sealed record TunnelSettings(string TunnelProvider, string? PublicUrl);
}

public interface ICommandRunner
{
    Task<CommandResult> RunAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken cancellationToken);
}

public sealed class ProcessCommandRunner : ICommandRunner
{
    public async Task<CommandResult> RunAsync(
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
            return new CommandResult(false, string.Empty, exception.Message, null);
        }

        try
        {
            var standardOutputTask = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var standardErrorTask = process.StandardError.ReadToEndAsync(cancellationToken);

            await process.WaitForExitAsync(cancellationToken);

            return new CommandResult(
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
}

public sealed record CommandResult(bool Succeeded, string StandardOutput, string StandardError, int? ExitCode);
