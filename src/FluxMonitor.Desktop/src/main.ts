import { app, BrowserWindow, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import net from "node:net";
import path from "node:path";

type WindowState = {
    width: number;
    height: number;
    x?: number;
    y?: number;
    isMaximized?: boolean;
};

const desktopRoot = path.resolve(__dirname, "..");
const defaultWindowState: WindowState = {
    width: 1440,
    height: 920
};
const backendLogLimit = 200;
const backendLogs: string[] = [];

let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let backendStartupError: Error | null = null;
let backendExitedUnexpectedly = false;
let appIsQuitting = false;
let backendBaseUrl: string | null = null;
let backendPort: number | null = null;
let backendReady = false;
let backendRecoveryPromise: Promise<void> | null = null;

function escapeHtml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#39;");
}

function buildInlinePage(title: string, heading: string, detail: string, accent: string): string {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: rgba(15, 23, 42, 0.88);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: ${accent};
      --border: rgba(148, 163, 184, 0.24);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(34, 197, 94, 0.16), transparent 40%),
        linear-gradient(160deg, #020617 0%, #0f172a 52%, #111827 100%);
      color: var(--text);
      font: 15px/1.6 "Segoe UI", system-ui, sans-serif;
    }

    main {
      width: min(720px, calc(100vw - 48px));
      padding: 32px;
      border: 1px solid var(--border);
      border-radius: 20px;
      background: var(--panel);
      backdrop-filter: blur(16px);
      box-shadow: 0 24px 60px rgba(2, 6, 23, 0.5);
    }

    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0 0 12px;
      font-size: clamp(28px, 5vw, 40px);
      line-height: 1.1;
    }

    p {
      margin: 0;
      color: var(--muted);
      white-space: pre-wrap;
    }

    pre {
      margin: 20px 0 0;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(2, 6, 23, 0.72);
      color: #cbd5e1;
      overflow: auto;
      font: 12px/1.55 Consolas, "Courier New", monospace;
    }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Flux Monitor Desktop</p>
    <h1>${escapeHtml(heading)}</h1>
    <p>${escapeHtml(detail)}</p>
  </main>
</body>
</html>`;

    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function buildStartupErrorPage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const logOutput = backendLogs.length > 0 ? backendLogs.join("") : "No backend output was captured.";
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Flux Monitor Startup Failed</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #120a0a;
      --panel: rgba(29, 10, 10, 0.9);
      --text: #fee2e2;
      --muted: #fecaca;
      --accent: #f97316;
      --border: rgba(248, 113, 113, 0.28);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(248, 113, 113, 0.22), transparent 42%),
        linear-gradient(165deg, #160505 0%, #1f0b0b 54%, #050816 100%);
      color: var(--text);
      font: 15px/1.6 "Segoe UI", system-ui, sans-serif;
    }

    main {
      width: min(880px, calc(100vw - 48px));
      padding: 32px;
      border: 1px solid var(--border);
      border-radius: 20px;
      background: var(--panel);
      backdrop-filter: blur(16px);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
    }

    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0 0 12px;
      font-size: clamp(28px, 5vw, 40px);
      line-height: 1.1;
    }

    p {
      margin: 0;
      color: var(--muted);
      white-space: pre-wrap;
    }

    pre {
      margin: 20px 0 0;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid rgba(248, 113, 113, 0.22);
      background: rgba(2, 6, 23, 0.72);
      color: #fed7d7;
      overflow: auto;
      font: 12px/1.55 Consolas, "Courier New", monospace;
      max-height: 44vh;
    }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Flux Monitor Desktop</p>
    <h1>Startup failed</h1>
    <p>${escapeHtml(message)}</p>
    <pre>${escapeHtml(logOutput)}</pre>
  </main>
</body>
</html>`;

    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function appendBackendLog(chunk: Buffer | string): void {
    const text = chunk.toString();
    backendLogs.push(text);

    while (backendLogs.length > backendLogLimit) {
        backendLogs.shift();
    }
}

