using System.Diagnostics;

namespace FluxMonitor.Backend.Services;

public sealed class ManagedRestartService(IHostEnvironment environment, IHostApplicationLifetime applicationLifetime, ILogger<ManagedRestartService> logger)
{
    private const string ServiceName = "fluxmonitor.service";
    private readonly string _contentRoot = environment.ContentRootPath;

    public bool CanAutoRestart => IsManagedInstall;

    public bool IsManagedInstall
    {
        get
        {
            var installRoot = GetInstallRoot();
            if (installRoot is null)
            {
                return false;
            }

            return File.Exists(Path.Combine(installRoot, "start.sh")) ||
                   File.Exists(Path.Combine(installRoot, "start.ps1")) ||
                   File.Exists(Path.Combine(installRoot, "fluxmonitor.env"));
        }
    }

    public string GetApplyMessage()
    {
        if (IsLinuxServiceInstall())
        {
            return "Saving from the app will restart the managed Flux Monitor service automatically.";
        }

        if (IsManagedInstall)
        {
            return "Saving from the app will restart this managed install automatically.";
        }

        return "Settings can be saved here, but this environment still needs a manual restart to apply them.";
    }

    public void ScheduleRestart()
    {
        if (!IsManagedInstall)
        {
            logger.LogInformation("Restart was requested, but this instance is not running as a managed install.");
            return;
        }

        if (IsLinuxServiceInstall())
        {
            logger.LogInformation("Scheduling application stop so systemd can restart Flux Monitor.");
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromMilliseconds(750));
                applicationLifetime.StopApplication();
            });
            return;
        }

        var installRoot = GetInstallRoot();
        if (installRoot is null)
        {
            return;
        }

        if (OperatingSystem.IsWindows())
        {
            var startScript = Path.Combine(installRoot, "start.ps1");
            if (File.Exists(startScript))
            {
                var command = $"Start-Sleep -Seconds 2; & '{startScript.Replace("'", "''")}'";
                StartDetachedProcess("powershell", $"-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command \"{command}\"");
            }
        }
        else
        {
            var startScript = Path.Combine(installRoot, "start.sh");
            if (File.Exists(startScript))
            {
                StartDetachedProcess("/bin/sh", $"-c \"sleep 2; '{startScript}' >/dev/null 2>&1 &\"");
            }
        }

        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromMilliseconds(750));
            applicationLifetime.StopApplication();
        });
    }

    public string? GetEnvironmentFilePath()
    {
        var installRoot = GetInstallRoot();
        if (installRoot is null)
        {
            return null;
        }

        return Path.Combine(installRoot, "fluxmonitor.env");
    }

    private string? GetInstallRoot()
    {
        return Directory.GetParent(_contentRoot)?.FullName;
    }

    private bool IsLinuxServiceInstall()
    {
        if (!OperatingSystem.IsLinux())
        {
            return false;
        }

        var envPath = GetEnvironmentFilePath();
        return envPath is not null && File.Exists(envPath) && File.Exists($"/etc/systemd/system/{ServiceName}");
    }

    private void StartDetachedProcess(string fileName, string arguments)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = _contentRoot
            });
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to start detached restart helper process.");
        }
    }
}