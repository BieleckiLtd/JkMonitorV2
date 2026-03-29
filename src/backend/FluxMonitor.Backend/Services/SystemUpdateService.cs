using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace FluxMonitor.Backend.Services;

public sealed class SystemUpdateService(
    IHttpClientFactory httpClientFactory,
    IBuildMetadataProvider buildMetadataProvider,
    ManagedRestartService managedRestartService,
    IHostApplicationLifetime applicationLifetime,
    ILogger<SystemUpdateService> logger)
{
    private const string Repository = "BieleckiLtd/JkMonitorV2";
    private const string ReleaseTag = "dev-latest";
    private const string AssetName = "fluxmonitor-backend-linux-arm64.tar.gz";
    private const string ChecksumAssetName = AssetName + ".sha256";
    private const string InstallerScriptUrl = $"https://raw.githubusercontent.com/{Repository}/dev/scripts/install-from-release.sh";
    private const string ReleaseApiUrl = $"https://api.github.com/repos/{Repository}/releases/tags/{ReleaseTag}";
    private const int InstallerOutputTailCapacity = 120;

    private static readonly UpdateStageDefinition StartingStage = new(
        InstallerSection: null,
        Stage: "Preparing update…",
        Detail: "Flux Monitor is getting the installer ready.",
        StepIndex: 0,
        StepCount: 9,
        PercentComplete: 3,
        CanCancel: true,
        CancelUnavailableReason: null);

    private static readonly UpdateStageDefinition CancellingStage = new(
        InstallerSection: null,
        Stage: "Cancelling update…",
        Detail: "Stopping the updater before the installed files are replaced.",
        StepIndex: 2,
        StepCount: 9,
        PercentComplete: 20,
        CanCancel: false,
        CancelUnavailableReason: "Cancellation is already being processed.");

    private static readonly UpdateStageDefinition RestartingStage = new(
        InstallerSection: null,
        Stage: "Restarting Flux Monitor…",
        Detail: "The new version is installed. The service is restarting now.",
        StepIndex: 9,
        StepCount: 9,
        PercentComplete: 100,
        CanCancel: false,
        CancelUnavailableReason: "The update has already been installed and the service is restarting.");

    private static readonly IReadOnlyList<UpdateStageDefinition> InstallerStages =
    [
        new(
            InstallerSection: "Flux Monitor release bootstrap",
            Stage: "Preparing update…",
            Detail: "Checking the published release and preparing the installer.",
            StepIndex: 1,
            StepCount: 9,
            PercentComplete: 8,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Downloading release artifact",
            Stage: "Downloading update…",
            Detail: "Downloading the published release package from GitHub. This can take a few minutes on slower links.",
            StepIndex: 2,
            StepCount: 9,
            PercentComplete: 18,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Verifying release artifact",
            Stage: "Verifying package…",
            Detail: "Checking that the downloaded package matches the published checksum before anything is replaced.",
            StepIndex: 3,
            StepCount: 9,
            PercentComplete: 30,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Extracting release artifact",
            Stage: "Unpacking update…",
            Detail: "Extracting the new release into a temporary folder.",
            StepIndex: 4,
            StepCount: 9,
            PercentComplete: 42,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Preparing installation folder",
            Stage: "Replacing installed files…",
            Detail: "Switching the app over to the new release and preserving your local configuration.",
            StepIndex: 5,
            StepCount: 9,
            PercentComplete: 58,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the installed files are being replaced."),
        new(
            InstallerSection: "Checking ASP.NET Core runtime",
            Stage: "Checking runtime…",
            Detail: "Making sure the required ASP.NET Core runtime is available on this device.",
            StepIndex: 6,
            StepCount: 9,
            PercentComplete: 72,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Installing local ASP.NET Core runtime",
            Stage: "Installing runtime…",
            Detail: "Installing the local ASP.NET Core runtime needed by the published build.",
            StepIndex: 7,
            StepCount: 9,
            PercentComplete: 80,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Configuring startup mode",
            Stage: "Applying configuration…",
            Detail: "Reapplying your saved runtime settings to the new installation.",
            StepIndex: 8,
            StepCount: 9,
            PercentComplete: 88,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Installing systemd service",
            Stage: "Updating service…",
            Detail: "Updating the system service so Flux Monitor starts the new version.",
            StepIndex: 9,
            StepCount: 9,
            PercentComplete: 95,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because Flux Monitor is already switching to the new version."),
        new(
            InstallerSection: "Starting Flux Monitor",
            Stage: "Starting Flux Monitor…",
            Detail: "Starting the updated service and checking that it comes back online.",
            StepIndex: 9,
            StepCount: 9,
            PercentComplete: 98,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because Flux Monitor is already switching to the new version.")
    ];

    private static readonly Dictionary<string, UpdateStageDefinition> InstallerStageMap = InstallerStages
        .Where(stage => stage.InstallerSection is not null)
        .ToDictionary(stage => stage.InstallerSection!, StringComparer.OrdinalIgnoreCase);

    private static readonly Dictionary<string, string> InstallerDetailOverrides = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Fetching the published build from GitHub Releases via direct asset URL."] = "Downloading the published release package from GitHub.",
        ["Checking the published checksum before install."] = "Verifying the package before anything is replaced.",
        ["Unpacking the application files."] = "Extracting the new release into a temporary folder.",
        ["Existing installation found. Preserving local config and cached runtime."] = "Keeping your saved settings and local runtime cache.",
        ["Migrated release-local settings from Development to Production."] = "Refreshing configuration so the published build uses the managed runtime settings.",
        ["No compatible ASP.NET Core 10 runtime was found. Install a local copy into this folder?"] = "The required ASP.NET Core runtime is missing on this device.",
        ["Reusing the existing runtime configuration for Production."] = "Keeping the current production runtime configuration.",
        ["Reusing the existing runtime configuration for Development."] = "Keeping the current development runtime configuration."
    };

    private UpdateProgress? _currentProgress;
    private Process? _currentInstallerProcess;
    private CancellationTokenSource? _updateCancellationSource;
    private bool _cancelRequested;
    private readonly Lock _stateGate = new();

    private string? _releaseETag;
    private object? _cachedRelease;

    public UpdateCheckResult CheckForUpdate()
    {
        var build = buildMetadataProvider.GetBuildInfo();
        var canUpdate = managedRestartService.IsManagedInstall && OperatingSystem.IsLinux();

        return new UpdateCheckResult
        {
            CurrentReleaseTag = build.ReleaseTag,
            CurrentSourceRevision = build.SourceRevisionId,
            CurrentBuiltAt = build.BuiltAt,
            CanUpdate = canUpdate,
            Reason = canUpdate ? null : "In-app update is only available on managed Linux installs."
        };
    }

    public async Task<UpdateCheckResult> CheckForUpdateAsync(CancellationToken cancellationToken)
    {
        var result = CheckForUpdate();

        try
        {
            using var client = httpClientFactory.CreateClient();
            client.DefaultRequestHeaders.Add("User-Agent", "FluxMonitor");

            var request = new HttpRequestMessage(HttpMethod.Get, ReleaseApiUrl);
            request.Headers.Add("Accept", "application/vnd.github+json");
            if (_releaseETag is not null)
            {
                request.Headers.TryAddWithoutValidation("If-None-Match", _releaseETag);
            }

            var response = await client.SendAsync(request, cancellationToken);

            GitHubRelease? release;
            if (response.StatusCode == System.Net.HttpStatusCode.NotModified)
            {
                release = _cachedRelease as GitHubRelease;
            }
            else
            {
                response.EnsureSuccessStatusCode();
                release = await response.Content.ReadFromJsonAsync<GitHubRelease>(cancellationToken);
                _releaseETag = response.Headers.ETag?.Tag;
                _cachedRelease = release;
            }

            if (release is not null)
            {
                var checksumAsset = release.Assets?.FirstOrDefault(a =>
                    string.Equals(a.Name, ChecksumAssetName, StringComparison.OrdinalIgnoreCase));

                string? remoteChecksum = null;
                if (checksumAsset?.BrowserDownloadUrl is not null)
                {
                    var checksumContent = await client.GetStringAsync(checksumAsset.BrowserDownloadUrl, cancellationToken);
                    remoteChecksum = checksumContent.Split(' ', 2)[0].Trim();
                }

                var localChecksum = GetLocalChecksum();

                result.RemoteReleasePublishedAt = checksumAsset?.UpdatedAt ?? release.PublishedAt;
                result.RemoteChecksum = remoteChecksum;
                result.LocalChecksum = localChecksum;
                result.UpdateAvailable = remoteChecksum is not null
                    && localChecksum is not null
                    && !string.Equals(remoteChecksum, localChecksum, StringComparison.OrdinalIgnoreCase);

                if (result.UpdateAvailable && !string.IsNullOrEmpty(result.CurrentSourceRevision))
                {
                    try
                    {
                        var compareUrl = $"https://api.github.com/repos/{Repository}/compare/{result.CurrentSourceRevision}...dev";
                        var comparison = await client.GetFromJsonAsync<GitHubComparison>(compareUrl, cancellationToken);
                        if (comparison?.Commits is { Count: > 0 })
                        {
                            result.Commits = comparison.Commits
                                .Select(c => new CommitInfo
                                {
                                    Sha = c.Sha?[..Math.Min(c.Sha.Length, 7)],
                                    Message = c.Commit?.Message?.Split('\n', 2)[0],
                                    Date = c.Commit?.Author?.Date
                                })
                                .ToList();
                        }
                    }
                    catch (Exception exception)
                    {
                        logger.LogDebug(exception, "Failed to fetch update comparison for {Repository}.", Repository);
                    }
                }
            }
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to check for updates from GitHub.");
            result.CheckError = exception.Message;
        }

        return result;
    }

    public UpdateProgress? GetProgress()
    {
        lock (_stateGate)
        {
            return _currentProgress;
        }
    }

    public UpdateCommandResult StartUpdate()
    {
        if (!managedRestartService.IsManagedInstall || !OperatingSystem.IsLinux())
        {
            return UpdateCommandResult.Fail("In-app update is only available on managed Linux installs.");
        }

        string sessionId;
        UpdateProgress progress;
        CancellationToken cancellationToken;

        lock (_stateGate)
        {
            if (_currentProgress is { IsRunning: true })
            {
                return UpdateCommandResult.Fail(
                    _currentProgress.CanCancel
                        ? "An update is already in progress."
                        : "An update is already in progress and has passed the point where it can be cancelled.",
                    _currentProgress);
            }

            _updateCancellationSource?.Dispose();
            _updateCancellationSource = new CancellationTokenSource();
            _cancelRequested = false;

            sessionId = Guid.NewGuid().ToString("N")[..8];
            progress = CreateProgress(
                sessionId,
                startedAt: DateTimeOffset.UtcNow,
                status: UpdateStatus.Running,
                isRunning: true,
                success: null,
                stage: StartingStage.Stage,
                detail: StartingStage.Detail,
                canCancel: StartingStage.CanCancel,
                cancelUnavailableReason: StartingStage.CancelUnavailableReason,
                stepIndex: StartingStage.StepIndex,
                stepCount: StartingStage.StepCount,
                percentComplete: StartingStage.PercentComplete);

            _currentProgress = progress;
            cancellationToken = _updateCancellationSource.Token;
        }

        logger.LogInformation("Starting in-app update session {SessionId}.", sessionId);
        _ = Task.Run(() => RunUpdateAsync(sessionId, cancellationToken));

        return UpdateCommandResult.Ok(progress);
    }

    public UpdateCommandResult CancelUpdate()
    {
        Process? installerProcess = null;
        CancellationTokenSource? cancellationSource = null;
        UpdateProgress? progress;

        lock (_stateGate)
        {
            progress = _currentProgress;

            if (progress is null || !progress.IsRunning)
            {
                return UpdateCommandResult.Fail("There is no update in progress.", progress);
            }

            if (!progress.CanCancel)
            {
                return UpdateCommandResult.Fail(
                    progress.CancelUnavailableReason ?? "This update can no longer be cancelled.",
                    progress);
            }

            if (_cancelRequested)
            {
                return UpdateCommandResult.Ok(progress);
            }

            _cancelRequested = true;
            cancellationSource = _updateCancellationSource;
            installerProcess = _currentInstallerProcess;

            _currentProgress = CreateProgress(
                progress.SessionId,
                startedAt: progress.StartedAt,
                status: UpdateStatus.Cancelling,
                isRunning: true,
                success: null,
                stage: CancellingStage.Stage,
                detail: CancellingStage.Detail,
                canCancel: false,
                cancelUnavailableReason: CancellingStage.CancelUnavailableReason,
                stepIndex: Math.Max(progress.StepIndex ?? CancellingStage.StepIndex ?? 0, CancellingStage.StepIndex ?? 0),
                stepCount: progress.StepCount ?? CancellingStage.StepCount,
                percentComplete: Math.Max(progress.PercentComplete ?? CancellingStage.PercentComplete ?? 0, CancellingStage.PercentComplete ?? 0));

            progress = _currentProgress;
        }

        logger.LogInformation("Cancellation requested for update session {SessionId}.", progress?.SessionId);

        try
        {
            cancellationSource?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The updater finished between the request and the cancel attempt.
        }

        TryKillInstallerProcess(installerProcess);
        return UpdateCommandResult.Ok(progress);
    }

    private async Task RunUpdateAsync(string sessionId, CancellationToken cancellationToken)
    {
        var outputTail = new FixedLineBuffer(InstallerOutputTailCapacity);
        var errorTail = new FixedLineBuffer(InstallerOutputTailCapacity);

        try
        {
            if (cancellationToken.IsCancellationRequested)
            {
                SetCancelledProgress(sessionId);
                return;
            }

            var installRoot = GetInstallRoot();
            if (installRoot is null)
            {
                SetFailedProgress(sessionId, "Update could not start.", "Flux Monitor could not determine the managed install location.", outputTail, errorTail);
                return;
            }

            var destination = Directory.GetParent(installRoot)?.FullName ?? installRoot;

            logger.LogInformation(
                "Update session {SessionId} will install release {ReleaseTag} into {Destination}.",
                sessionId,
                ReleaseTag,
                destination);

            var psi = new ProcessStartInfo
            {
                FileName = "/bin/bash",
                Arguments = $"-c \"wget -qO- '{InstallerScriptUrl}' | bash -s -- https://github.com/{Repository} {ReleaseTag} '{destination}'\"",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = destination
            };

            psi.Environment["FLUXMONITOR_REUSE_EXISTING_CONFIGURATION"] = "yes";
            psi.Environment["FLUXMONITOR_INSTALL_RUNTIME"] = "no";
            psi.Environment["FLUXMONITOR_INSTALL_SERVICE"] = "yes";

            using var process = Process.Start(psi);
            if (process is null)
            {
                SetFailedProgress(sessionId, "Update could not start.", "Flux Monitor could not start the installer process.", outputTail, errorTail);
                return;
            }

            SetCurrentInstallerProcess(sessionId, process);

            var stdoutTask = CaptureInstallerStreamAsync(
                process.StandardOutput,
                sessionId,
                outputTail,
                isErrorStream: false,
                cancellationToken);

            var stderrTask = CaptureInstallerStreamAsync(
                process.StandardError,
                sessionId,
                errorTail,
                isErrorStream: true,
                cancellationToken);

            await Task.WhenAll(
                stdoutTask,
                stderrTask,
                process.WaitForExitAsync(CancellationToken.None));

            if (WasCancellationRequested(sessionId))
            {
                SetCancelledProgress(sessionId);
                return;
            }

            if (process.ExitCode != 0)
            {
                logger.LogError(
                    "Update installer failed for session {SessionId} with exit code {ExitCode}. STDOUT: {Stdout} STDERR: {Stderr}",
                    sessionId,
                    process.ExitCode,
                    outputTail.ToMultilineString(),
                    errorTail.ToMultilineString());

                SetFailedProgress(
                    sessionId,
                    title: "Update failed.",
                    detail: CreateFriendlyFailureDetail(outputTail, errorTail),
                    outputTail,
                    errorTail);
                return;
            }

            logger.LogInformation("Update session {SessionId} installed successfully. Restarting the service.", sessionId);

            ApplyStageProgress(sessionId, RestartingStage, UpdateStatus.Restarting, isRunning: true, success: null);
            await Task.Delay(TimeSpan.FromSeconds(1), CancellationToken.None);
            applicationLifetime.StopApplication();
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "In-app update failed for session {SessionId}.", sessionId);
            SetFailedProgress(
                sessionId,
                title: "Update failed.",
                detail: "Flux Monitor hit an unexpected problem while applying the update. The current version should still be available.",
                outputTail,
                errorTail);
        }
        finally
        {
            ClearInstallerState(sessionId);
        }
    }

    private async Task CaptureInstallerStreamAsync(
        StreamReader reader,
        string sessionId,
        FixedLineBuffer tail,
        bool isErrorStream,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (WasCancellationRequested(sessionId))
            {
                return;
            }

            if (line is null)
            {
                return;
            }

            tail.Add(line);

            if (isErrorStream)
            {
                logger.LogTrace("Update installer stderr [{SessionId}]: {Line}", sessionId, line);
                continue;
            }

            logger.LogTrace("Update installer stdout [{SessionId}]: {Line}", sessionId, line);
            HandleInstallerOutputLine(sessionId, line);
        }
    }

    private void HandleInstallerOutputLine(string sessionId, string line)
    {
        var trimmed = line.Trim();
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return;
        }

        if (TryGetStageDefinition(trimmed, out var stage))
        {
            ApplyStageProgress(sessionId, stage, UpdateStatus.Running, isRunning: true, success: null);
            return;
        }

        if (InstallerDetailOverrides.TryGetValue(trimmed, out var detail))
        {
            UpdateProgressDetail(sessionId, detail);
        }
    }

    private void ApplyStageProgress(
        string sessionId,
        UpdateStageDefinition stage,
        string status,
        bool isRunning,
        bool? success)
    {
        lock (_stateGate)
        {
            if (_currentProgress is null || !string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal))
            {
                return;
            }

            _currentProgress = CreateProgress(
                sessionId,
                startedAt: _currentProgress.StartedAt,
                status: status,
                isRunning: isRunning,
                success: success,
                stage: stage.Stage,
                detail: stage.Detail,
                canCancel: stage.CanCancel,
                cancelUnavailableReason: stage.CancelUnavailableReason,
                stepIndex: stage.StepIndex,
                stepCount: stage.StepCount,
                percentComplete: stage.PercentComplete);
        }

        logger.LogInformation(
            "Update session {SessionId} advanced to stage '{Stage}' ({PercentComplete}%).",
            sessionId,
            stage.Stage,
            stage.PercentComplete);
    }

    private void UpdateProgressDetail(string sessionId, string detail)
    {
        lock (_stateGate)
        {
            if (_currentProgress is null || !string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal))
            {
                return;
            }

            _currentProgress = CreateProgress(
                sessionId,
                startedAt: _currentProgress.StartedAt,
                status: _currentProgress.Status,
                isRunning: _currentProgress.IsRunning,
                success: _currentProgress.Success,
                stage: _currentProgress.Stage,
                detail: detail,
                canCancel: _currentProgress.CanCancel,
                cancelUnavailableReason: _currentProgress.CancelUnavailableReason,
                stepIndex: _currentProgress.StepIndex,
                stepCount: _currentProgress.StepCount,
                percentComplete: _currentProgress.PercentComplete);
        }
    }

    private void SetCancelledProgress(string sessionId)
    {
        lock (_stateGate)
        {
            if (_currentProgress is null || !string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal))
            {
                return;
            }

            _currentProgress = CreateProgress(
                sessionId,
                startedAt: _currentProgress.StartedAt,
                status: UpdateStatus.Cancelled,
                isRunning: false,
                success: false,
                stage: "Update cancelled.",
                detail: "The update was stopped before Flux Monitor replaced the installed files. The current version should still be available.",
                canCancel: false,
                cancelUnavailableReason: null,
                stepIndex: _currentProgress.StepIndex,
                stepCount: _currentProgress.StepCount,
                percentComplete: _currentProgress.PercentComplete);
        }

        logger.LogInformation("Update session {SessionId} was cancelled before the install point of no return.", sessionId);
    }

    private void SetFailedProgress(
        string sessionId,
        string title,
        string detail,
        FixedLineBuffer outputTail,
        FixedLineBuffer errorTail)
    {
        lock (_stateGate)
        {
            if (_currentProgress is null || !string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal))
            {
                return;
            }

            _currentProgress = CreateProgress(
                sessionId,
                startedAt: _currentProgress.StartedAt,
                status: UpdateStatus.Failed,
                isRunning: false,
                success: false,
                stage: title,
                detail: detail,
                canCancel: false,
                cancelUnavailableReason: null,
                stepIndex: _currentProgress.StepIndex,
                stepCount: _currentProgress.StepCount,
                percentComplete: _currentProgress.PercentComplete);
        }

        logger.LogWarning(
            "Update session {SessionId} ended in failure. Recent stdout: {Stdout} Recent stderr: {Stderr}",
            sessionId,
            outputTail.ToMultilineString(),
            errorTail.ToMultilineString());
    }

    private void SetCurrentInstallerProcess(string sessionId, Process process)
    {
        lock (_stateGate)
        {
            if (_currentProgress is null || !string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal))
            {
                process.Dispose();
                return;
            }

            _currentInstallerProcess = process;
        }
    }

    private void ClearInstallerState(string sessionId)
    {
        CancellationTokenSource? cancellationSource = null;
        Process? installerProcess = null;

        lock (_stateGate)
        {
            if (_currentProgress is not null && !string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal))
            {
                return;
            }

            installerProcess = _currentInstallerProcess;
            _currentInstallerProcess = null;

            cancellationSource = _updateCancellationSource;
            _updateCancellationSource = null;
            _cancelRequested = false;
        }

        installerProcess?.Dispose();
        cancellationSource?.Dispose();
    }

    private bool WasCancellationRequested(string sessionId)
    {
        lock (_stateGate)
        {
            return _currentProgress is not null
                && string.Equals(_currentProgress.SessionId, sessionId, StringComparison.Ordinal)
                && _cancelRequested;
        }
    }

    private static void TryKillInstallerProcess(Process? process)
    {
        if (process is null)
        {
            return;
        }

        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // The process already exited.
        }
        catch (Exception)
        {
            // Best effort. The runner will still observe the cancellation token.
        }
    }

    private UpdateProgress CreateProgress(
        string sessionId,
        DateTimeOffset startedAt,
        string status,
        bool isRunning,
        bool? success,
        string stage,
        string detail,
        bool canCancel,
        string? cancelUnavailableReason,
        int? stepIndex,
        int? stepCount,
        int? percentComplete)
    {
        return new UpdateProgress
        {
            SessionId = sessionId,
            Status = status,
            IsRunning = isRunning,
            Success = success,
            Stage = stage,
            Detail = detail,
            CanCancel = canCancel,
            CancelUnavailableReason = cancelUnavailableReason,
            StepIndex = stepIndex,
            StepCount = stepCount,
            PercentComplete = percentComplete,
            StartedAt = startedAt,
            UpdatedAt = DateTimeOffset.UtcNow
        };
    }

    private string? GetLocalChecksum()
    {
        var installRoot = GetInstallRoot();
        if (installRoot is null)
        {
            return null;
        }

        var releaseInfoPath = Path.Combine(Directory.GetParent(installRoot)?.FullName ?? installRoot, "release-info.env");
        if (!File.Exists(releaseInfoPath))
        {
            return null;
        }

        return ParseReleaseChecksum(File.ReadLines(releaseInfoPath));
    }

    internal static bool TryGetStageDefinition(string installerSection, out UpdateStageDefinition stage)
    {
        return InstallerStageMap.TryGetValue(installerSection, out stage!);
    }

    internal static string CreateFriendlyFailureDetail(IEnumerable<string> stdoutLines, IEnumerable<string> stderrLines)
    {
        var combinedLines = stdoutLines
            .Concat(stderrLines)
            .Select(line => line.Trim())
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .ToList();

        if (combinedLines.Any(line =>
                line.Contains("Could not resolve host", StringComparison.OrdinalIgnoreCase)
                || line.Contains("unable to resolve host", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Temporary failure in name resolution", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Network is unreachable", StringComparison.OrdinalIgnoreCase)
                || line.Contains("No route to host", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Connection timed out", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Failed to connect", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Name or service not known", StringComparison.OrdinalIgnoreCase)))
        {
            return "Flux Monitor could not reach GitHub to download the update. Check the device internet connection and try again.";
        }

        if (combinedLines.Any(line =>
                line.Contains("checksum mismatch", StringComparison.OrdinalIgnoreCase)
                || line.Contains("did not contain a valid SHA-256 value", StringComparison.OrdinalIgnoreCase)))
        {
            return "The downloaded package did not pass verification, so the update was stopped before it was installed.";
        }

        if (combinedLines.Any(line =>
                line.Contains("No compatible ASP.NET Core 10 runtime was found", StringComparison.OrdinalIgnoreCase)
                || line.Contains("An ASP.NET Core 10 runtime is required", StringComparison.OrdinalIgnoreCase)))
        {
            return "This device is missing the ASP.NET Core runtime required by the published build.";
        }

        if (combinedLines.Any(line =>
                line.Contains("health endpoint did not become ready in time", StringComparison.OrdinalIgnoreCase)
                || line.Contains("did not come back online", StringComparison.OrdinalIgnoreCase)))
        {
            return "The update finished installing, but Flux Monitor did not come back online in time. Check the service logs before trying again.";
        }

        var recentLine = combinedLines.LastOrDefault(line =>
            !TryGetStageDefinition(line, out _)
            && !InstallerDetailOverrides.ContainsKey(line)
            && !line.StartsWith("Repository:", StringComparison.OrdinalIgnoreCase)
            && !line.StartsWith("Release tag:", StringComparison.OrdinalIgnoreCase)
            && !line.StartsWith("Destination:", StringComparison.OrdinalIgnoreCase));

        return recentLine is not null
            ? $"Flux Monitor could not finish the update. {recentLine}"
            : "Flux Monitor could not finish the update. Check the application logs for more detail.";
    }

    private static string? ParseReleaseChecksum(IEnumerable<string> lines)
    {
        foreach (var line in lines)
        {
            if (TryParseReleaseInfoValue(line, "FLUXMONITOR_RELEASE_SHA256", out var checksum))
            {
                return checksum;
            }
        }

        return null;
    }

    private static bool TryParseReleaseInfoValue(string line, string key, out string? value)
    {
        var prefix = key + "=";
        if (line.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            value = line[prefix.Length..].Trim().Trim('"', '\'');
            return !string.IsNullOrWhiteSpace(value);
        }

        value = null;
        return false;
    }

    private string? GetInstallRoot()
    {
        return Path.GetDirectoryName(typeof(Program).Assembly.Location);
    }
}

public sealed class UpdateCheckResult
{
    public string? CurrentReleaseTag { get; set; }
    public string? CurrentSourceRevision { get; set; }
    public string? CurrentBuiltAt { get; set; }
    public bool CanUpdate { get; set; }
    public string? Reason { get; set; }
    public bool UpdateAvailable { get; set; }
    public string? RemoteReleasePublishedAt { get; set; }
    public string? RemoteChecksum { get; set; }
    public string? LocalChecksum { get; set; }
    public string? CheckError { get; set; }
    public List<CommitInfo>? Commits { get; set; }
}

public sealed class CommitInfo
{
    public string? Sha { get; set; }
    public string? Message { get; set; }
    public string? Date { get; set; }
}

public sealed class UpdateProgress
{
    public string SessionId { get; set; } = "";
    public string Status { get; set; } = UpdateStatus.Running;
    public bool IsRunning { get; set; }
    public string Stage { get; set; } = "";
    public string Detail { get; set; } = "";
    public bool? Success { get; set; }
    public bool CanCancel { get; set; }
    public string? CancelUnavailableReason { get; set; }
    public int? StepIndex { get; set; }
    public int? StepCount { get; set; }
    public int? PercentComplete { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

public sealed class UpdateCommandResult
{
    public bool Succeeded { get; init; }
    public string? Error { get; init; }
    public UpdateProgress? Progress { get; init; }

    public static UpdateCommandResult Ok(UpdateProgress? progress) => new()
    {
        Succeeded = true,
        Progress = progress
    };

    public static UpdateCommandResult Fail(string error, UpdateProgress? progress = null) => new()
    {
        Succeeded = false,
        Error = error,
        Progress = progress
    };
}

internal sealed record UpdateStageDefinition(
    string? InstallerSection,
    string Stage,
    string Detail,
    int? StepIndex,
    int? StepCount,
    int? PercentComplete,
    bool CanCancel,
    string? CancelUnavailableReason);

internal static class UpdateStatus
{
    public const string Running = "running";
    public const string Cancelling = "cancelling";
    public const string Restarting = "restarting";
    public const string Cancelled = "cancelled";
    public const string Failed = "failed";
    public const string Succeeded = "succeeded";
}

internal sealed class FixedLineBuffer(int capacity) : IEnumerable<string>
{
    private readonly Queue<string> _lines = new();

    public void Add(string line)
    {
        if (_lines.Count == capacity)
        {
            _lines.Dequeue();
        }

        _lines.Enqueue(line);
    }

    public string ToMultilineString()
    {
        return _lines.Count == 0
            ? "(no output)"
            : string.Join(Environment.NewLine, _lines);
    }

    public IEnumerator<string> GetEnumerator() => _lines.GetEnumerator();

    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
}

file sealed class GitHubRelease
{
    [JsonPropertyName("tag_name")]
    public string? TagName { get; set; }

    [JsonPropertyName("published_at")]
    public string? PublishedAt { get; set; }

    [JsonPropertyName("assets")]
    public List<GitHubAsset>? Assets { get; set; }
}

file sealed class GitHubAsset
{
    [JsonPropertyName("name")]
    public string? Name { get; set; }

    [JsonPropertyName("browser_download_url")]
    public string? BrowserDownloadUrl { get; set; }

    [JsonPropertyName("size")]
    public long Size { get; set; }

    [JsonPropertyName("updated_at")]
    public string? UpdatedAt { get; set; }
}

file sealed class GitHubComparison
{
    [JsonPropertyName("commits")]
    public List<GitHubCommit>? Commits { get; set; }
}

file sealed class GitHubCommit
{
    [JsonPropertyName("sha")]
    public string? Sha { get; set; }

    [JsonPropertyName("commit")]
    public GitHubCommitDetail? Commit { get; set; }
}

file sealed class GitHubCommitDetail
{
    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("author")]
    public GitHubCommitAuthor? Author { get; set; }
}

file sealed class GitHubCommitAuthor
{
    [JsonPropertyName("date")]
    public string? Date { get; set; }
}
