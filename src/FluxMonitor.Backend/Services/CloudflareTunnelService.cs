using System.Diagnostics;
using System.Text.RegularExpressions;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class CloudflareTunnelService(
    IHostEnvironment environment,
    ManagedRestartService managedRestartService,
    ICommandRunner commandRunner,
    CloudflareTunnelStore cloudflareTunnelStore,
    ILogger<CloudflareTunnelService> logger)
{
    private const string CloudflaredBinary = "cloudflared";
    private const string CloudflaredServiceName = "cloudflared.service";
    private const string CloudflareTunnelProvider = "cloudflared";
    private const string NoTunnelProvider = "none";
    private const string TunnelTokenVariableName = "CLOUDFLARED_TUNNEL_TOKEN";

    private static readonly Regex CommandTokenRegex = new(
        @"(?:--token|service\s+install)\s+['""]?(?<token>[^\s'""]+)['""]?",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex EmbeddedJwtTokenRegex = new(
        @"(?<token>eyJ[A-Za-z0-9._-]+)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VersionRegex = new(
        @"\bversion\s+(?<version>[^\s]+)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly string _contentRoot = environment.ContentRootPath;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await cloudflareTunnelStore.InitializeAsync(cancellationToken);
        await SyncRuntimeStateAsync(cancellationToken);
    }

    public async Task<CloudflareTunnelStatusSnapshot> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        var storedSettings = await cloudflareTunnelStore.GetSettingsAsync(cancellationToken);

        if (!OperatingSystem.IsLinux() || !managedRestartService.IsManagedInstall)
        {
            return new CloudflareTunnelStatusSnapshot
            {
                Supported = false,
                StatusMessage = "Tunnel is available on managed Linux installs.",
                TunnelProvider = storedSettings.Enabled ? CloudflareTunnelProvider : NoTunnelProvider,
                HasStoredToken = !string.IsNullOrWhiteSpace(storedSettings.TunnelToken),
                MaskedToken = MaskToken(storedSettings.TunnelToken)
            };
        }

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
        var hasStoredToken = !string.IsNullOrWhiteSpace(storedSettings.TunnelToken);
        var configured = storedSettings.Enabled && hasStoredToken;

        return new CloudflareTunnelStatusSnapshot
        {
            Supported = true,
            StatusMessage = BuildStatusMessage(
                storedSettings.Enabled,
                storedSettings.TunnelToken,
                packageInstalled,
                serviceInstalled,
                serviceRunning,
                serviceActiveState,
                serviceSystemdResult),
            TunnelProvider = storedSettings.Enabled ? CloudflareTunnelProvider : NoTunnelProvider,
            HasStoredToken = hasStoredToken,
            MaskedToken = MaskToken(storedSettings.TunnelToken),
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
                Message = currentStatus.StatusMessage ?? "Tunnel is not available in this environment.",
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

        var storedSettings = await cloudflareTunnelStore.GetSettingsAsync(cancellationToken);
        string? normalizedToken;

        try
        {
            normalizedToken = NormalizeTunnelToken(request.TunnelTokenOrCommand);
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

        var effectiveToken = !string.IsNullOrWhiteSpace(normalizedToken)
            ? normalizedToken
            : storedSettings.TunnelToken;

        if (request.Enabled && string.IsNullOrWhiteSpace(effectiveToken))
        {
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = "Paste the Cloudflare install command or the tunnel token before enabling Tunnel.",
                Status = currentStatus
            };
        }

        try
        {
            await cloudflareTunnelStore.SaveSettingsAsync(request.Enabled, effectiveToken, cancellationToken);
            await SyncRuntimeStateAsync(cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to save Tunnel configuration.");
            return new SaveCloudflareTunnelResponse
            {
                Success = false,
                Message = "Flux Monitor could not save the Tunnel configuration.",
                Status = await GetStatusAsync(cancellationToken)
            };
        }

        var command = request.Enabled ? "restart" : "stop";
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
                Message = request.Enabled
                    ? $"Settings were saved, but cloudflared could not be restarted. {BuildCommandFailureMessage(serviceCommandResult)}"
                    : $"Settings were saved, but cloudflared could not be stopped. {BuildCommandFailureMessage(serviceCommandResult)}",
                Status = updatedStatus
            };
        }

        if (request.Enabled && !updatedStatus.ServiceRunning)
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
            Message = request.Enabled
                ? "Tunnel settings were saved and the service was restarted."
                : "Tunnel was disabled. The saved token was kept in PostgreSQL.",
            Status = updatedStatus
        };
    }

    public async Task SyncRuntimeStateAsync(CancellationToken cancellationToken = default)
    {
        var storedSettings = await cloudflareTunnelStore.GetSettingsAsync(cancellationToken);
        WriteStoredTunnelToken(storedSettings.Enabled ? storedSettings.TunnelToken : null);
    }

    internal static string? NormalizeTunnelToken(string? value)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return null;
        }

        var commandMatch = CommandTokenRegex.Match(trimmed);
        if (commandMatch.Success)
        {
            return commandMatch.Groups["token"].Value.Trim();
        }

        var embeddedTokenMatch = EmbeddedJwtTokenRegex.Match(trimmed);
        if (embeddedTokenMatch.Success)
        {
            return embeddedTokenMatch.Groups["token"].Value.Trim();
        }

        if (trimmed.Contains(' ', StringComparison.Ordinal))
        {
            throw new InvalidOperationException("The Cloudflare command could not be parsed. Paste the full install command, run command, or just the tunnel token.");
        }

        return trimmed;
    }

    internal static string? MaskToken(string? token)
    {
        var trimmed = token?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return null;
        }

        return trimmed.Length <= 10 ? trimmed : $"{trimmed[..10]}...";
    }

    private string GetTunnelEnvironmentFilePath()
    {
        var installRoot = Directory.GetParent(_contentRoot)?.FullName ?? _contentRoot;
        return Path.Combine(installRoot, "cloudflared.env");
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
        bool enabled,
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

        if (!enabled)
        {
            return !string.IsNullOrWhiteSpace(savedToken)
                ? "Tunnel is off. A token is saved in PostgreSQL and can be re-enabled from this page."
                : "Tunnel is off. Paste a token from Cloudflare to enable internet access.";
        }

        if (string.IsNullOrWhiteSpace(savedToken))
        {
            return "Paste the Cloudflare install command or tunnel token to connect this device.";
        }

        if (serviceRunning)
        {
            return "Tunnel is running. Open the hostname you configured in Cloudflare to reach this device.";
        }

        if (string.Equals(activeState, "activating", StringComparison.OrdinalIgnoreCase))
        {
            return "Tunnel is starting.";
        }

        if (string.Equals(serviceResult, "condition-failed", StringComparison.OrdinalIgnoreCase))
        {
            return "Tunnel is enabled, but the managed service does not have a token available yet.";
        }

        return "Tunnel is configured, but the service is not running.";
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
