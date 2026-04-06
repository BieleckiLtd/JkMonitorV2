using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace FluxMonitor.Backend.Services;

public sealed class SystemUpdateService(
    IHttpClientFactory httpClientFactory,
    IBuildMetadataProvider buildMetadataProvider,
    ISoftwareUpdateStore softwareUpdateStore,
    ManagedRestartService managedRestartService,
    IHostApplicationLifetime applicationLifetime,
    UpdateProgressBroadcaster updateProgressBroadcaster,
    ILogger<SystemUpdateService> logger)
{
    private const string Repository = "BieleckiLtd/JkMonitorV2";
    private const string AssetName = "fluxmonitor-backend-linux-arm64.tar.gz";
    private const string ChecksumAssetName = AssetName + ".sha256";
    private const string ReleaseApiBaseUrl = $"https://api.github.com/repos/{Repository}/releases";
    private const int InstallerOutputTailCapacity = 120;

    private static readonly UpdateStageDefinition StartingStage = new(
        InstallerSection: null,
        Stage: "Preparing update…",
        Detail: "Flux Monitor is getting the installer ready.",
        StepIndex: 0,
        StepCount: 11,
        PercentComplete: 3,
        CanCancel: true,
        CancelUnavailableReason: null);

    private static readonly UpdateStageDefinition CancellingStage = new(
        InstallerSection: null,
        Stage: "Cancelling update…",
        Detail: "Stopping the updater before the installed files are replaced.",
        StepIndex: 2,
        StepCount: 11,
        PercentComplete: 20,
        CanCancel: false,
        CancelUnavailableReason: "Cancellation is already being processed.");

    private static readonly UpdateStageDefinition RestartingStage = new(
        InstallerSection: null,
        Stage: "Restarting Flux Monitor…",
        Detail: "Flux Monitor is restarting. The page will reload automatically when it is ready.",
        StepIndex: 11,
        StepCount: 11,
        PercentComplete: 100,
        CanCancel: false,
        CancelUnavailableReason: "Update is now being applied and can no longer be cancelled.");

    private static readonly IReadOnlyList<UpdateStageDefinition> InstallerStages =
    [
        new(
            InstallerSection: "Flux Monitor release bootstrap",
            Stage: "Preparing update…",
            Detail: "Checking the published release and preparing the installer.",
            StepIndex: 1,
            StepCount: 11,
            PercentComplete: 8,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Downloading release artifact",
            Stage: "Downloading update…",
            Detail: "Downloading the published release package from GitHub. This can take a few minutes on slower links.",
            StepIndex: 2,
            StepCount: 11,
            PercentComplete: 18,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Verifying release artifact",
            Stage: "Verifying package…",
            Detail: "Checking that the downloaded package matches the published checksum before anything is replaced.",
            StepIndex: 3,
            StepCount: 11,
            PercentComplete: 30,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Extracting release artifact",
            Stage: "Unpacking update…",
            Detail: "Extracting the new release into a temporary folder.",
            StepIndex: 4,
            StepCount: 11,
            PercentComplete: 38,
            CanCancel: true,
            CancelUnavailableReason: null),
        new(
            InstallerSection: "Preparing installation folder",
            Stage: "Replacing installed files…",
            Detail: "Switching the app over to the new release and preserving your local configuration.",
            StepIndex: 5,
            StepCount: 11,
            PercentComplete: 50,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the installed files are being replaced."),
        new(
            InstallerSection: "Installing Cloudflare Tunnel connector",
            Stage: "Updating tunnel connector…",
            Detail: "Checking that the cloudflared package used for internet access is installed.",
            StepIndex: 6,
            StepCount: 11,
            PercentComplete: 61,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the installed files are being replaced."),
        new(
            InstallerSection: "Checking ASP.NET Core runtime",
            Stage: "Checking runtime…",
            Detail: "Making sure the required ASP.NET Core runtime is available on this device.",
            StepIndex: 7,
            StepCount: 11,
            PercentComplete: 70,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Installing local ASP.NET Core runtime",
            Stage: "Installing runtime…",
            Detail: "Installing the local ASP.NET Core runtime needed by the published build.",
            StepIndex: 8,
            StepCount: 11,
            PercentComplete: 78,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Configuring first run",
            Stage: "Applying configuration…",
            Detail: "Reapplying your saved runtime settings to the new installation.",
            StepIndex: 9,
            StepCount: 11,
            PercentComplete: 86,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Installing Cloudflare Tunnel service",
            Stage: "Checking tunnel service…",
            Detail: "Checking the managed cloudflared service and refreshing it only when the installed files changed.",
            StepIndex: 10,
            StepCount: 11,
            PercentComplete: 92,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because the new installation is being finalized."),
        new(
            InstallerSection: "Installing systemd service",
            Stage: "Updating service…",
            Detail: "Updating the system service so Flux Monitor starts the new version.",
            StepIndex: 11,
            StepCount: 11,
            PercentComplete: 96,
            CanCancel: false,
            CancelUnavailableReason: "Cancellation is no longer available because Flux Monitor is already switching to the new version."),
        new(
            InstallerSection: "Starting Flux Monitor",
            Stage: "Starting Flux Monitor…",
            Detail: "Starting the updated service and checking that it comes back online.",
            StepIndex: 11,
            StepCount: 11,
            PercentComplete: 99,
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

    public async Task<UpdateCheckResult> CheckForUpdateAsync(CancellationToken cancellationToken)
    {
        var result = await CreateBaseCheckResultAsync(cancellationToken);

        try
        {
            using var client = CreateGitHubClient();
            var releaseResolution = await ResolveReleaseAsync(client, result.PreferredChannel, cancellationToken);
            var release = releaseResolution.Release;

            result.CheckedAt = DateTimeOffset.UtcNow;
            result.TargetChannel = releaseResolution.Channel;
            result.TargetReleaseTag = release?.TagName ?? result.TargetReleaseTag;

            if (string.IsNullOrWhiteSpace(result.CurrentReleasePublishedAt))
            {
                var currentInstalledRelease = await ResolveCurrentInstalledReleaseAsync(client, result.CurrentReleaseTag, release, cancellationToken);
                result.CurrentReleasePublishedAt = currentInstalledRelease?.PublishedAt;
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
                        var compareTarget = ResolveCompareTarget(releaseResolution.Channel, release);
                        var compareUrl = $"https://api.github.com/repos/{Repository}/compare/{result.CurrentSourceRevision}...{compareTarget}";
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
            return UpdateProgressBroadcaster.Clone(_currentProgress);
        }
    }

    public async Task<UpdateChannelPreferenceResult> SavePreferredChannelAsync(string channel, CancellationToken cancellationToken)
    {
        var normalizedChannel = SoftwareUpdateChannels.NormalizeSelection(channel);
        await softwareUpdateStore.SavePreferredChannelAsync(normalizedChannel, cancellationToken);

        return new UpdateChannelPreferenceResult
        {
            PreferredChannel = normalizedChannel
        };
    }

    public async Task<UpdateCommandResult> StartUpdateAsync(CancellationToken cancellationToken)
    {
        if (!managedRestartService.IsManagedInstall || !OperatingSystem.IsLinux())
        {
            return UpdateCommandResult.Fail("In-app update is only available on managed Linux installs.");
        }

        var updateTarget = await ResolveUpdateTargetAsync(cancellationToken);
        if (!updateTarget.Succeeded)
        {
            return UpdateCommandResult.Fail(updateTarget.Error ?? "Flux Monitor could not determine which release to install.");
        }

        string sessionId;
        UpdateProgress progress;
        CancellationToken updateCancellationToken;

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
            updateCancellationToken = _updateCancellationSource.Token;
        }

        logger.LogInformation("Starting in-app update session {SessionId}.", sessionId);
        updateProgressBroadcaster.Publish(progress);
        _ = Task.Run(() => RunUpdateAsync(
            sessionId,
            updateTarget.ReleaseTag!,
            updateTarget.Channel!,
            updateTarget.InstallerScriptUrl!,
            updateTarget.ReleasePublishedAt,
            updateTarget.Checksum,
            updateCancellationToken));

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
        updateProgressBroadcaster.Publish(progress);

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

    private async Task RunUpdateAsync(
        string sessionId,
        string releaseTag,
        string releaseChannel,
        string installerScriptUrl,
        string? releasePublishedAt,
        string? releaseChecksum,
        CancellationToken cancellationToken)
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
                "Update session {SessionId} will install release {ReleaseTag} from channel {ReleaseChannel} into {Destination}.",
                sessionId,
                releaseTag,
                releaseChannel,
                destination);

            var psi = new ProcessStartInfo
            {
                FileName = "/bin/bash",
                Arguments = $"-c \"wget -qO- '{installerScriptUrl}' | bash -s -- https://github.com/{Repository} {releaseTag} '{destination}'\"",
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

            try
            {
                await softwareUpdateStore.RecordInstalledReleaseAsync(
                    new InstalledSoftwareUpdate
                    {
                        Channel = releaseChannel,
                        ReleaseTag = releaseTag,
                        PublishedAt = TryParseTimestamp(releasePublishedAt),
                        Checksum = releaseChecksum
                    },
                    CancellationToken.None);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Failed to record installed update metadata after session {SessionId}.", sessionId);
            }

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
        UpdateProgress? progress;

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

            progress = _currentProgress;
        }

        logger.LogInformation(
            "Update session {SessionId} advanced to stage '{Stage}' ({PercentComplete}%).",
            sessionId,
            stage.Stage,
            stage.PercentComplete);
        updateProgressBroadcaster.Publish(progress);
    }

    private void UpdateProgressDetail(string sessionId, string detail)
    {
        UpdateProgress? progress;

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

            progress = _currentProgress;
        }

        updateProgressBroadcaster.Publish(progress);
    }

    private void SetCancelledProgress(string sessionId)
    {
        UpdateProgress? progress;

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

            progress = _currentProgress;
        }

        logger.LogInformation("Update session {SessionId} was cancelled before the install point of no return.", sessionId);
        updateProgressBroadcaster.Publish(progress);
    }

    private void SetFailedProgress(
        string sessionId,
        string title,
        string detail,
        FixedLineBuffer outputTail,
        FixedLineBuffer errorTail)
    {
        UpdateProgress? progress;

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

            progress = _currentProgress;
        }

        logger.LogWarning(
            "Update session {SessionId} ended in failure. Recent stdout: {Stdout} Recent stderr: {Stderr}",
            sessionId,
            outputTail.ToMultilineString(),
            errorTail.ToMultilineString());
        updateProgressBroadcaster.Publish(progress);
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
                line.Contains("No space left on device", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Write error - write (28", StringComparison.OrdinalIgnoreCase)
                || line.Contains("ENOSPC", StringComparison.OrdinalIgnoreCase)))
        {
            return "The device ran out of free storage while applying the update. Free up disk space on the Raspberry Pi and try again.";
        }

        if (combinedLines.Any(line =>
                line.Contains("The package lists or status file could not be parsed or opened.", StringComparison.OrdinalIgnoreCase)
                || line.Contains("Some index files failed to download.", StringComparison.OrdinalIgnoreCase)
                || line.Contains("into data and signature failed", StringComparison.OrdinalIgnoreCase)))
        {
            return "The device package manager failed while Flux Monitor was updating system packages. This usually means the Raspberry Pi is out of space or apt is in a broken state. Free disk space, repair apt if needed, and try again.";
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

    private HttpClient CreateGitHubClient()
    {
        var client = httpClientFactory.CreateClient();
        client.DefaultRequestHeaders.Add("User-Agent", "FluxMonitor");
        client.DefaultRequestHeaders.Add("Accept", "application/vnd.github+json");
        return client;
    }

    private async Task<UpdateCheckResult> CreateBaseCheckResultAsync(CancellationToken cancellationToken)
    {
        var build = buildMetadataProvider.GetBuildInfo();
        var storedState = await softwareUpdateStore.GetStateAsync(cancellationToken);
        var installedState = storedState.Installed;
        var currentChannel = ResolveReleaseChannel(installedState.Channel ?? build.ReleaseTag);
        var preferredChannel = SoftwareUpdateChannels.NormalizeSelection(storedState.PreferredChannel);
        var currentReleaseTag = installedState.ReleaseTag ?? build.ReleaseTag;
        var currentBuiltAt = installedState.BuiltAt ?? build.BuiltAt;

        return new UpdateCheckResult
        {
            CurrentReleaseTag = currentReleaseTag,
            CurrentSourceRevision = installedState.SourceRevision ?? build.SourceRevisionId,
            CurrentBuiltAt = currentBuiltAt,
            CurrentWorkflowRunNumber = installedState.WorkflowRunNumber ?? build.WorkflowRunNumber,
            CurrentWorkflowRunAttempt = installedState.WorkflowRunAttempt ?? build.WorkflowRunAttempt,
            CurrentReleasePublishedAt = installedState.PublishedAt?.ToString("O") ?? currentBuiltAt,
            CurrentChannel = currentChannel,
            PreferredChannel = preferredChannel,
            TargetChannel = preferredChannel,
            TargetReleaseTag = GetDefaultTargetReleaseTag(preferredChannel, currentReleaseTag),
            CanUpdate = managedRestartService.IsManagedInstall && OperatingSystem.IsLinux(),
            Reason = managedRestartService.IsManagedInstall && OperatingSystem.IsLinux()
                ? null
                : "In-app update is only available on managed Linux installs."
        };
    }

    private async Task<ResolvedReleaseInfo> ResolveReleaseAsync(HttpClient client, string? channel, CancellationToken cancellationToken)
    {
        var normalizedChannel = ResolveReleaseChannel(channel);
        var releaseApiUrl = string.Equals(normalizedChannel, SoftwareUpdateChannels.Dev, StringComparison.OrdinalIgnoreCase)
            ? $"{ReleaseApiBaseUrl}/tags/{SoftwareUpdateChannels.DevReleaseTag}"
            : $"{ReleaseApiBaseUrl}/latest";

        var release = await client.GetFromJsonAsync<GitHubRelease>(releaseApiUrl, cancellationToken);
        return new ResolvedReleaseInfo(normalizedChannel, release);
    }

    private async Task<GitHubRelease?> ResolveCurrentInstalledReleaseAsync(
        HttpClient client,
        string? currentReleaseTag,
        GitHubRelease? targetRelease,
        CancellationToken cancellationToken)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(currentReleaseTag))
            {
                return null;
            }

            if (targetRelease is not null
                && string.Equals(targetRelease.TagName, currentReleaseTag, StringComparison.OrdinalIgnoreCase))
            {
                return targetRelease;
            }

            var releaseApiUrl = $"{ReleaseApiBaseUrl}/tags/{currentReleaseTag.Trim()}";
            return await client.GetFromJsonAsync<GitHubRelease>(releaseApiUrl, cancellationToken);
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Failed to resolve the current installed release metadata for tag {ReleaseTag}.", currentReleaseTag);
            return null;
        }
    }

    private async Task<UpdateTargetResolution> ResolveUpdateTargetAsync(CancellationToken cancellationToken)
    {
        try
        {
            var storedState = await softwareUpdateStore.GetStateAsync(cancellationToken);
            var preferredChannel = SoftwareUpdateChannels.NormalizeSelection(storedState.PreferredChannel);
            using var client = CreateGitHubClient();
            var releaseResolution = await ResolveReleaseAsync(client, preferredChannel, cancellationToken);
            var releaseTag = releaseResolution.Release?.TagName;

            if (string.IsNullOrWhiteSpace(releaseTag))
            {
                return UpdateTargetResolution.Fail("Flux Monitor could not determine which published release to install.");
            }

            var checksumAsset = releaseResolution.Release?.Assets?.FirstOrDefault(a =>
                string.Equals(a.Name, ChecksumAssetName, StringComparison.OrdinalIgnoreCase));
            string? checksum = null;
            if (checksumAsset?.BrowserDownloadUrl is not null)
            {
                var checksumContent = await client.GetStringAsync(checksumAsset.BrowserDownloadUrl, cancellationToken);
                checksum = checksumContent.Split(' ', 2)[0].Trim();
            }

            return UpdateTargetResolution.Success(
                releaseResolution.Channel,
                releaseTag.Trim(),
                GetInstallerScriptUrl(releaseResolution.Channel),
                checksumAsset?.UpdatedAt ?? releaseResolution.Release?.PublishedAt,
                checksum);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Failed to resolve the update target release from GitHub.");
            return UpdateTargetResolution.Fail("Flux Monitor could not determine which published release to install. Check the device internet connection and try again.");
        }
    }

    private static string ResolveReleaseChannel(string? releaseTagOrChannel)
    {
        return SoftwareUpdateChannels.FromReleaseTag(releaseTagOrChannel);
    }

    private static string? GetDefaultTargetReleaseTag(string channel, string? currentReleaseTag)
    {
        return string.Equals(channel, SoftwareUpdateChannels.Dev, StringComparison.OrdinalIgnoreCase)
            ? SoftwareUpdateChannels.DevReleaseTag
            : currentReleaseTag;
    }

    private static string ResolveCompareTarget(string channel, GitHubRelease release)
    {
        if (string.Equals(channel, SoftwareUpdateChannels.Dev, StringComparison.OrdinalIgnoreCase))
        {
            return SoftwareUpdateChannels.Dev;
        }

        return !string.IsNullOrWhiteSpace(release.TagName)
            ? release.TagName
            : SoftwareUpdateChannels.Main;
    }

    private static string GetInstallerScriptUrl(string channel)
    {
        var scriptRef = string.Equals(channel, SoftwareUpdateChannels.Dev, StringComparison.OrdinalIgnoreCase)
            ? SoftwareUpdateChannels.Dev
            : SoftwareUpdateChannels.Main;

        return $"https://raw.githubusercontent.com/{Repository}/{scriptRef}/scripts/install-from-release.sh";
    }

    private static DateTimeOffset? TryParseTimestamp(string? value)
    {
        return DateTimeOffset.TryParse(value, out var parsed)
            ? parsed
            : null;
    }
}

