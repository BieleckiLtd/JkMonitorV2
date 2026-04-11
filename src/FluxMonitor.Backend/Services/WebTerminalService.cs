using System.Buffers;
using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using FluxMonitor.Backend.Models;

namespace FluxMonitor.Backend.Services;

public sealed class WebTerminalService
{
    private const int DefaultColumns = 120;
    private const int DefaultRows = 32;
    private const int MinColumns = 40;
    private const int MaxColumns = 240;
    private const int MinRows = 12;
    private const int MaxRows = 80;

    private readonly IWebTerminalAccessStore _store;
    private readonly ILogger<WebTerminalService> _logger;
    private readonly Func<bool> _isLinux;
    private readonly Func<string, string?> _resolveExecutableOnPath;
    private int _activeSessionCount;

    public WebTerminalService(
        IWebTerminalAccessStore store,
        ILogger<WebTerminalService> logger)
        : this(store, logger, OperatingSystem.IsLinux, ResolveExecutableOnPath)
    {
    }

    internal WebTerminalService(
        IWebTerminalAccessStore store,
        ILogger<WebTerminalService> logger,
        Func<bool> isLinux,
        Func<string, string?> resolveExecutableOnPath)
    {
        _store = store;
        _logger = logger;
        _isLinux = isLinux;
        _resolveExecutableOnPath = resolveExecutableOnPath;
    }

    public async Task<WebTerminalSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var settings = await _store.GetSettingsAsync(cancellationToken);
        var shellPath = ResolveShellPath();
        var scriptPath = ResolveScriptPath();
        var supported = _isLinux()
            && !string.IsNullOrWhiteSpace(shellPath)
            && !string.IsNullOrWhiteSpace(scriptPath);