function getWindowStatePath(): string {
    return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState {
    try {
        const statePath = getWindowStatePath();

        if (!fs.existsSync(statePath)) {
            return defaultWindowState;
        }

        const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<WindowState>;
        return {
            width: typeof parsed.width === "number" ? parsed.width : defaultWindowState.width,
            height: typeof parsed.height === "number" ? parsed.height : defaultWindowState.height,
            x: typeof parsed.x === "number" ? parsed.x : undefined,
            y: typeof parsed.y === "number" ? parsed.y : undefined,
            isMaximized: parsed.isMaximized === true
        };
    } catch {
        return defaultWindowState;
    }
}

function saveWindowState(window: BrowserWindow): void {
    const statePath = getWindowStatePath();
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const state: WindowState = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        isMaximized: window.isMaximized()
    };

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function writeStartupDiagnostic(error: unknown): void {
    try {
        const diagnosticPath = path.join(app.getPath("userData"), "startup-error.log");
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        const logOutput = backendLogs.length > 0 ? backendLogs.join("") : "No backend output was captured.";
        const content = `${message}${SystemNewLine()}${SystemNewLine()}${logOutput}`;

        fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
        fs.writeFileSync(diagnosticPath, content);
    } catch {
    }
}

function SystemNewLine(): string {
    return process.platform === "win32" ? "\r\n" : "\n";
}

function getWindowIconPath(): string | undefined {
    const iconPath = path.join(app.getAppPath(), "app.ico");
    return fs.existsSync(iconPath) ? iconPath : undefined;
}

function createMainWindow(): BrowserWindow {
    const windowState = loadWindowState();
    const window = new BrowserWindow({
        title: "Flux Monitor",
        width: windowState.width,
        height: windowState.height,
        x: windowState.x,
        y: windowState.y,
        minWidth: 1120,
        minHeight: 720,
        backgroundColor: "#020617",
        icon: getWindowIconPath(),
        autoHideMenuBar: true,
        show: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            sandbox: true
        }
    });

    if (windowState.isMaximized) {
        window.maximize();
    }

    window.on("close", () => saveWindowState(window));
    window.webContents.on("will-navigate", (event, url) => {
        if (backendBaseUrl !== null && !url.startsWith(backendBaseUrl)) {
            event.preventDefault();
            void shell.openExternal(url);
        }
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);
        return { action: "deny" };
    });

    return window;
}

async function findAvailablePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.unref();

        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (address === null || typeof address === "string") {
                server.close();
                reject(new Error("The desktop host could not reserve a local TCP port."));
                return;
            }

            server.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }

                resolve(address.port);
            });
        });
    });
}

async function getBackendBaseUrl(): Promise<string> {
    if (backendBaseUrl !== null) {
        return backendBaseUrl;
    }

    backendPort ??= await findAvailablePort();
    backendBaseUrl = `http://127.0.0.1:${backendPort}`;
    return backendBaseUrl;
}

function getPackagedBackendDirectory(): string {
    return path.join(process.resourcesPath, "backend");
}

function getPackagedBackendExecutablePath(): string {
    const executableName = process.platform === "win32"
        ? "FluxMonitor.Backend.exe"
        : "FluxMonitor.Backend";

    return path.join(getPackagedBackendDirectory(), executableName);
}

function getDevelopmentBackendProjectPath(): string {
    return path.resolve(desktopRoot, "../FluxMonitor.Backend/FluxMonitor.Backend.csproj");
}

function getDotnetExecutablePath(): string {
    if (process.platform !== "win32") {
        return "dotnet";
    }

    const dotnetRoot = process.env.DOTNET_ROOT;
    if (dotnetRoot) {
        const candidate = path.join(dotnetRoot, "dotnet.exe");

        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    const programFiles = process.env.ProgramFiles;
    if (programFiles) {
        const candidate = path.join(programFiles, "dotnet", "dotnet.exe");

        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return "dotnet";
}

function request(url: string): Promise<number> {
    return awaitableRequest(url);
}

function awaitableRequest(url: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const client = url.startsWith("https://") ? httpsGet : httpGet;
        const request = client(url, (response) => {
            response.resume();

            if (typeof response.statusCode !== "number") {
                reject(new Error("The backend health check did not return an HTTP status code."));
                return;
            }

            resolve(response.statusCode);
        });

        request.on("error", reject);
        request.setTimeout(5000, () => request.destroy(new Error("The backend health check timed out.")));
    });
}

