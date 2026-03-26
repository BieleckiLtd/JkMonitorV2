using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace JkMonitor.Backend.Services;

public sealed class SystemUpdateService(
    IHttpClientFactory httpClientFactory,
    IBuildMetadataProvider buildMetadataProvider,
    ManagedRestartService managedRestartService,
    IHostApplicationLifetime applicationLifetime,
    ILogger<SystemUpdateService> logger)
{
    private const string Repository = "BieleckiLtd/JkMonitorV2";
    private const string ReleaseTag = "dev-latest";
    private const string AssetName = "jkmonitor-backend-linux-arm64.tar.gz";
    private const string ChecksumAssetName = AssetName + ".sha256";
    private const string InstallerScriptUrl = $"https://raw.githubusercontent.com/{Repository}/dev/scripts/install-from-release.sh";
    private const string ReleaseApiUrl = $"https://api.github.com/repos/{Repository}/releases/tags/{ReleaseTag}";

    private static readonly Dictionary<string, string> SectionProgressMap = new(StringComparer.OrdinalIgnoreCase)
    {
        ["JK Monitor release bootstrap"]         = "Starting installer…",
        ["Downloading release artifact"]          = "Downloading update…",
        ["Verifying release artifact"]            = "Verifying checksum…",
        ["Extracting release artifact"]           = "Extracting update…",
        ["Preparing installation folder"]         = "Preparing installation…",
        ["Checking ASP.NET Core runtime"]         = "Checking runtime…",
        ["Installing local ASP.NET Core runtime"] = "Installing runtime…",
        ["Configuring startup mode"]              = "Configuring application…",
        ["Installing systemd service"]            = "Installing service…",
        ["Starting JK Monitor"]                   = "Starting service…",
    };

    private UpdateProgress? _currentProgress;
    private readonly Lock _lock = new();

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
            client.DefaultRequestHeaders.Add("User-Agent", "JkMonitor");

            var release = await client.GetFromJsonAsync<GitHubRelease>(ReleaseApiUrl, cancellationToken);
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

                // Fetch commit list between installed and latest when update is available.
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
                    catch (Exception ex)
                    {
                        logger.LogDebug(ex, "Failed to fetch commit comparison from GitHub.");
                    }
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Failed to check for updates from GitHub.");
            result.CheckError = ex.Message;
        }

        return result;
    }

    public UpdateProgress? GetProgress()
    {
        lock (_lock) return _currentProgress;
    }

    public bool StartUpdate()
    {
        if (!managedRestartService.IsManagedInstall || !OperatingSystem.IsLinux())
        {
            return false;
        }

        lock (_lock)
        {
            if (_currentProgress is { IsRunning: true })
            {
                return false;
            }

            _currentProgress = new UpdateProgress { IsRunning = true, Stage = "Starting update…" };
        }

        _ = Task.Run(RunUpdateAsync);
        return true;
    }

    private async Task RunUpdateAsync()
    {
        try
        {
            SetProgress("Starting update…");

            var installRoot = GetInstallRoot();
            if (installRoot is null)
            {
                SetProgress("Failed: cannot determine install root.", done: true, success: false);
                return;
            }

            var destination = Directory.GetParent(installRoot)?.FullName ?? installRoot;

            SetProgress("Downloading installer script…");

            var env = new Dictionary<string, string>
            {
                ["JKMONITOR_REUSE_EXISTING_CONFIGURATION"] = "yes",
                ["JKMONITOR_INSTALL_RUNTIME"] = "no",
                ["JKMONITOR_INSTALL_SERVICE"] = "yes"
            };

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

            foreach (var kv in env)
            {
                psi.Environment[kv.Key] = kv.Value;
            }

            using var process = Process.Start(psi);
            if (process is null)
            {
                SetProgress("Failed: could not start installer process.", done: true, success: false);
                return;
            }

            var outputLines = new List<string>();
            var errorLines = new List<string>();

            var stdoutTask = Task.Run(async () =>
            {
                string? line;
                while ((line = await process.StandardOutput.ReadLineAsync()) is not null)
                {
                    outputLines.Add(line);
                    var trimmed = line.Trim();
                    if (SectionProgressMap.TryGetValue(trimmed, out var friendlyMessage))
                    {
                        SetProgress(friendlyMessage);
                    }
                }
            });

            var stderrTask = Task.Run(async () =>
            {
                string? line;
                while ((line = await process.StandardError.ReadLineAsync()) is not null)
                {
                    errorLines.Add(line);
                }
            });

            await Task.WhenAll(stdoutTask, stderrTask);
            await process.WaitForExitAsync();

            var output = string.Join('\n', outputLines);
            var errors = string.Join('\n', errorLines);

            if (process.ExitCode != 0)
            {
                var lastLines = string.Join('\n', (output + "\n" + errors).Split('\n').TakeLast(5));
                logger.LogError("Update installer failed with exit code {ExitCode}. Output: {Output}", process.ExitCode, output + "\n" + errors);
                SetProgress($"Failed (exit code {process.ExitCode}): {lastLines}", done: true, success: false);
                return;
            }

            SetProgress("Update installed. Restarting service…", done: true, success: true);
            logger.LogInformation("Update installed successfully. Scheduling restart.");

            await Task.Delay(TimeSpan.FromSeconds(1));
            applicationLifetime.StopApplication();
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "In-app update failed.");
            SetProgress($"Failed: {ex.Message}", done: true, success: false);
        }
    }

    private void SetProgress(string stage, bool done = false, bool? success = null)
    {
        lock (_lock)
        {
            _currentProgress = new UpdateProgress
            {
                IsRunning = !done,
                Stage = stage,
                Success = success
            };
        }
    }

    private string? GetLocalChecksum()
    {
        var installRoot = GetInstallRoot();
        if (installRoot is null) return null;

        var releaseInfoPath = Path.Combine(Directory.GetParent(installRoot)?.FullName ?? installRoot, "release-info.env");
        if (!File.Exists(releaseInfoPath)) return null;

        return ParseReleaseChecksum(File.ReadLines(releaseInfoPath));
    }

    private static string? ParseReleaseChecksum(IEnumerable<string> lines)
    {
        foreach (var line in lines)
        {
            if (TryParseReleaseInfoValue(line, "JKMONITOR_RELEASE_SHA256", out var checksum) ||
                TryParseReleaseInfoValue(line, "RELEASE_SHA256", out checksum))
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
        var contentRoot = Path.GetDirectoryName(typeof(Program).Assembly.Location);
        if (contentRoot is null) return null;
        return contentRoot;
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
    public bool IsRunning { get; set; }
    public string Stage { get; set; } = "";
    public bool? Success { get; set; }
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
