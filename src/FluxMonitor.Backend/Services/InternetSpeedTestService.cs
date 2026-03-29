using System.Text.Json;
using System.Globalization;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class InternetSpeedTestService(
    ICommandRunner commandRunner,
    ILogger<InternetSpeedTestService> logger)
{
    private static readonly TimeSpan CommandAvailabilityCacheDuration = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan SpeedTestTimeout = TimeSpan.FromMinutes(3);
    private readonly Lock _stateLock = new();
    private InternetSpeedTestSnapshot _snapshot = BuildUnsupportedSnapshot(
        "Internet speed tests are supported on Linux hosts with speedtest-cli installed.");
    private bool? _commandAvailable;
    private DateTimeOffset? _lastAvailabilityCheckedAt;

    public async Task<InternetSpeedTestSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
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
            _snapshot = new InternetSpeedTestSnapshot
            {
                Supported = true,
                Status = "running",
                Backend = "speedtest-cli",
                CanStart = false,
                IsRunning = true,
                StatusMessage = "Internet speed test in progress. This can take up to a minute. Please wait for the full result.",
                StartedAt = startedAt,
                CompletedAt = null,
                LastUpdatedAt = startedAt,
                Result = _snapshot.Result
            };

            snapshotToReturn = _snapshot;
            shouldStart = true;
        }

        if (shouldStart)
        {
            _ = RunSpeedTestAsync(snapshotToReturn.StartedAt ?? DateTimeOffset.UtcNow);
        }

        return new InternetSpeedTestCommandResult
        {
            Success = true,
            Message = "Internet speed test started. This can take up to a minute. Please wait for the result.",
            Snapshot = snapshotToReturn
        };
    }

    internal async Task RunSpeedTestAsync(DateTimeOffset startedAt)
    {
        try
        {
            logger.LogInformation("Starting internet speed test via speedtest-cli.");

            using var timeoutCancellation = new CancellationTokenSource(SpeedTestTimeout);
            var result = await commandRunner.RunAsync(
                "speedtest-cli",
                ["--json", "--secure", "--no-pre-allocate", "--timeout", "15"],
                timeoutCancellation.Token);

            if (!result.Succeeded)
            {
                CompleteWithFailure(startedAt, BuildCommandFailureMessage(result));
                return;
            }

            InternetSpeedTestResult parsedResult;
            try
            {
                parsedResult = ParseResult(result.StandardOutput);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "speedtest-cli returned output that could not be parsed.");
                CompleteWithFailure(startedAt, "The internet speed test completed, but the device could not read the result.");
                return;
            }

            var completedAt = DateTimeOffset.UtcNow;
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
                    Result = parsedResult with
                    {
                        TestedAt = parsedResult.TestedAt ?? completedAt
                    }
                };
            }

            logger.LogInformation(
                "Internet speed test completed. DownloadBitsPerSecond={DownloadBitsPerSecond}, UploadBitsPerSecond={UploadBitsPerSecond}, PingMilliseconds={PingMilliseconds}",
                parsedResult.DownloadBitsPerSecond,
                parsedResult.UploadBitsPerSecond,
                parsedResult.PingMilliseconds);
        }
        catch (OperationCanceledException)
        {
            CompleteWithFailure(startedAt, "The internet speed test timed out before it could finish.");
        }
        catch (Exception exception)
        {
            logger.LogWarning(exception, "Internet speed test failed unexpectedly.");
            CompleteWithFailure(startedAt, "The internet speed test could not be completed on this device.");
        }
    }

    internal void CompleteWithFailure(DateTimeOffset startedAt, string message)
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
                Result = _snapshot.Result
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

    private static string BuildCommandFailureMessage(CommandResult result)
    {
        var output = string.IsNullOrWhiteSpace(result.StandardError)
            ? result.StandardOutput
            : result.StandardError;

        if (string.IsNullOrWhiteSpace(output))
        {
            return "The internet speed test could not be completed on this device.";
        }

        var message = output.Trim();

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
}
