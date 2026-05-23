import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import net from "node:net";
import path from "node:path";
import defaultThemeJson from "./default-theme.json";

type WindowState = {
    width: number;
    height: number;
    x?: number;
    y?: number;
    isMaximized?: boolean;
};

type ThemeSnapshot = {
    id: string;
    mode: "dark" | "light";
    radius: string;
    colors: Record<string, string>;
};

const defaultThemeSnapshot: ThemeSnapshot = {
    id: defaultThemeJson.id,
    mode: defaultThemeJson.mode === "light" ? "light" : "dark",
    radius: defaultThemeJson.radius,
    colors: defaultThemeJson.colors as Record<string, string>
};

function getThemeSnapshotPath(): string {
    return path.join(app.getPath("userData"), "active-theme.json");
}

function readSavedTheme(): ThemeSnapshot {
    try {
        const p = getThemeSnapshotPath();
        if (!fs.existsSync(p)) {
            return defaultThemeSnapshot;
        }
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw) as Partial<ThemeSnapshot>;
        if (typeof parsed.id !== "string" || typeof parsed.radius !== "string" || !parsed.colors) {
            return defaultThemeSnapshot;
        }
        return {
            id: parsed.id,
            mode: parsed.mode === "light" ? "light" : "dark",
            radius: parsed.radius,
            colors: { ...defaultThemeSnapshot.colors, ...parsed.colors }
        };
    } catch {
        return defaultThemeSnapshot;
    }
}

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

function readPageCss(name: string): string {
    try {
        return fs.readFileSync(path.join(__dirname, "pages", name), "utf8");
    } catch {
        return "";
    }
}

function buildThemeRootBlock(theme: ThemeSnapshot): string {
    const vars = Object.entries(theme.colors)
        .map(([k, v]) => `  ${k}: ${v};`)
        .join("\n");
    return `:root {\n${vars}\n  --radius: ${theme.radius};\n}`;
}

function buildInlinePage(title: string, heading: string, detail: string, theme: ThemeSnapshot): string {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
  <style>${buildThemeRootBlock(theme)}\n${readPageCss("pages.css")}</style>
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
    const theme = readSavedTheme();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Flux Monitor – Startup Failed</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
  <style>${buildThemeRootBlock(theme)}\n${readPageCss("pages.css")}</style>
</head>
<body class="page-error">
  <main>
    <p class="eyebrow">Flux Monitor Desktop</p>
    <h1>Startup failed</h1>
    <p class="error-msg">${escapeHtml(message)}</p>
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
        ?? (app.isPackaged ? "Production" : "Development");

    return {
        ...process.env,
        ASPNETCORE_ENVIRONMENT: environmentName,
        ASPNETCORE_URLS: urls,
        DOTNET_PRINT_TELEMETRY_MESSAGE: "0",
        FLUXMONITOR_DESKTOP_HOST: "electron"
    };
}

function getBackendSettingsPath(): string {
    const environmentName = process.env.FLUXMONITOR_DESKTOP_ENVIRONMENT ?? (app.isPackaged ? "Production" : "Development");
    const baseDir = app.isPackaged 
        ? getPackagedBackendDirectory() 
        : path.dirname(getDevelopmentBackendProjectPath());
    return path.join(baseDir, `appsettings.${environmentName}.Local.json`);
}

function isPostgresConfigured(): boolean {
    const settingsPath = getBackendSettingsPath();
    if (!fs.existsSync(settingsPath)) {
        return false;
    }
    try {
        const content = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""); // strip UTF-8 BOM written by PowerShell 5.1
        const parsed = JSON.parse(content);
        const connStr = parsed?.Monitor?.Storage?.ConnectionString;
        return typeof connStr === "string" && connStr.trim().length > 0;
    } catch {
        return false;
    }
}