async function waitForBackendReady(baseUrl: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    let lastStatus: number | null = null;

    while (Date.now() < deadline) {
        if (backendStartupError) {
            throw backendStartupError;
        }

        if (backendExitedUnexpectedly) {
            throw new Error("The backend process exited before the desktop window could connect.");
        }

        try {
            lastStatus = await request(`${baseUrl}/api/health`);

            if (lastStatus >= 200 && lastStatus < 300) {
                return;
            }
        } catch {
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(
        lastStatus === null
            ? "Timed out waiting for the local backend to start listening."
            : `Timed out waiting for the local backend to become healthy. Last status: HTTP ${lastStatus}.`);
}

function buildBackendEnvironment(urls: string): NodeJS.ProcessEnv {
    const environmentName =
        process.env.FLUXMONITOR_DESKTOP_ENVIRONMENT
        ?? "Production";

    return {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: environmentName,
        ASPNETCORE_URLS: urls,
        DOTNET_PRINT_TELEMETRY_MESSAGE: "0",
        FLUXMONITOR_DESKTOP_HOST: "electron"
    };
}

async function startBackend(): Promise<string> {
    const baseUrl = await getBackendBaseUrl();
    const env = buildBackendEnvironment(baseUrl);

    backendStartupError = null;
    backendExitedUnexpectedly = false;
    backendReady = false;
    backendLogs.length = 0;

    if (app.isPackaged) {
        const backendDirectory = getPackagedBackendDirectory();
        const executablePath = getPackagedBackendExecutablePath();

        if (!fs.existsSync(executablePath)) {
            throw new Error(`The packaged backend executable was not found at ${executablePath}.`);
        }

        backendProcess = spawn(executablePath, [], {
            cwd: backendDirectory,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
    } else {
        const projectPath = getDevelopmentBackendProjectPath();
        const backendDirectory = path.dirname(projectPath);

        backendProcess = spawn(getDotnetExecutablePath(), ["run", "--project", projectPath, "--no-launch-profile", "--no-build"], {
            cwd: backendDirectory,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true
        });
    }

    const startedProcess = backendProcess;
    startedProcess.stdout?.on("data", appendBackendLog);
    startedProcess.stderr?.on("data", appendBackendLog);
    startedProcess.once("error", (error) => {
        backendStartupError = error;
    });
    startedProcess.once("exit", (code, signal) => {
        if (backendProcess === startedProcess) {
            backendProcess = null;
        }

        if (appIsQuitting) {
            return;
        }

        if (!backendReady) {
            backendExitedUnexpectedly = true;
            backendStartupError = new Error(
                signal
                    ? `The backend exited during startup with signal ${signal}.`
                    : `The backend exited during startup with code ${code}.`);
            return;
        }

        void recoverBackendAfterExit(code, signal);
    });

    await waitForBackendReady(baseUrl);
    backendReady = true;
    return baseUrl;
}

async function stopBackend(): Promise<void> {
    const processToStop = backendProcess;
    backendProcess = null;

    if (processToStop === null || processToStop.killed) {
        return;
    }

    if (process.platform === "win32" && typeof processToStop.pid === "number") {
        await new Promise<void>((resolve) => {
            const killer = spawn("taskkill", ["/pid", String(processToStop.pid), "/t", "/f"], {
                windowsHide: true,
                stdio: "ignore"
            });

            killer.once("exit", () => resolve());
            killer.once("error", () => resolve());
        });

        return;
    }

    processToStop.kill("SIGTERM");
}

async function focusMainWindow(): Promise<void> {
    if (mainWindow === null) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.focus();
}

async function loadBackendWithRecovery(
    heading: string,
    detail: string
): Promise<void> {
    if (mainWindow === null) {
        return;
    }

    await mainWindow.loadURL(buildInlinePage(
        "Flux Monitor",
        heading,
        detail,
        "#22c55e"));

    const backendUrl = await startBackend();

    if (mainWindow === null) {
        return;
    }

    await mainWindow.loadURL(backendUrl);
}

async function recoverBackendAfterExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (backendRecoveryPromise || appIsQuitting) {
        return;
    }

    const exitSummary = signal
        ? `The local backend stopped with signal ${signal}. Flux Monitor is starting it again.`
        : `The local backend stopped with code ${code ?? 0}. Flux Monitor is starting it again.`;

    backendRecoveryPromise = (async () => {
        try {
            await loadBackendWithRecovery(
                "Restarting Flux Monitor",
                exitSummary);
        } catch (error) {
            console.error("Flux Monitor desktop backend recovery failed.", error);

            if (backendLogs.length > 0) {
                console.error(backendLogs.join(""));
            }

            writeStartupDiagnostic(error);

            if (mainWindow !== null) {
                await mainWindow.loadURL(buildStartupErrorPage(error));
            }
        } finally {
            backendRecoveryPromise = null;
        }
    })();

    await backendRecoveryPromise;
}

async function bootstrap(): Promise<void> {
    mainWindow = createMainWindow();

    try {
        await loadBackendWithRecovery(
            "Starting Flux Monitor",
            "Launching the local backend and preparing the desktop window.");
    } catch (error) {
        console.error("Flux Monitor desktop startup failed.", error);

        if (backendLogs.length > 0) {
            console.error(backendLogs.join(""));
        }

        writeStartupDiagnostic(error);

        if (mainWindow !== null) {
            await mainWindow.loadURL(buildStartupErrorPage(error));
        }
    }
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on("second-instance", () => {
        void focusMainWindow();
    });

    app.on("window-all-closed", () => {
        app.quit();
    });

    app.on("before-quit", (event) => {
        if (appIsQuitting) {
            return;
        }

        appIsQuitting = true;

        if (backendProcess === null) {
            return;
        }

        event.preventDefault();
        void stopBackend().finally(() => app.quit());
    });

    void app.whenReady().then(async () => {
        await bootstrap();
    });
}
