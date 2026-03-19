# Getting Started

The real user-facing entry point is a one-line GitHub install command. Local script paths are only for users who already have the repository or an existing install on disk.

## New Install

Raspberry Pi or other Linux ARM64 device using a prebuilt runtime artifact:

```bash
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev-latest
```

This path:

- Downloads a `linux-arm64` published build from GitHub Releases.
- Installs only the ASP.NET Core runtime when it is missing.
- Avoids compiling on the device.
- Writes local config overrides into the published app folder.
- Creates a reusable launcher at `~/jkmonitor/start.sh`.
- Installs and starts a `systemd` service by default when `systemd` is available, so the app starts after reboot.
- Binds on the device LAN interface and prints the URL you can open from your PC.

For headless SSH automation, the release installer also accepts environment variables instead of prompts:

```bash
JKMONITOR_INSTALL_RUNTIME=y \
JKMONITOR_MODE=1 \
JKMONITOR_USE_DB=n \
JKMONITOR_INSTALL_SERVICE=y \
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev-latest
```

Supported variables are `JKMONITOR_INSTALL_RUNTIME`, `JKMONITOR_MODE`, `JKMONITOR_USE_DB`, `JKMONITOR_CONNECTION_STRING`, `JKMONITOR_SERIAL_PORT`, and `JKMONITOR_INSTALL_SERVICE`.

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "& { $tmp = Join-Path $env:TEMP 'jkmonitor-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.ps1' -OutFile $tmp; & $tmp -Repository 'https://github.com/BieleckiLtd/JkMonitorV2' -Branch 'dev' }"
```

Linux or macOS developer install from source:

```bash
curl -fsSL https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev
```

These commands:

- Download the installer straight from GitHub.
- Download either a prebuilt release artifact or the selected branch of the application, depending on the script.
- Install or update the local application folder.
- Start the guided setup flow.

## Already Cloned Or Already Installed

If the repo is already on disk, or the software was already installed previously, use the local scripts from that folder:

- Windows: `./scripts/setup.ps1` or `./scripts/update.ps1`
- Linux or macOS: `./scripts/setup.sh` or `./scripts/update.sh`

## Install Directly From GitHub

If you need a customizable GitHub install command instead of the default repo and branch, use these forms.

Linux ARM64 runtime artifact example:

`./scripts/install-from-release.sh https://github.com/BieleckiLtd/JkMonitorV2 dev-latest`

Windows example:

`powershell -ExecutionPolicy Bypass -File .\scripts\install-from-github.ps1 -Repository https://github.com/BieleckiLtd/JkMonitorV2 -Branch dev`

Linux or macOS example:

`./scripts/install-from-github.sh https://github.com/BieleckiLtd/JkMonitorV2 dev`

These GitHub bootstrap scripts:

- Either download the selected branch as a ZIP archive from GitHub or download a prebuilt release artifact from GitHub Releases.
- Extract it into a local installation folder.
- Update an existing installation in place when the destination already exists.
- Preserve local appsettings override files and the cached local `.dotnet` runtime or toolchain.
- Start the guided setup flow.

The scripts accept either the full GitHub URL or `owner/repo` form.

## Update An Existing Install

If the software is already installed from this repository and you just want the latest `dev` branch without re-entering the repo or branch values:

- Windows: `./scripts/update.ps1`
- Linux or macOS: `./scripts/update.sh`

If the software was installed from a published Linux release artifact and you want the latest `dev-latest` artifact again:

- Linux ARM64: `./scripts/update-from-release.sh`

These wrappers refresh the current installation folder from `https://github.com/BieleckiLtd/JkMonitorV2`, preserve local config and the cached local `.dotnet` toolchain, and then run the guided setup again.

The setup script does the following:

- Detects whether a suitable .NET runtime or toolchain already exists.
- Installs a local ASP.NET Core 10 runtime for published builds, or a local .NET 10 SDK for source builds, when needed.
- Asks whether to start in simulator mode or hardware mode.
- On Windows hardware mode, auto-detects available COM ports and lets the user choose from a list.
- Writes a local override file so the user does not have to edit JSON manually.
- Optionally installs and starts a `systemd` service for headless Raspberry Pi deployments.
- Waits for the backend to be reachable, then opens the app on `http://127.0.0.1:5074` on the device when running interactively.
- Prints the device LAN URL so the same UI can be opened from another PC on the network.

## Uninstall A Release Install

If the software was installed through the published Linux runtime path, remove it with:

- Linux ARM64: `./scripts/uninstall-release.sh`

This removes the install folder and disables the `jkmonitor.service` systemd unit if it exists.

## Runtime Install Versus Source Install

For Raspberry Pi installs, the preferred path is now the published `linux-arm64` artifact plus the ASP.NET Core runtime. That keeps the device out of the build loop and avoids installing the SDK.

The source-based installer still exists for local development and debugging. That path runs the app from source with `dotnet run`, which requires the SDK rather than only the runtime.

The important point for the user is that they do not need to know this in advance. The installer handles the dependency it needs for the chosen path.

## What The User Sees

The script guides the user through these choices:

1. Simulator mode.
2. Hardware mode.
3. Optional PostgreSQL and TimescaleDB persistence.

Simulator mode is the recommended first run because it validates the UI and polling flow without any JK hardware attached.

## Local Configuration

The setup script writes one of these optional override files under the backend project:

- `appsettings.Local.json`
- `appsettings.Development.Local.json`

Those files are loaded automatically by the app and are intended for machine-specific settings like serial port names and database connection strings.

## After The First Run

If the simulator looks good, the next step is hardware mode:

1. Run the same setup command again.
2. Choose hardware mode.
3. Select the detected RS485 serial port, or enter one manually.
4. Decide whether to enable PostgreSQL and TimescaleDB.

The app then uses the same UI and API, only with the real JK transport instead of the simulator.