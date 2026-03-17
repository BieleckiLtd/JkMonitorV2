# Getting Started

The user entry point is now one command.

## Run It

- Windows: `./scripts/setup.ps1`
- Linux or macOS: `./scripts/setup.sh`

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