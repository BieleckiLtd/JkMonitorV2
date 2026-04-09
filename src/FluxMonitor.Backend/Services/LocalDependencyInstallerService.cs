using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class LocalDependencyInstallerService(
    IHostEnvironment environment,
    ICommandRunner commandRunner,
    ManagedRestartService managedRestartService,
    ILogger<LocalDependencyInstallerService> logger)
{
    private const int MaxLogLines = 200;

    private readonly object _sync = new();
    private readonly string _contentRoot = environment.ContentRootPath;
    private readonly string _backendSettingsPath = Path.Combine(
        environment.ContentRootPath,
        $"appsettings.{environment.EnvironmentName}.Local.json");

    private bool _isRunning;
    private bool _hasCompleted;
    private bool? _succeeded;
    private bool _requiresRestart;
    private string? _message;
    private DateTimeOffset _updatedAt = DateTimeOffset.UtcNow;
    private readonly List<string> _logLines = [];

    public LocalDependenciesStateResponse GetState()
    {
        var support = EvaluateSupport();

        lock (_sync)
        {
            return new LocalDependenciesStateResponse
            {
                Supported = support.Supported,
                IsRunning = _isRunning,
                HasCompleted = _hasCompleted,
                Succeeded = _succeeded,
                RequiresRestart = _requiresRestart,
                CanAutoRestart = managedRestartService.CanAutoRestart,
                Message = _message ?? support.Message,
                LogLines = _logLines.ToArray(),
                UpdatedAt = _updatedAt
            };
        }
    }

    public InstallLocalDependenciesResponse Install()
    {
        var support = EvaluateSupport();
        if (!support.Supported || support.ScriptPath is null)
        {
            throw new InvalidOperationException(support.Message);
        }

        lock (_sync)
        {
            if (_isRunning)
            {
                return new InstallLocalDependenciesResponse
                {
                    Started = false,
                    Message = "Dependency installation is already running.",
                    Status = BuildStateSnapshot(support)
                };
            }

            _isRunning = true;
            _hasCompleted = false;
            _succeeded = null;
            _requiresRestart = false;
            _message = "Installing local PostgreSQL and TimescaleDB for Flux Monitor.";
            _updatedAt = DateTimeOffset.UtcNow;
            _logLines.Clear();
            AppendLogUnsafe("Starting local dependency installation.");
        }

        _ = Task.Run(() => RunInstallAsync(support.ScriptPath), CancellationToken.None);

        return new InstallLocalDependenciesResponse
        {
            Started = true,
            Message = "Flux Monitor started installing local PostgreSQL and TimescaleDB.",
            Status = GetState()
        };
    }

    private async Task RunInstallAsync(string scriptPath)
    {
        try
        {
            var result = await commandRunner.RunStreamingAsync(
                "powershell",
                [
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    scriptPath,
                    "-BackendSettingsPath",
                    _backendSettingsPath
                ],
                CaptureInstallerOutputAsync,
                CancellationToken.None);

            if (result.Succeeded)
            {
                CompleteRun(
                    succeeded: true,
                    requiresRestart: true,
                    message: managedRestartService.CanAutoRestart
                        ? "Local PostgreSQL and TimescaleDB are ready. Flux Monitor is restarting to finish setup."
                        : "Local PostgreSQL and TimescaleDB are ready. Restart Flux Monitor to finish setup.");
                return;
            }

            if (!string.IsNullOrWhiteSpace(result.StandardError))
            {
                AppendLog(result.StandardError.Trim());
            }

            CompleteRun(
                succeeded: false,
                requiresRestart: false,
                message: "Dependency installation failed. Review the installer log and try again.");
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Failed while installing local Flux Monitor dependencies.");
            AppendLog(exception.Message);
            CompleteRun(
                succeeded: false,
                requiresRestart: false,
                message: "Dependency installation failed before it could complete.");
        }
    }

    private ValueTask CaptureInstallerOutputAsync(CommandOutputLine output)
    {
        if (!string.IsNullOrWhiteSpace(output.Line))
        {
            AppendLog(output.IsError ? $"ERROR: {output.Line}" : output.Line);
        }

        return ValueTask.CompletedTask;
    }

    private void CompleteRun(bool succeeded, bool requiresRestart, string message)
    {
        lock (_sync)
        {
            _isRunning = false;
            _hasCompleted = true;
            _succeeded = succeeded;
            _requiresRestart = requiresRestart;
            _message = message;
            _updatedAt = DateTimeOffset.UtcNow;
        }
    }

    private void AppendLog(string line)
    {
        lock (_sync)
        {
            AppendLogUnsafe(line);
        }
    }

    private void AppendLogUnsafe(string line)
    {
        _logLines.Add(line);
        while (_logLines.Count > MaxLogLines)
        {
            _logLines.RemoveAt(0);
        }

        _updatedAt = DateTimeOffset.UtcNow;
    }

    private LocalDependenciesStateResponse BuildStateSnapshot(InstallerSupport support)
    {
        return new LocalDependenciesStateResponse
        {
            Supported = support.Supported,
            IsRunning = _isRunning,
            HasCompleted = _hasCompleted,
            Succeeded = _succeeded,
            RequiresRestart = _requiresRestart,
            CanAutoRestart = managedRestartService.CanAutoRestart,
            Message = _message ?? support.Message,
            LogLines = _logLines.ToArray(),
            UpdatedAt = _updatedAt
        };
    }

    private InstallerSupport EvaluateSupport()
    {
        if (!OperatingSystem.IsWindows())
        {
            return new InstallerSupport(false, "Automatic dependency installation is only available on Windows.", null);
        }

        var scriptPath = ResolveScriptPath();
        if (scriptPath is null)
        {
            return new InstallerSupport(false, "This build does not include the Windows dependency installer.", null);
        }

        return new InstallerSupport(
            true,
            "Flux Monitor can install local PostgreSQL and TimescaleDB for this Windows app.",
            scriptPath);
    }

    private string? ResolveScriptPath()
    {
        var publishedPath = Path.Combine(_contentRoot, "scripts", "ensure-local-postgres.ps1");
        if (File.Exists(publishedPath))
        {
            return publishedPath;
        }

        var repositoryPath = Path.GetFullPath(Path.Combine(_contentRoot, "..", "..", "scripts", "ensure-local-postgres.ps1"));
        return File.Exists(repositoryPath) ? repositoryPath : null;
    }

    private sealed record InstallerSupport(bool Supported, string Message, string? ScriptPath);
}
