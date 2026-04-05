using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class SshManagementServiceTests
{
    [Fact]
    public async Task GetSnapshotAsync_ParsesEnabledAndActiveState()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var commandRunner = new StubCommandRunner((fileName, arguments, _) =>
        {
            Assert.Equal("systemctl", fileName);
            Assert.Equal(
                ["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"],
                arguments);

            return Task.FromResult(new CommandResult(
                true,
                "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nResult=success\n",
                string.Empty,
                0));
        });

        var service = new SshManagementService(commandRunner, NullLogger<SshManagementService>.Instance, () => true);

        var snapshot = await service.GetSnapshotAsync(cancellationToken);

        Assert.True(snapshot.Supported);
        Assert.True(snapshot.Enabled);
        Assert.True(snapshot.Active);
        Assert.Equal("SSH is enabled and accepting remote terminal connections.", snapshot.StatusMessage);
        Assert.Equal("loaded", snapshot.ServiceLoadState);
        Assert.Equal("active", snapshot.ServiceActiveState);
        Assert.Equal("running", snapshot.ServiceSubState);
        Assert.Equal("enabled", snapshot.ServiceUnitFileState);
    }

    [Fact]
    public async Task SetEnabledAsync_UsesEnableNowCommand()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var calls = new List<IReadOnlyList<string>>();
        var showCallCount = 0;

        var commandRunner = new StubCommandRunner((_, arguments, _) =>
        {
            calls.Add(arguments.ToArray());

            if (arguments[0] == "show")
            {
                showCallCount++;
                return Task.FromResult(new CommandResult(
                    true,
                    showCallCount == 1
                        ? "LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nResult=success\n"
                        : "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nResult=success\n",
                    string.Empty,
                    0));
            }

            return Task.FromResult(new CommandResult(true, string.Empty, string.Empty, 0));
        });

        var service = new SshManagementService(commandRunner, NullLogger<SshManagementService>.Instance, () => true);

        var result = await service.SetEnabledAsync(enabled: true, cancellationToken);

        Assert.True(result.Success);
        Assert.True(result.Enabled);
        Assert.True(result.Active);
        Assert.Equal("SSH was enabled.", result.Message);
        Assert.Collection(
            calls,
            call => Assert.Equal(["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"], call),
            call => Assert.Equal(["enable", "--now", "ssh"], call),
            call => Assert.Equal(["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"], call));
    }

    [Fact]
    public async Task SetEnabledAsync_UsesDisableNowCommand()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var calls = new List<IReadOnlyList<string>>();
        var showCallCount = 0;

        var commandRunner = new StubCommandRunner((_, arguments, _) =>
        {
            calls.Add(arguments.ToArray());

            if (arguments[0] == "show")
            {
                showCallCount++;
                return Task.FromResult(new CommandResult(
                    true,
                    showCallCount == 1
                        ? "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nResult=success\n"
                        : "LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nResult=success\n",
                    string.Empty,
                    0));
            }

            return Task.FromResult(new CommandResult(true, string.Empty, string.Empty, 0));
        });

        var service = new SshManagementService(commandRunner, NullLogger<SshManagementService>.Instance, () => true);

        var result = await service.SetEnabledAsync(enabled: false, cancellationToken);

        Assert.True(result.Success);
        Assert.False(result.Enabled);
        Assert.False(result.Active);
        Assert.Equal("SSH was disabled.", result.Message);
        Assert.Collection(
            calls,
            call => Assert.Equal(["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"], call),
            call => Assert.Equal(["disable", "--now", "ssh"], call),
            call => Assert.Equal(["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"], call));
    }

    [Fact]
    public async Task SetEnabledAsync_RetriesThroughSudoAfterAuthorizationFailure()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var calls = new List<(string FileName, IReadOnlyList<string> Arguments)>();
        var showCallCount = 0;

        var commandRunner = new StubCommandRunner((fileName, arguments, _) =>
        {
            calls.Add((fileName, arguments.ToArray()));

            if (fileName == "systemctl" && arguments[0] == "show")
            {
                showCallCount++;
                return Task.FromResult(new CommandResult(
                    true,
                    showCallCount == 1
                        ? "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nResult=success\n"
                        : "LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nResult=success\n",
                    string.Empty,
                    0));
            }

            if (fileName == "systemctl" && arguments[0] == "disable")
            {
                return Task.FromResult(new CommandResult(
                    false,
                    string.Empty,
                    "Interactive authentication required.",
                    1));
            }

            if (fileName == "sudo")
            {
                return Task.FromResult(new CommandResult(true, string.Empty, string.Empty, 0));
            }

            throw new InvalidOperationException($"Unexpected command: {fileName} {string.Join(' ', arguments)}");
        });

        var service = new SshManagementService(commandRunner, NullLogger<SshManagementService>.Instance, () => true);

        var result = await service.SetEnabledAsync(enabled: false, cancellationToken);

        Assert.True(result.Success);
        Assert.False(result.Enabled);
        Assert.False(result.Active);
        Assert.Equal("SSH was disabled.", result.Message);
        Assert.Collection(
            calls,
            call =>
            {
                Assert.Equal("systemctl", call.FileName);
                Assert.Equal(["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"], call.Arguments);
            },
            call =>
            {
                Assert.Equal("systemctl", call.FileName);
                Assert.Equal(["disable", "--now", "ssh"], call.Arguments);
            },
            call =>
            {
                Assert.Equal("sudo", call.FileName);
                Assert.Equal(["-n", "systemctl", "disable", "--now", "ssh"], call.Arguments);
            },
            call =>
            {
                Assert.Equal("systemctl", call.FileName);
                Assert.Equal(["show", "ssh", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=SubState", "--property=UnitFileState", "--property=Result"], call.Arguments);
            });
    }

    [Theory]
    [InlineData("Interactive authentication required.", true)]
    [InlineData("Failed to disable unit: Access denied", true)]
    [InlineData("update-rc.d: error: Permission denied", true)]
    [InlineData("Unit ssh.service could not be found.", false)]
    public void ShouldRetrySystemctlWithSudo_DetectsAuthorizationFailures(string message, bool expected)
    {
        var result = new CommandResult(false, string.Empty, message, 1);

        Assert.Equal(expected, SshManagementService.ShouldRetrySystemctlWithSudo(result));
    }

    [Theory]
    [InlineData("sudo: a password is required", true)]
    [InlineData("sudo: sorry, you must have a tty to run sudo", true)]
    [InlineData("sudo: a terminal is required to read the password", true)]
    [InlineData("Permission denied", false)]
    public void IsSudoPasswordPromptResult_DetectsPasswordPromptFailures(string message, bool expected)
    {
        var result = new CommandResult(false, string.Empty, message, 1);

        Assert.Equal(expected, SshManagementService.IsSudoPasswordPromptResult(result));
    }

    private sealed class StubCommandRunner(
        Func<string, IReadOnlyList<string>, CancellationToken, Task<CommandResult>> runAsync) : ICommandRunner
    {
        public Task<CommandResult> RunAsync(string fileName, IReadOnlyList<string> arguments, CancellationToken cancellationToken)
        {
            return runAsync(fileName, arguments, cancellationToken);
        }

        public Task<CommandResult> RunStreamingAsync(
            string fileName,
            IReadOnlyList<string> arguments,
            Func<CommandOutputLine, ValueTask>? onOutput,
            CancellationToken cancellationToken)
        {
            return Task.FromResult(new CommandResult(true, string.Empty, string.Empty, 0));
        }
    }
}
