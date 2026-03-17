# Getting Started

The real user-facing entry point is a one-line GitHub install command. Local script paths are only for users who already have the repository or an existing install on disk.

## New Install

Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "& { $tmp = Join-Path $env:TEMP 'jkmonitor-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.ps1' -OutFile $tmp; & $tmp -Repository 'https://github.com/BieleckiLtd/JkMonitorV2' -Branch 'dev' }"
```

Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev
```

These commands:

- Download the installer straight from GitHub.
- Download the selected branch of the application.
- Install or update the local application folder.
- Start the guided setup flow.

## Already Cloned Or Already Installed

If the repo is already on disk, or the software was already installed previously, use the local scripts from that folder:

- Windows: `./scripts/setup.ps1` or `./scripts/update.ps1`
- Linux or macOS: `./scripts/setup.sh` or `./scripts/update.sh`

## Install Directly From GitHub

If you need a customizable GitHub install command instead of the default repo and branch, use these forms.

Windows example:

`powershell -ExecutionPolicy Bypass -File .\scripts\install-from-github.ps1 -Repository https://github.com/BieleckiLtd/JkMonitorV2 -Branch dev`

Linux or macOS example:

`./scripts/install-from-github.sh https://github.com/BieleckiLtd/JkMonitorV2 dev`

These GitHub bootstrap scripts:

- Download the selected branch as a ZIP archive from GitHub.
- Extract it into a local installation folder.
- Update an existing installation in place when the destination already exists.
- Preserve local appsettings override files and the cached local `.dotnet` toolchain.
- Start the same guided setup flow from that downloaded copy.

The scripts accept either the full GitHub URL or `owner/repo` form.

## Update An Existing Install

If the software is already installed from this repository and you just want the latest `dev` branch without re-entering the repo or branch values:

- Windows: `./scripts/update.ps1`
- Linux or macOS: `./scripts/update.sh`

These wrappers refresh the current installation folder from `https://github.com/BieleckiLtd/JkMonitorV2`, preserve local config and the cached local `.dotnet` toolchain, and then run the guided setup again.

The setup script does the following:

- Detects whether a suitable .NET toolchain already exists.
- Installs a local .NET 10 SDK into the repository if needed.
- Asks whether to start in simulator mode or hardware mode.
- On Windows hardware mode, auto-detects available COM ports and lets the user choose from a list.
- Writes a local override file so the user does not have to edit JSON manually.
- Waits for the backend to be reachable, then opens the app on `http://localhost:5074`.

## Why The Script Installs The SDK

Right now this repository runs the application from source with `dotnet run`, which requires the SDK rather than only the runtime.

The important point for the user is that they do not need to know that in advance. The setup script handles it automatically and installs the SDK locally inside the repo when required.

Longer term, the cleaner end-user path is a published installer or self-contained package that only needs a runtime or no runtime at all.

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