function getPostgresScriptPath(): string | null {
    const candidates = [
        path.join(getPackagedBackendDirectory(), "scripts", "ensure-local-postgres.ps1"),
        path.resolve(desktopRoot, "../FluxMonitor.Backend/scripts/ensure-local-postgres.ps1"),
        path.resolve(desktopRoot, "../../scripts/ensure-local-postgres.ps1"),
        path.resolve(desktopRoot, "../FluxMonitor.Backend/bin/Debug/net10.0/scripts/ensure-local-postgres.ps1")
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}

function buildSetupProgressPage(): string {
    const theme = readSavedTheme();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Flux Monitor – Database Setup</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet" />
  <style>${buildThemeRootBlock(theme)}\n${readPageCss("pages.css")}</style>
</head>
<body class="page-setup">
  <main>
    <p class="eyebrow">Automatic Database Setup</p>
    <h1>Setting up local storage dependency</h1>
    <p class="description">Flux Monitor is automatically installing and configuring local PostgreSQL &amp; TimescaleDB. This process takes a moment and only runs once.</p>
    <div class="progress-track"><div class="progress-fill"></div></div>
    <div class="terminal" id="logs">Preparing installation...</div>
  </main>
</body>
</html>`;

    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function appendLogToWebpage(line: string) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        const escaped = JSON.stringify(line + "\n");
        mainWindow.webContents.executeJavaScript(
            `const logs = document.getElementById('logs');
             if (logs) {
                 if (logs.innerText === 'Preparing installation...') {
                     logs.innerText = '';
                 }
                 logs.innerText += ${escaped};
                 logs.scrollTop = logs.scrollHeight;
             }`
        ).catch(() => {});
    }
}

async function autoInstallPostgresIfNeeded(): Promise<void> {
    if (process.platform !== "win32") {
        return;
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        return;
    }

    const pgBinDir = path.join(localAppData, "PostgreSQL", "17.9-2", "pgsql", "bin");
    const pgCtl = path.join(pgBinDir, "pg_ctl.exe");
    const dataDir = path.join(localAppData, "FluxMonitor", "postgresql", "data");

    const binariesExist = fs.existsSync(pgCtl) && fs.existsSync(path.join(dataDir, "PG_VERSION"));
    const configured = isPostgresConfigured();

    if (binariesExist && configured) {
        return;
    }

    console.log("Automatic database installation triggered.");
    const scriptPath = getPostgresScriptPath();
    if (!scriptPath) {
        throw new Error("Could not find ensure-local-postgres.ps1 script path.");
    }

    if (mainWindow) {
        await mainWindow.loadURL(buildSetupProgressPage());
    }

    const settingsPath = getBackendSettingsPath();
    await new Promise<void>((resolve, reject) => {
        const child = spawn("powershell", [
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", scriptPath,
            "-BackendSettingsPath", settingsPath
        ], {
            windowsHide: true
        });

        let outputBuffer = "";
        
        const processData = (data: Buffer) => {
            outputBuffer += data.toString();
            const lines = outputBuffer.split(/\r?\n/);
            outputBuffer = lines.pop() ?? "";
            
            for (const line of lines) {
                if (line.trim().length > 0) {
                    console.log(`[PS INSTALLER] ${line}`);
                    appendLogToWebpage(line);
                }
            }
        };

        child.stdout.on("data", processData);
        child.stderr.on("data", processData);

        child.once("exit", (code) => {
            if (outputBuffer.trim().length > 0) {
                appendLogToWebpage(outputBuffer);
            }
            if (code === 0) {
                appendLogToWebpage("\nDatabase setup completed successfully!");
                resolve();
            } else {
                reject(new Error(`Database installer exited with code ${code}`));
            }
        });

        child.once("error", (err) => {
            reject(err);
        });
    });

    await new Promise((r) => setTimeout(r, 2000));
}

async function startLocalPostgres(): Promise<void> {
    if (process.platform !== "win32") {
        return;
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        return;
    }

    const pgBinDir = path.join(localAppData, "PostgreSQL", "17.9-2", "pgsql", "bin");
    const pgCtl = path.join(pgBinDir, "pg_ctl.exe");
    const pgIsReady = path.join(pgBinDir, "pg_isready.exe");
    const dataDir = path.join(localAppData, "FluxMonitor", "postgresql", "data");
    const logPath = path.join(localAppData, "FluxMonitor", "postgresql", "postgresql.log");

    if (!fs.existsSync(pgCtl) || !fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
        return;
    }

    // Check if postgres is already running
    const isRunning = await new Promise<boolean>((resolve) => {
        const check = spawn(pgCtl, ["status", "-D", dataDir], { windowsHide: true });
        check.once("exit", (code) => resolve(code === 0));
        check.once("error", () => resolve(false));
    });

    if (isRunning) {
        console.log("Local PostgreSQL is already running.");
        return;
    }

    console.log("Starting local PostgreSQL...");
    await new Promise<void>((resolve, reject) => {
        const start = spawn(pgCtl, ["-D", dataDir, "-l", logPath, "start"], {
            windowsHide: true,
            stdio: "ignore"
        });
        start.once("exit", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`pg_ctl start exited with code ${code}`));
            }
        });
        start.once("error", (err) => reject(err));
    });

    // Wait for it to become ready
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        const ready = await new Promise<boolean>((resolve) => {
            const readyCheck = spawn(pgIsReady, ["-h", "127.0.0.1", "-p", "5432", "-U", "postgres"], { windowsHide: true });
            readyCheck.once("exit", (code) => resolve(code === 0));
            readyCheck.once("error", () => resolve(false));
        });

        if (ready) {
            console.log("Local PostgreSQL is ready.");
            return;
        }

        await new Promise((r) => setTimeout(r, 500));
    }

    throw new Error("Timed out waiting for local PostgreSQL to become ready.");
}

async function stopLocalPostgres(): Promise<void> {
    if (process.platform !== "win32") {
        return;
    }

    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) {
        return;
    }

    const pgCtl = path.join(localAppData, "PostgreSQL", "17.9-2", "pgsql", "bin", "pg_ctl.exe");
    const dataDir = path.join(localAppData, "FluxMonitor", "postgresql", "data");

    if (!fs.existsSync(pgCtl) || !fs.existsSync(path.join(dataDir, "PG_VERSION"))) {
        return;
    }

    console.log("Stopping local PostgreSQL...");
    await new Promise<void>((resolve) => {
        const stop = spawn(pgCtl, ["-D", dataDir, "stop", "-m", "fast"], {
            windowsHide: true,
            stdio: "ignore"
        });
        stop.once("exit", () => resolve());
        stop.once("error", () => resolve());
    });
}

async function startBackend(): Promise<string> {
    try {
        await autoInstallPostgresIfNeeded();
    } catch (error) {
        console.error("Failed to automatically install database:", error);
        if (mainWindow) {
            await mainWindow.loadURL(buildStartupErrorPage(error));
        }
        throw error;
    }

    try {
        await startLocalPostgres();
    } catch (error) {
        console.error("Failed to start local PostgreSQL:", error);
    }

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

        backendProcess = spawn(getDotnetExecutablePath(), ["run", "--project", projectPath, "--framework", "net10.0", "--no-launch-profile", "--no-build"], {
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

    if (processToStop !== null && !processToStop.killed) {
        if (process.platform === "win32" && typeof processToStop.pid === "number") {
            await new Promise<void>((resolve) => {
                const killer = spawn("taskkill", ["/pid", String(processToStop.pid), "/t", "/f"], {
                    windowsHide: true,
                    stdio: "ignore"
                });

                killer.once("exit", () => resolve());
                killer.once("error", () => resolve());
            });
        } else {
            processToStop.kill("SIGTERM");
        }
    }

    if (process.platform === "win32") {
        await stopLocalPostgres();
    }
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
        readSavedTheme()));

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

    ipcMain.on("theme:get-sync", (event) => {
        try {
            const p = getThemeSnapshotPath();
            if (!fs.existsSync(p)) {
                event.returnValue = null;
                return;
            }
            event.returnValue = JSON.parse(fs.readFileSync(p, "utf8"));
        } catch {
            event.returnValue = null;
        }
    });

    ipcMain.handle("theme:save", (_event, snapshot: unknown) => {
        try {
            const p = getThemeSnapshotPath();
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(snapshot, null, 2), "utf8");
        } catch {
            // Best effort — inline pages degrade to default theme.
        }
    });

    void app.whenReady().then(async () => {
        await bootstrap();
    });
}