        return new WebTerminalSnapshot
        {
            Supported = supported,
            Enabled = settings.Enabled,
            StorageAvailable = settings.StorageAvailable,
            ActiveSessionCount = Volatile.Read(ref _activeSessionCount),
            StatusMessage = BuildStatusMessage(supported, settings.Enabled),
            ShellPath = shellPath,
            Transport = supported ? "pty-via-script" : null
        };
    }

    public async Task<WebTerminalCommandResult> SetEnabledAsync(bool enabled, CancellationToken cancellationToken = default)
    {
        await _store.SaveSettingsAsync(enabled, cancellationToken);
        var snapshot = await GetSnapshotAsync(cancellationToken);

        return new WebTerminalCommandResult
        {
            Success = true,
            Enabled = snapshot.Enabled,
            Message = enabled
                ? "Web terminal access was enabled."
                : "Web terminal access was disabled.",
            Snapshot = snapshot
        };
    }

    public async Task<bool> AcceptSessionAsync(
        HttpContext httpContext,
        int? columns,
        int? rows,
        CancellationToken cancellationToken)
    {
        if (!httpContext.WebSockets.IsWebSocketRequest)
        {
            httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
            await httpContext.Response.WriteAsync("Expected a WebSocket request.", cancellationToken);
            return false;
        }

        var snapshot = await GetSnapshotAsync(cancellationToken);
        if (!snapshot.Enabled)
        {
            httpContext.Response.StatusCode = StatusCodes.Status403Forbidden;
            await httpContext.Response.WriteAsync("Web terminal access is disabled.", cancellationToken);
            return false;
        }

        if (!snapshot.Supported)
        {
            httpContext.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await httpContext.Response.WriteAsync(snapshot.StatusMessage ?? "Web terminal access is unavailable.", cancellationToken);
            return false;
        }

        var shellPath = snapshot.ShellPath ?? ResolveShellPath();
        var scriptPath = ResolveScriptPath();
        if (string.IsNullOrWhiteSpace(shellPath) || string.IsNullOrWhiteSpace(scriptPath))
        {
            httpContext.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            await httpContext.Response.WriteAsync("The web terminal runtime is unavailable on this host.", cancellationToken);
            return false;
        }

        using var webSocket = await httpContext.WebSockets.AcceptWebSocketAsync();
        var terminalColumns = Math.Clamp(columns ?? DefaultColumns, MinColumns, MaxColumns);
        var terminalRows = Math.Clamp(rows ?? DefaultRows, MinRows, MaxRows);

        await RunSessionAsync(webSocket, scriptPath, shellPath, terminalColumns, terminalRows, cancellationToken);
        return true;
    }

    private async Task RunSessionAsync(
        WebSocket webSocket,
        string scriptPath,
        string shellPath,
        int columns,
        int rows,
        CancellationToken cancellationToken)
    {
        using var process = CreateTerminalProcess(scriptPath, shellPath, columns, rows);
        try
        {
            process.Start();
        }
        catch (Exception exception)
        {
            _logger.LogError(exception, "Unable to start the web terminal shell.");
            if (webSocket.State == WebSocketState.Open)
            {
                await webSocket.CloseAsync(
                    WebSocketCloseStatus.InternalServerError,
                    "Unable to start the terminal shell.",
                    CancellationToken.None);
            }

            return;
        }

        Interlocked.Increment(ref _activeSessionCount);
        using var sendLock = new SemaphoreSlim(1, 1);

        try
        {
            var stdoutTask = PumpOutputAsync(process.StandardOutput, webSocket, sendLock, cancellationToken);
            var stderrTask = PumpOutputAsync(process.StandardError, webSocket, sendLock, cancellationToken);
            var inputTask = PumpInputAsync(webSocket, process.StandardInput, cancellationToken);

            await Task.WhenAny(inputTask, process.WaitForExitAsync(cancellationToken));

            if (!process.HasExited)
            {
                TryKillProcess(process);
            }

            try
            {
                await Task.WhenAll(stdoutTask, stderrTask);
            }
            catch (OperationCanceledException)
            {
                // Client disconnected or request ended.
            }

            if (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived)
            {
                await webSocket.CloseAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "Terminal session closed.",
                    CancellationToken.None);
            }
        }
        finally
        {
            Interlocked.Decrement(ref _activeSessionCount);
            TryKillProcess(process);
        }
    }

    private static Process CreateTerminalProcess(
        string scriptPath,
        string shellPath,
        int columns,
        int rows)
    {
        var process = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName = scriptPath,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            }
        };

        process.StartInfo.ArgumentList.Add("-q");
        process.StartInfo.ArgumentList.Add("-f");
        process.StartInfo.ArgumentList.Add("-c");
        process.StartInfo.ArgumentList.Add(
            $"export TERM=xterm-256color COLORTERM=truecolor COLUMNS={columns} LINES={rows}; stty rows {rows} cols {columns}; exec {shellPath} -i");
        process.StartInfo.ArgumentList.Add("/dev/null");
        process.StartInfo.Environment["TERM"] = "xterm-256color";
        process.StartInfo.Environment["COLORTERM"] = "truecolor";
        process.StartInfo.Environment["SHELL"] = shellPath;
        return process;
    }

    private static async Task PumpOutputAsync(
        StreamReader reader,
        WebSocket webSocket,
        SemaphoreSlim sendLock,
        CancellationToken cancellationToken)
    {
        var buffer = new char[2048];

        while (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived)
        {
            var count = await reader.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);
            if (count <= 0)
            {
                return;
            }

            var output = new string(buffer, 0, count);
            var payload = Encoding.UTF8.GetBytes(output);

            await sendLock.WaitAsync(cancellationToken);
            try
            {
                if (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived)
                {
                    await webSocket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
                }
            }
            finally
            {
                sendLock.Release();
            }
        }
    }

    private static async Task PumpInputAsync(
        WebSocket webSocket,
        StreamWriter writer,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[4096];
        var messageBuffer = new ArrayBufferWriter<byte>();

        while (webSocket.State == WebSocketState.Open || webSocket.State == WebSocketState.CloseReceived)
        {
            var result = await webSocket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return;
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                continue;
            }

            messageBuffer.Write(buffer.AsSpan(0, result.Count));

            if (!result.EndOfMessage)
            {
                continue;
            }

            var message = Encoding.UTF8.GetString(messageBuffer.WrittenSpan);
            messageBuffer.Clear();

            TerminalClientMessage? payload;
            try
            {
                payload = JsonSerializer.Deserialize<TerminalClientMessage>(message);
            }
            catch
            {
                continue;
            }

            var inputData = payload?.Data;
            if (!string.Equals(payload?.Type, "input", StringComparison.OrdinalIgnoreCase)
                || string.IsNullOrEmpty(inputData))
            {
                continue;
            }

            await writer.WriteAsync(inputData.AsMemory(), cancellationToken);
            await writer.FlushAsync(cancellationToken);
        }
    }

    private static string BuildStatusMessage(bool supported, bool enabled)
    {
        if (!supported)
        {
            return "The web terminal is supported on Linux hosts with bash and script installed.";
        }

        return enabled
            ? "Web terminal access is enabled."
            : "Web terminal access is off.";
    }

    private string? ResolveShellPath()
    {
        return File.Exists("/bin/bash")
            ? "/bin/bash"
            : _resolveExecutableOnPath("bash");
    }

    private string? ResolveScriptPath()
    {
        return _resolveExecutableOnPath("script");
    }

    private static void TryKillProcess(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort.
        }
    }

    internal static string? ResolveExecutableOnPath(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
        {
            return null;
        }

        var pathValue = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrWhiteSpace(pathValue))
        {
            return null;
        }

        foreach (var directory in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var candidate = Path.Combine(directory, fileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private sealed class TerminalClientMessage
    {
        public string? Type { get; init; }

        public string? Data { get; init; }
    }
}