internal sealed record ResolvedReleaseInfo(string Channel, GitHubRelease? Release);

internal sealed class UpdateTargetResolution
{
    public bool Succeeded { get; init; }
    public string? Error { get; init; }
    public string? Channel { get; init; }
    public string? ReleaseTag { get; init; }
    public string? InstallerScriptUrl { get; init; }
    public string? ReleasePublishedAt { get; init; }
    public string? Checksum { get; init; }

    public static UpdateTargetResolution Success(
        string channel,
        string releaseTag,
        string installerScriptUrl,
        string? releasePublishedAt,
        string? checksum) => new()
    {
        Succeeded = true,
        Channel = channel,
        ReleaseTag = releaseTag,
        InstallerScriptUrl = installerScriptUrl,
        ReleasePublishedAt = releasePublishedAt,
        Checksum = checksum
    };

    public static UpdateTargetResolution Fail(string error) => new()
    {
        Succeeded = false,
        Error = error
    };
}

public sealed class UpdateCheckResult
{
    public string? CurrentReleaseTag { get; set; }
    public string? CurrentSourceRevision { get; set; }
    public string? CurrentBuiltAt { get; set; }
    public string? CurrentWorkflowRunNumber { get; set; }
    public string? CurrentWorkflowRunAttempt { get; set; }
    public string? CurrentReleasePublishedAt { get; set; }
    public string? CurrentChannel { get; set; }
    public string? PreferredChannel { get; set; }
    public string? TargetChannel { get; set; }
    public string? TargetReleaseTag { get; set; }
    public DateTimeOffset? CheckedAt { get; set; }
    public bool CanUpdate { get; set; }
    public string? Reason { get; set; }
    public bool UpdateAvailable { get; set; }
    public string? RemoteReleasePublishedAt { get; set; }
    public string? RemoteChecksum { get; set; }
    public string? LocalChecksum { get; set; }
    public string? CheckError { get; set; }
    public List<CommitInfo>? Commits { get; set; }
}

public sealed class UpdateChannelPreferenceResult
{
    public string PreferredChannel { get; set; } = SoftwareUpdateChannels.Dev;
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

internal sealed class GitHubRelease
{
    [JsonPropertyName("tag_name")]
    public string? TagName { get; set; }

    [JsonPropertyName("published_at")]
    public string? PublishedAt { get; set; }

    [JsonPropertyName("assets")]
    public List<GitHubAsset>? Assets { get; set; }
}

internal sealed class GitHubAsset
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

internal sealed class GitHubComparison
{
    [JsonPropertyName("commits")]
    public List<GitHubCommit>? Commits { get; set; }
}

internal sealed class GitHubCommit
{
    [JsonPropertyName("sha")]
    public string? Sha { get; set; }

    [JsonPropertyName("commit")]
    public GitHubCommitDetail? Commit { get; set; }
}

internal sealed class GitHubCommitDetail
{
    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("author")]
    public GitHubCommitAuthor? Author { get; set; }
}

internal sealed class GitHubCommitAuthor
{
    [JsonPropertyName("date")]
    public string? Date { get; set; }
}
