using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class InternetSpeedTestService(
    ICommandRunner commandRunner,
    IInternetSpeedTestStore internetSpeedTestStore,
    ILogger<InternetSpeedTestService> logger)
{
    private static readonly TimeSpan CommandAvailabilityCacheDuration = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan SpeedTestTimeout = TimeSpan.FromMinutes(3);
    private const int ProgressStepCount = 3;
    private static readonly JsonSerializerOptions ProgressSerializerOptions = new(JsonSerializerDefaults.Web);
    private readonly Lock _stateLock = new();
    private readonly SemaphoreSlim _latestResultInitializationLock = new(1, 1);
    private InternetSpeedTestSnapshot _snapshot = BuildUnsupportedSnapshot(
        "Internet speed tests are supported on Linux hosts with speedtest-cli installed.");
    private bool? _commandAvailable;
    private DateTimeOffset? _lastAvailabilityCheckedAt;
    private volatile bool _latestResultLoaded;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await internetSpeedTestStore.InitializeAsync(cancellationToken);
        await EnsureLatestResultLoadedAsync(cancellationToken);
    }

    public async Task<InternetSpeedTestSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        await EnsureLatestResultLoadedAsync(cancellationToken);

        lock (_stateLock)
        {
            if (_snapshot.IsRunning
                || string.Equals(_snapshot.Status, "succeeded", StringComparison.OrdinalIgnoreCase)
                || string.Equals(_snapshot.Status, "failed", StringComparison.OrdinalIgnoreCase))
            {
                return _snapshot;
            }
        }

        var capability = await ResolveCapabilityAsync(cancellationToken);

        lock (_stateLock)
        {
            if (!capability.Supported)
            {
                _snapshot = BuildUnsupportedSnapshot(capability.Message);
            }
            else if (!string.Equals(_snapshot.Status, "succeeded", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(_snapshot.Status, "failed", StringComparison.OrdinalIgnoreCase))
            {
                _snapshot = BuildIdleSnapshot(_snapshot.Result, _snapshot.CompletedAt);
            }

            return _snapshot;
        }
    }

    public async Task<InternetSpeedTestCommandResult> StartAsync(CancellationToken cancellationToken = default)
    {
        await EnsureLatestResultLoadedAsync(cancellationToken);

        var capability = await ResolveCapabilityAsync(cancellationToken);
        if (!capability.Supported)
        {
            var unsupportedSnapshot = BuildUnsupportedSnapshot(capability.Message);

            lock (_stateLock)
            {
                if (!_snapshot.IsRunning)
                {
                    _snapshot = unsupportedSnapshot;
                }

                return new InternetSpeedTestCommandResult
                {
                    Success = false,
                    Message = capability.Message,
                    Snapshot = _snapshot
                };
            }
        }

        InternetSpeedTestSnapshot snapshotToReturn;
        var shouldStart = false;
        InternetSpeedTestResult? previousResult = null;

        lock (_stateLock)
        {
            if (_snapshot.IsRunning)
            {
                return new InternetSpeedTestCommandResult
                {
                    Success = true,
                    Message = _snapshot.StatusMessage ?? "An internet speed test is already running.",
                    Snapshot = _snapshot
                };
            }

            var startedAt = DateTimeOffset.UtcNow;
            previousResult = _snapshot.Result;
            _snapshot = BuildRunningSnapshot(
                startedAt,
                null,
                "Loading speed test configuration.",
                stage: "ping",
                stepIndex: 1,
                stagePercentComplete: 0,
                percentComplete: 0);

            snapshotToReturn = _snapshot;
            shouldStart = true;
        }

        if (shouldStart)
        {
            _ = RunSpeedTestAsync(snapshotToReturn.StartedAt ?? DateTimeOffset.UtcNow, previousResult);
        }

        return new InternetSpeedTestCommandResult
        {
            Success = true,
            Message = "Internet speed test started. The dials will update as ping, download, and upload progress.",
            Snapshot = snapshotToReturn
        };
    }

    internal async Task RunSpeedTestAsync(DateTimeOffset startedAt, InternetSpeedTestResult? fallbackResult = null)
    {
        try
        {
            logger.LogInformation("Starting internet speed test via speedtest-cli.");

            using var timeoutCancellation = new CancellationTokenSource(SpeedTestTimeout);
            InternetSpeedTestResult? latestProgressResult = null;
            var result = await commandRunner.RunStreamingAsync(
                "python3",
                BuildSpeedTestHelperArguments(),
                async outputLine =>
                {
                    if (TryParseProgressEvent(outputLine.Line, out var progressEvent))
                    {
                        if (progressEvent.Result is JsonElement { ValueKind: JsonValueKind.Object } progressResult)
                        {
                            latestProgressResult = ParseResult(progressResult.GetRawText());
                        }

                        UpdateProgressSnapshot(
                            startedAt,
                            progressEvent,
                            latestProgressResult,
                            fallbackResult);
                    }

                    await ValueTask.CompletedTask;
                },
                timeoutCancellation.Token);

            if (!result.Succeeded)
            {
                CompleteWithFailure(startedAt, BuildCommandFailureMessage(result), fallbackResult);
                return;
            }

            if (latestProgressResult is null)
            {
                logger.LogWarning("speedtest-cli completed without returning a structured result payload.");
                CompleteWithFailure(startedAt, "The internet speed test completed, but the device could not read the result.", fallbackResult);
                return;
            }

            var completedAt = DateTimeOffset.UtcNow;
            var persistedResult = latestProgressResult with
            {
                TestedAt = latestProgressResult.TestedAt ?? completedAt
            };

            try
            {
                await internetSpeedTestStore.SaveResultAsync(
                    persistedResult,
                    startedAt,
                    completedAt,
                    CancellationToken.None);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Internet speed test completed, but storing the result in PostgreSQL failed.");
            }

            lock (_stateLock)
            {
                _snapshot = new InternetSpeedTestSnapshot
                {
                    Supported = true,
                    Status = "succeeded",
                    Backend = "speedtest-cli",
                    CanStart = true,
                    IsRunning = false,
                    StatusMessage = "Internet speed test completed.",
                    StartedAt = startedAt,
                    CompletedAt = completedAt,
                    LastUpdatedAt = completedAt,
                    StepIndex = ProgressStepCount,
                    StepCount = ProgressStepCount,
                    StagePercentComplete = 100,
                    PercentComplete = 100,
                    Result = persistedResult
                };
            }

            logger.LogInformation(
                "Internet speed test completed. DownloadBitsPerSecond={DownloadBitsPerSecond}, UploadBitsPerSecond={UploadBitsPerSecond}, PingMilliseconds={PingMilliseconds}",
                latestProgressResult.DownloadBitsPerSecond,
                latestProgressResult.UploadBitsPerSecond,
                latestProgressResult.PingMilliseconds);
        }
        catch (OperationCanceledException)
        {
            CompleteWithFailure(startedAt, "The internet speed test timed out before it could finish.", fallbackResult);
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Internet speed test failed unexpectedly.");
            CompleteWithFailure(startedAt, "The internet speed test could not be completed on this device.", fallbackResult);
        }
    }

    private async Task EnsureLatestResultLoadedAsync(CancellationToken cancellationToken)
    {
        if (_latestResultLoaded)
        {
            return;
        }

        await _latestResultInitializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_latestResultLoaded)
            {
                return;
            }

            var latestRun = await internetSpeedTestStore.GetLatestResultAsync(cancellationToken);
            if (latestRun is not null)
            {
                lock (_stateLock)
                {
                    if (!_snapshot.IsRunning && _snapshot.Result is null)
                    {
                        _snapshot = new InternetSpeedTestSnapshot
                        {
                            Supported = true,
                            Status = "succeeded",
                            Backend = "speedtest-cli",
                            CanStart = true,
                            IsRunning = false,
                            StatusMessage = "Showing the latest stored internet speed test.",
                            StartedAt = latestRun.StartedAt,
                            CompletedAt = latestRun.CompletedAt,
                            LastUpdatedAt = latestRun.CompletedAt ?? latestRun.Result.TestedAt ?? DateTimeOffset.UtcNow,
                            Result = latestRun.Result
                        };
                    }
                }
            }

            _latestResultLoaded = true;
        }
        finally
        {
            _latestResultInitializationLock.Release();
        }
    }

    internal void CompleteWithFailure(DateTimeOffset startedAt, string message, InternetSpeedTestResult? fallbackResult = null)
    {
        logger.LogWarning("Internet speed test failed: {Message}", message);

        var completedAt = DateTimeOffset.UtcNow;

        lock (_stateLock)
        {
            _snapshot = new InternetSpeedTestSnapshot
            {
                Supported = true,
                Status = "failed",
                Backend = "speedtest-cli",
                CanStart = true,
                IsRunning = false,
                StatusMessage = message,
                StartedAt = startedAt,
                CompletedAt = completedAt,
                LastUpdatedAt = completedAt,
                Result = fallbackResult ?? _snapshot.Result
            };
        }
    }

    internal static InternetSpeedTestResult ParseResult(string payload)
    {
        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;

        var server = root.TryGetProperty("server", out var serverElement) && serverElement.ValueKind == JsonValueKind.Object
            ? new InternetSpeedTestServerSnapshot
            {
                Id = ReadString(serverElement, "id"),
                Sponsor = ReadString(serverElement, "sponsor"),
                Name = ReadString(serverElement, "name"),
                Country = ReadString(serverElement, "country"),
                DistanceKilometers = ReadDouble(serverElement, "d"),
                LatencyMilliseconds = ReadDouble(serverElement, "latency")
            }
            : null;

        var client = root.TryGetProperty("client", out var clientElement) && clientElement.ValueKind == JsonValueKind.Object
            ? new InternetSpeedTestClientSnapshot
            {
                IpAddress = ReadString(clientElement, "ip"),
                InternetServiceProvider = ReadString(clientElement, "isp"),
                Country = ReadString(clientElement, "country")
            }
            : null;

        return new InternetSpeedTestResult
        {
            DownloadBitsPerSecond = ReadDouble(root, "download"),
            UploadBitsPerSecond = ReadDouble(root, "upload"),
            PingMilliseconds = ReadDouble(root, "ping"),
            BytesReceived = ReadLong(root, "bytes_received"),
            BytesSent = ReadLong(root, "bytes_sent"),
            TestedAt = ReadDateTimeOffset(root, "timestamp"),
            ShareUrl = ReadString(root, "share"),
            Server = server,
            Client = client
        };
    }

    private async Task<(bool Supported, string Message)> ResolveCapabilityAsync(CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsLinux())
        {
            return (false, "Internet speed tests are supported on Linux hosts with speedtest-cli installed.");
        }

        var now = DateTimeOffset.UtcNow;
        if (_commandAvailable.HasValue
            && _lastAvailabilityCheckedAt.HasValue
            && now - _lastAvailabilityCheckedAt.Value < CommandAvailabilityCacheDuration)
        {
            return _commandAvailable.Value
                ? (true, "speedtest-cli is ready.")
                : (false, "speedtest-cli is not installed on this device yet. Run the installer or updater first.");
        }

        var versionResult = await commandRunner.RunAsync("speedtest-cli", ["--version"], cancellationToken);
        _commandAvailable = versionResult.Succeeded;
        _lastAvailabilityCheckedAt = now;

        if (_commandAvailable.Value)
        {
            return (true, "speedtest-cli is ready.");
        }

        logger.LogDebug(
            "speedtest-cli is unavailable. StdOut={StdOut} StdErr={StdErr}",
            versionResult.StandardOutput,
            versionResult.StandardError);

        return (false, "speedtest-cli is not installed on this device yet. Run the installer or updater first.");
    }

    private static InternetSpeedTestSnapshot BuildUnsupportedSnapshot(string message)
    {
        return new InternetSpeedTestSnapshot
        {
            Supported = false,
            Status = "unsupported",
            Backend = "speedtest-cli",
            CanStart = false,
            IsRunning = false,
            StatusMessage = message,
            LastUpdatedAt = DateTimeOffset.UtcNow
        };
    }

    private static InternetSpeedTestSnapshot BuildIdleSnapshot(InternetSpeedTestResult? previousResult, DateTimeOffset? completedAt)
    {
        return new InternetSpeedTestSnapshot
        {
            Supported = true,
            Status = previousResult is null ? "idle" : "succeeded",
            Backend = "speedtest-cli",
            CanStart = true,
            IsRunning = false,
            StatusMessage = previousResult is null
                ? "Run a speed test to measure the current internet connection on this device."
                : "Showing the latest completed internet speed test.",
            CompletedAt = completedAt,
            LastUpdatedAt = DateTimeOffset.UtcNow,
            Result = previousResult
        };
    }

    private static InternetSpeedTestSnapshot BuildRunningSnapshot(
        DateTimeOffset startedAt,
        InternetSpeedTestResult? result,
        string statusMessage,
        string stage,
        int stepIndex,
        int stagePercentComplete,
        int percentComplete)
    {
        return new InternetSpeedTestSnapshot
        {
            Supported = true,
            Status = "running",
            Backend = "speedtest-cli",
            CanStart = false,
            IsRunning = true,
            StatusMessage = statusMessage,
            StartedAt = startedAt,
            CompletedAt = null,
            LastUpdatedAt = DateTimeOffset.UtcNow,
            Stage = stage,
            StepIndex = stepIndex,
            StepCount = ProgressStepCount,
            StagePercentComplete = stagePercentComplete,
            PercentComplete = percentComplete,
            Result = result
        };
    }

    private static IReadOnlyList<string> BuildSpeedTestHelperArguments()
    {
        return
        [
            "-u",
            Path.Combine(AppContext.BaseDirectory, "tools", "speedtest_progress.py"),
            "--timeout",
            "15",
            "--secure",
            "--no-pre-allocate"
        ];
    }

    private void UpdateProgressSnapshot(
        DateTimeOffset startedAt,
        InternetSpeedTestProgressEvent progressEvent,
        InternetSpeedTestResult? progressResult,
        InternetSpeedTestResult? fallbackResult)
    {
        var stage = string.IsNullOrWhiteSpace(progressEvent.Stage) ? "ping" : progressEvent.Stage;
        var stepIndex = progressEvent.StepIndex ?? GetStepIndex(stage);
        var stagePercentComplete = ClampPercent(progressEvent.StagePercentComplete);
        var percentComplete = ClampPercent(progressEvent.PercentComplete);
        var statusMessage = string.IsNullOrWhiteSpace(progressEvent.StatusMessage)
            ? _snapshot.StatusMessage ?? "Internet speed test in progress."
            : progressEvent.StatusMessage;

        lock (_stateLock)
        {
            _snapshot = BuildRunningSnapshot(
                startedAt,
                progressResult ?? fallbackResult ?? _snapshot.Result,
                statusMessage,
                stage,
                stepIndex,
                stagePercentComplete,
                percentComplete);
        }
    }

    private static bool TryParseProgressEvent(string line, out InternetSpeedTestProgressEvent progressEvent)
    {
        progressEvent = default!;

        if (string.IsNullOrWhiteSpace(line) || !line.TrimStart().StartsWith('{'))
        {
            return false;
        }

        try
        {
            var parsedEvent = JsonSerializer.Deserialize<InternetSpeedTestProgressEvent>(line, ProgressSerializerOptions);
            if (parsedEvent is null)
            {
                return false;
            }

            progressEvent = parsedEvent;
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static int GetStepIndex(string? stage)
    {
        return stage?.ToLowerInvariant() switch
        {
            "download" => 2,
            "upload" => 3,
            _ => 1
        };
    }

    private static int ClampPercent(int? value)
    {
        if (!value.HasValue)
        {
            return 0;
        }

        return Math.Max(0, Math.Min(100, value.Value));
    }

    private static string BuildCommandFailureMessage(CommandResult result)
    {
        var output = string.IsNullOrWhiteSpace(result.StandardError)
            ? result.StandardOutput
            : result.StandardError;

        if (string.IsNullOrWhiteSpace(output))
        {
            return "The internet speed test could not be completed on this device.";
        }

        var message = output
            .Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .LastOrDefault()
            ?? output.Trim();

        if (message.StartsWith("ERROR: ", StringComparison.OrdinalIgnoreCase))
        {
            message = message["ERROR: ".Length..];
        }

        if (message.Contains("Cannot retrieve speedtest configuration", StringComparison.OrdinalIgnoreCase)
            || message.Contains("HTTP Error", StringComparison.OrdinalIgnoreCase)
            || message.Contains("URLError", StringComparison.OrdinalIgnoreCase))
        {
            return "The device could not reach the speed test service. Check internet access and try again.";
        }

        return message;
    }

    private static string? ReadString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => bool.TrueString,
            JsonValueKind.False => bool.FalseString,
            _ => null
        };
    }

    private static double? ReadDouble(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var numericValue))
        {
            return numericValue;
        }

        if (value.ValueKind == JsonValueKind.String
            && double.TryParse(value.GetString(), NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var parsedValue))
        {
            return parsedValue;
        }

        return null;
    }

    private static long? ReadLong(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var numericValue))
        {
            return numericValue;
        }

        if (value.ValueKind == JsonValueKind.String
            && long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsedValue))
        {
            return parsedValue;
        }

        return null;
    }

    private static DateTimeOffset? ReadDateTimeOffset(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return DateTimeOffset.TryParse(value.GetString(), out var parsedValue)
            ? parsedValue
            : null;
    }

    private sealed record class InternetSpeedTestProgressEvent
    {
        [JsonPropertyName("stage")]
        public string? Stage { get; init; }

        [JsonPropertyName("statusMessage")]
        public string? StatusMessage { get; init; }

        [JsonPropertyName("stepIndex")]
        public int? StepIndex { get; init; }

        [JsonPropertyName("stepCount")]
        public int? StepCount { get; init; }

        [JsonPropertyName("stagePercentComplete")]
        public int? StagePercentComplete { get; init; }

        [JsonPropertyName("percentComplete")]
        public int? PercentComplete { get; init; }

        [JsonPropertyName("result")]
        public JsonElement? Result { get; init; }
    }
}
