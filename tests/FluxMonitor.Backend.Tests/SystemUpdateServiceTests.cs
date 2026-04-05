using System.Net;
using System.Net.Http;
using FluxMonitor.Backend.Services;
using FluxMonitor.Contracts.Status;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public class SystemUpdateServiceTests
{
    [Fact]
    public async Task CheckForUpdateAsync_UsesFluxMonitorChecksumKey()
    {
        using var releaseInfoScope = TemporaryReleaseInfoScope.Create(
            "FLUXMONITOR_RELEASE_SHA256=1111111111111111111111111111111111111111111111111111111111111111");

        var service = CreateService(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                if (request.RequestUri?.AbsoluteUri == "https://api.github.com/repos/BieleckiLtd/JkMonitorV2/releases/tags/dev-latest")
                {
                    return CreateJsonResponse("""
                        {
                          "published_at": "2026-03-25T10:00:00Z",
                          "assets": [
                            {
                              "name": "fluxmonitor-backend-linux-arm64.tar.gz.sha256",
                              "browser_download_url": "https://example.test/fluxmonitor-backend-linux-arm64.tar.gz.sha256"
                            }
                          ]
                        }
                        """);
                }

                if (request.RequestUri?.AbsoluteUri == "https://example.test/fluxmonitor-backend-linux-arm64.tar.gz.sha256")
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("2222222222222222222222222222222222222222222222222222222222222222  fluxmonitor-backend-linux-arm64.tar.gz")
                    };
                }

                return new HttpResponseMessage(HttpStatusCode.NotFound);
            })));

        var result = await service.CheckForUpdateAsync(CancellationToken.None);

        Assert.Equal("1111111111111111111111111111111111111111111111111111111111111111", result.LocalChecksum);
        Assert.Equal("2222222222222222222222222222222222222222222222222222222222222222", result.RemoteChecksum);
        Assert.True(result.UpdateAvailable);
        Assert.Null(result.CheckError);
        Assert.Equal("dev", result.CurrentChannel);
        Assert.Equal("dev", result.PreferredChannel);
        Assert.Equal("dev-latest", result.TargetReleaseTag);
        Assert.NotNull(result.CheckedAt);
    }

    [Fact]
    public async Task CheckForUpdateAsync_UsesLatestStableReleaseForMainChannel()
    {
        using var releaseInfoScope = TemporaryReleaseInfoScope.Create(
            "FLUXMONITOR_RELEASE_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

        var service = CreateService(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                if (request.RequestUri?.AbsoluteUri == "https://api.github.com/repos/BieleckiLtd/JkMonitorV2/releases/latest")
                {
                    return CreateJsonResponse("""
                        {
                          "tag_name": "v1.2.3",
                          "published_at": "2026-03-29T09:00:00Z",
                          "assets": [
                            {
                              "name": "fluxmonitor-backend-linux-arm64.tar.gz.sha256",
                              "browser_download_url": "https://example.test/stable.sha256"
                            }
                          ]
                        }
                        """);
                }

                if (request.RequestUri?.AbsoluteUri == "https://example.test/stable.sha256")
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  fluxmonitor-backend-linux-arm64.tar.gz")
                    };
                }

                return new HttpResponseMessage(HttpStatusCode.NotFound);
            })),
            new BuildRuntimeInfo
            {
                ReleaseTag = "v1.0.0",
                SourceRevisionId = "stable-local-sha"
            });

        var result = await service.CheckForUpdateAsync(CancellationToken.None);

        Assert.Equal("main", result.CurrentChannel);
        Assert.Equal("main", result.PreferredChannel);
        Assert.Equal("main", result.TargetChannel);
        Assert.Equal("v1.2.3", result.TargetReleaseTag);
        Assert.True(result.UpdateAvailable);
    }

    [Fact]
    public async Task CheckForUpdateAsync_UsesStoredInstalledPublishedDateForMutableDevReleaseTag()
    {
        using var releaseInfoScope = TemporaryReleaseInfoScope.Create(
            "FLUXMONITOR_RELEASE_SHA256=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");

        var service = CreateService(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                if (request.RequestUri?.AbsoluteUri == "https://api.github.com/repos/BieleckiLtd/JkMonitorV2/releases/tags/dev-latest")
                {
                    return CreateJsonResponse("""
                        {
                          "published_at": "2026-04-05T12:00:00Z",
                          "assets": [
                            {
                              "name": "fluxmonitor-backend-linux-arm64.tar.gz.sha256",
                              "browser_download_url": "https://example.test/dev.sha256"
                            }
                          ]
                        }
                        """);
                }

                if (request.RequestUri?.AbsoluteUri == "https://example.test/dev.sha256")
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd  fluxmonitor-backend-linux-arm64.tar.gz")
                    };
                }

                return new HttpResponseMessage(HttpStatusCode.NotFound);
            })),
            new BuildRuntimeInfo
            {
                ReleaseTag = "dev-latest",
                SourceRevisionId = "dev-current-sha",
                WorkflowRunNumber = "88",
                WorkflowRunAttempt = "1",
                BuiltAt = "2026-04-01T08:30:00Z"
            },
            new SoftwareUpdateState
            {
                StorageAvailable = true,
                PreferredChannel = "dev",
                Installed = new InstalledSoftwareUpdate
                {
                    Channel = "dev",
                    ReleaseTag = "dev-latest",
                    SourceRevision = "dev-current-sha",
                    WorkflowRunNumber = "88",
                    WorkflowRunAttempt = "1",
                    BuiltAt = "2026-04-01T08:30:00Z",
                    PublishedAt = DateTimeOffset.Parse("2026-04-01T08:30:00Z"),
                    Checksum = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                }
            });

        var result = await service.CheckForUpdateAsync(CancellationToken.None);

        Assert.Equal("2026-04-01T08:30:00.0000000+00:00", result.CurrentReleasePublishedAt);
        Assert.Equal("2026-04-05T12:00:00Z", result.RemoteReleasePublishedAt);
    }

    [Fact]
    public async Task CheckForUpdateAsync_UsesStoredPreferredChannelWhenCheckingForUpdates()
    {
        using var releaseInfoScope = TemporaryReleaseInfoScope.Create(
            "FLUXMONITOR_RELEASE_SHA256=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

        var service = CreateService(
            new StubHttpClientFactory(new StubHttpMessageHandler(request =>
            {
                if (request.RequestUri?.AbsoluteUri == "https://api.github.com/repos/BieleckiLtd/JkMonitorV2/releases/latest")
                {
                    return CreateJsonResponse("""
                        {
                          "tag_name": "v1.2.3",
                          "published_at": "2026-04-04T18:20:00Z",
                          "assets": [
                            {
                              "name": "fluxmonitor-backend-linux-arm64.tar.gz.sha256",
                              "browser_download_url": "https://example.test/stable.sha256"
                            }
                          ]
                        }
                        """);
                }

                if (request.RequestUri?.AbsoluteUri == "https://example.test/stable.sha256")
                {
                    return new HttpResponseMessage(HttpStatusCode.OK)
                    {
                        Content = new StringContent("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff  fluxmonitor-backend-linux-arm64.tar.gz")
                    };
                }

                return new HttpResponseMessage(HttpStatusCode.NotFound);
            })),
            new BuildRuntimeInfo
            {
                ReleaseTag = "dev-latest",
                SourceRevisionId = "dev-current-sha"
            },
            new SoftwareUpdateState
            {
                StorageAvailable = true,
                PreferredChannel = "main",
                Installed = new InstalledSoftwareUpdate
                {
                    Channel = "dev",
                    ReleaseTag = "dev-latest",
                    SourceRevision = "dev-current-sha",
                    PublishedAt = DateTimeOffset.Parse("2026-04-01T08:30:00Z"),
                    Checksum = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                }
            });

        var result = await service.CheckForUpdateAsync(CancellationToken.None);

        Assert.Equal("dev", result.CurrentChannel);
        Assert.Equal("main", result.PreferredChannel);
        Assert.Equal("main", result.TargetChannel);
        Assert.Equal("v1.2.3", result.TargetReleaseTag);
    }

    [Fact]
    public void TryGetStageDefinition_TracksSafeCancellationWindow()
    {
        Assert.True(SystemUpdateService.TryGetStageDefinition("Downloading release artifact", out var downloadingStage));
        Assert.True(downloadingStage.CanCancel);
        Assert.Equal(2, downloadingStage.StepIndex);

        Assert.True(SystemUpdateService.TryGetStageDefinition("Preparing installation folder", out var prepareStage));
        Assert.False(prepareStage.CanCancel);
        Assert.Contains("installed files are being replaced", prepareStage.CancelUnavailableReason, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CreateFriendlyFailureDetail_ReportsConnectivityProblemsClearly()
    {
        var detail = SystemUpdateService.CreateFriendlyFailureDetail(
            ["Downloading release artifact"],
            ["wget: unable to resolve host address 'github.com'"]);

        Assert.Contains("could not reach GitHub", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CreateFriendlyFailureDetail_ReportsLowDiskProblemsClearly()
    {
        var detail = SystemUpdateService.CreateFriendlyFailureDetail(
            ["Installing internet speed test tool"],
            ["E: Write error - write (28: No space left on device)"]);

        Assert.Contains("ran out of free storage", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CreateFriendlyFailureDetail_ReportsAptStateProblemsClearly()
    {
        var detail = SystemUpdateService.CreateFriendlyFailureDetail(
            ["Installing internet speed test tool"],
            ["E: The package lists or status file could not be parsed or opened."]);

        Assert.Contains("package manager failed", detail, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CancelUpdate_WhenNoUpdateIsRunning_ReturnsFriendlyError()
    {
        var service = CreateService(new StubHttpClientFactory(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.NotFound))));

        var result = service.CancelUpdate();

        Assert.False(result.Succeeded);
        Assert.Equal("There is no update in progress.", result.Error);
    }

    private static SystemUpdateService CreateService(
        IHttpClientFactory httpClientFactory,
        BuildRuntimeInfo? buildInfo = null,
        SoftwareUpdateState? softwareUpdateState = null)
    {
        var environment = new TestHostEnvironment();
        var lifetime = new TestHostApplicationLifetime();
        var managedRestartService = new ManagedRestartService(
            environment,
            lifetime,
            NullLogger<ManagedRestartService>.Instance);
        var resolvedBuildInfo = buildInfo ?? new BuildRuntimeInfo
        {
            ReleaseTag = "dev-latest",
            SourceRevisionId = "local-sha"
        };
        var resolvedSoftwareUpdateState = softwareUpdateState ?? new SoftwareUpdateState
        {
            StorageAvailable = true,
            PreferredChannel = SoftwareUpdateChannels.FromReleaseTag(resolvedBuildInfo.ReleaseTag),
            Installed = new InstalledSoftwareUpdate
            {
                Channel = SoftwareUpdateChannels.FromReleaseTag(resolvedBuildInfo.ReleaseTag),
                ReleaseTag = resolvedBuildInfo.ReleaseTag,
                SourceRevision = resolvedBuildInfo.SourceRevisionId,
                WorkflowRunNumber = resolvedBuildInfo.WorkflowRunNumber,
                WorkflowRunAttempt = resolvedBuildInfo.WorkflowRunAttempt,
                BuiltAt = resolvedBuildInfo.BuiltAt,
                PublishedAt = DateTimeOffset.TryParse(resolvedBuildInfo.BuiltAt, out var publishedAt) ? publishedAt : null
            }
        };

        return new SystemUpdateService(
            httpClientFactory,
            new FakeBuildMetadataProvider(resolvedBuildInfo),
            new FakeSoftwareUpdateStore(resolvedSoftwareUpdateState),
            managedRestartService,
            lifetime,
            new UpdateProgressBroadcaster(),
            NullLogger<SystemUpdateService>.Instance);
    }

    private static HttpResponseMessage CreateJsonResponse(string json)
    {
        return new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(json)
        };
    }

    private sealed class FakeBuildMetadataProvider(BuildRuntimeInfo buildInfo) : IBuildMetadataProvider
    {
        public BuildRuntimeInfo GetBuildInfo() => buildInfo;
    }

    private sealed class FakeSoftwareUpdateStore(SoftwareUpdateState state) : ISoftwareUpdateStore
    {
        private SoftwareUpdateState _state = state;

        public Task InitializeAsync(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<SoftwareUpdateState> GetStateAsync(CancellationToken cancellationToken)
            => Task.FromResult(_state);

        public Task SavePreferredChannelAsync(string preferredChannel, CancellationToken cancellationToken)
        {
            _state = _state with { PreferredChannel = preferredChannel };
            return Task.CompletedTask;
        }

        public Task RecordInstalledReleaseAsync(InstalledSoftwareUpdate installedRelease, CancellationToken cancellationToken)
        {
            _state = _state with { Installed = installedRelease };
            return Task.CompletedTask;
        }

        public Task SyncCurrentBuildAsync(CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class TestHostEnvironment : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = "Test";
        public string ApplicationName { get; set; } = "FluxMonitor.Backend.Tests";
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TestHostApplicationLifetime : IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => CancellationToken.None;
        public CancellationToken ApplicationStopped => CancellationToken.None;

        public void StopApplication()
        {
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> responder) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            return Task.FromResult(responder(request));
        }
    }

    private sealed class TemporaryReleaseInfoScope : IDisposable
    {
        private readonly string _releaseInfoPath;
        private readonly string? _originalContent;
        private readonly bool _hadOriginalFile;

        private TemporaryReleaseInfoScope(string releaseInfoPath, string content)
        {
            _releaseInfoPath = releaseInfoPath;
            _hadOriginalFile = File.Exists(releaseInfoPath);
            _originalContent = _hadOriginalFile ? File.ReadAllText(releaseInfoPath) : null;

            Directory.CreateDirectory(Path.GetDirectoryName(releaseInfoPath)!);
            File.WriteAllText(releaseInfoPath, content + Environment.NewLine);
        }

        public static TemporaryReleaseInfoScope Create(string content)
        {
            var installRoot = Path.GetDirectoryName(typeof(SystemUpdateService).Assembly.Location)
                ?? throw new InvalidOperationException("Could not determine install root.");
            var releaseInfoPath = Path.Combine(Directory.GetParent(installRoot)?.FullName ?? installRoot, "release-info.env");
            return new TemporaryReleaseInfoScope(releaseInfoPath, content);
        }

        public void Dispose()
        {
            if (_hadOriginalFile)
            {
                File.WriteAllText(_releaseInfoPath, _originalContent ?? string.Empty);
                return;
            }

            if (File.Exists(_releaseInfoPath))
            {
                File.Delete(_releaseInfoPath);
            }
        }
    }
}
