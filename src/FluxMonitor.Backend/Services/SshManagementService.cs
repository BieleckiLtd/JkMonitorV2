using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class SshManagementService
{
    private const string ServiceName = "ssh";

    private readonly ICommandRunner _commandRunner;
    private readonly ILogger<SshManagementService> _logger;
    private readonly Func<bool> _isLinux;

    public SshManagementService(ICommandRunner commandRunner, ILogger<SshManagementService> logger)
        : this(commandRunner, logger, OperatingSystem.IsLinux)
    {
    }

    public SshManagementService(
        ICommandRunner commandRunner,
        ILogger<SshManagementService> logger,
        Func<bool> isLinux)
    {
        _commandRunner = commandRunner;
        _logger = logger;
        _isLinux = isLinux;
    }

    public async Task<SshServiceSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        if (!_isLinux())
        {
            return new SshServiceSnapshot
            {
                Supported = false,
                StatusMessage = "SSH controls are supported on Linux hosts with systemd."
            };
        }

        var statusResult = await _commandRunner.RunAsync(
            "systemctl",
            [
                "show",
                ServiceName,
                "--no-pager",
                "--property=LoadState",
                "--property=ActiveState",
                "--property=SubState",
                "--property=UnitFileState",
                "--property=Result"
            ],
            cancellationToken);

        if (!statusResult.Succeeded)
        {
            _logger.LogWarning(
                "Unable to inspect SSH service state. ExitCode={ExitCode}, Error={Error}",
                statusResult.ExitCode,
                statusResult.StandardError);

            return new SshServiceSnapshot
            {
                Supported = false,
                StatusMessage = BuildCommandFailureMessage(statusResult, "Unable to inspect the SSH service.")
            };
        }

        var properties = ParseSystemctlProperties(statusResult.StandardOutput);
        var loadState = NormalizeProperty(properties.GetValueOrDefault("LoadState"));
        var activeState = NormalizeProperty(properties.GetValueOrDefault("ActiveState"));
        var subState = NormalizeProperty(properties.GetValueOrDefault("SubState"));
        var unitFileState = NormalizeProperty(properties.GetValueOrDefault("UnitFileState"));
        var serviceResult = NormalizeProperty(properties.GetValueOrDefault("Result"));
        var serviceInstalled = !string.Equals(loadState, "not-found", StringComparison.OrdinalIgnoreCase);
        var enabled = IsEnabledState(unitFileState);
        var active = string.Equals(activeState, "active", StringComparison.OrdinalIgnoreCase);

        return new SshServiceSnapshot
        {
            Supported = serviceInstalled,
            Enabled = enabled,
            Active = active,
            StatusMessage = BuildStatusMessage(serviceInstalled, enabled, active, activeState, serviceResult),
            ServiceLoadState = loadState,
            ServiceActiveState = activeState,
            ServiceSubState = subState,
            ServiceUnitFileState = unitFileState,
            ServiceResult = serviceResult
        };
    }

    public async Task<SshServiceCommandResult> SetEnabledAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        var currentSnapshot = await GetSnapshotAsync(cancellationToken);
        if (!currentSnapshot.Supported)
        {
            return new SshServiceCommandResult
            {
                Success = false,
                Enabled = currentSnapshot.Enabled,
                Active = currentSnapshot.Active,
                Message = currentSnapshot.StatusMessage ?? "SSH controls are unavailable on this host."
            };
        }

        var commandResult = await _commandRunner.RunAsync(
            "systemctl",
            enabled
                ? ["enable", "--now", ServiceName]
                : ["disable", "--now", ServiceName],
            cancellationToken);

        await Task.Delay(TimeSpan.FromMilliseconds(400), cancellationToken);

        var updatedSnapshot = await GetSnapshotAsync(cancellationToken);
        var reachedExpectedState = enabled
            ? updatedSnapshot.Enabled && updatedSnapshot.Active
            : !updatedSnapshot.Enabled && !updatedSnapshot.Active;

        if (!commandResult.Succeeded)
        {
            return new SshServiceCommandResult
            {
                Success = false,
                Enabled = updatedSnapshot.Enabled,
                Active = updatedSnapshot.Active,
                Message = enabled
                    ? $"SSH could not be enabled. {BuildCommandFailureMessage(commandResult, "Check the SSH service status on the device.")}"
                    : $"SSH could not be disabled. {BuildCommandFailureMessage(commandResult, "Check the SSH service status on the device.")}"
            };
        }

        if (!reachedExpectedState)
        {
            return new SshServiceCommandResult
            {
                Success = false,
                Enabled = updatedSnapshot.Enabled,
                Active = updatedSnapshot.Active,
                Message = updatedSnapshot.StatusMessage ?? "SSH did not reach the requested state."
            };
        }

        return new SshServiceCommandResult
        {
            Success = true,
            Enabled = updatedSnapshot.Enabled,
            Active = updatedSnapshot.Active,
            Message = enabled
                ? "SSH was enabled."
                : "SSH was disabled."
        };
    }

    private static bool IsEnabledState(string? unitFileState)
    {
        return unitFileState?.StartsWith("enabled", StringComparison.OrdinalIgnoreCase) == true;
    }

    private static string BuildStatusMessage(
        bool serviceInstalled,
        bool enabled,
        bool active,
        string? activeState,
        string? serviceResult)
    {
        if (!serviceInstalled)
        {
            return "The SSH service is not installed on this device.";
        }

        if (active && enabled)
        {
            return "SSH is enabled and accepting remote terminal connections.";
        }

        if (active)
        {
            return "SSH is running, but it will not start automatically after reboot.";
        }

        if (string.Equals(activeState, "activating", StringComparison.OrdinalIgnoreCase))
        {
            return "SSH is starting.";
        }

        if (enabled)
        {
            return "SSH is enabled, but the service is not running.";
        }

        if (string.Equals(serviceResult, "exit-code", StringComparison.OrdinalIgnoreCase))
        {
            return "SSH is off. The last start attempt failed.";
        }

        return "SSH is off.";
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

    private static string? NormalizeProperty(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var trimmed = value.Trim();
        return string.Equals(trimmed, "[not set]", StringComparison.OrdinalIgnoreCase) ? null : trimmed;
    }

    private static string BuildCommandFailureMessage(CommandResult result, string fallback)
    {
        if (!string.IsNullOrWhiteSpace(result.StandardError))
        {
            return result.StandardError.Trim();
        }

        if (!string.IsNullOrWhiteSpace(result.StandardOutput))
        {
            return result.StandardOutput.Trim();
        }

        return fallback;
    }
}
