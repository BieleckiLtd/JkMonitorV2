# JK Monitor V2

JK Monitor V2 is a local-first monitoring platform for JK inverter BMS devices connected over RS485.

The project goal is to poll one or more BMS devices, persist telemetry to a time-series store, expose a secured HTTP API, and provide a browser UI for live status, trends, configuration, and alerts.

## Initial direction

- Backend: C# and .NET
- Frontend: browser UI, likely React
- Storage: PostgreSQL with TimescaleDB as the leading option
- Notifications: in-app alerts and ntfy
- Remote access: authenticated internet exposure via Cloudflare Tunnel or equivalent
- Configuration: JSON-driven protocol, polling, alerting, and retention settings

## Repository layout

- `Docs/`: source protocol documents and third-party reference material
- `docs/`: project-owned architecture, requirements, and delivery documentation
- `src/backend/`: backend services and API
- `src/shared/`: shared contracts and configuration models

## Current focus

The first implementation phase establishes project scope, architecture, configuration contracts, and a backend-first scaffold for RS485 polling and API delivery.

## Quick start

- Raspberry Pi or other Linux ARM64 runtime install from prebuilt GitHub artifact:

```bash
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev-latest
```

- New install on Windows:

```powershell
powershell -ExecutionPolicy Bypass -Command "& { $tmp = Join-Path $env:TEMP 'jkmonitor-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.ps1' -OutFile $tmp; & $tmp -Repository 'https://github.com/BieleckiLtd/JkMonitorV2' -Branch 'dev' }"
```

- Developer install from source on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev
```

- Already installed from source locally: use `./scripts/update.ps1` or `./scripts/update.sh` inside the installed folder to refresh from the default `dev` branch.

The Raspberry Pi runtime path downloads a published `linux-arm64` build from GitHub Releases, installs only the ASP.NET Core runtime when needed, starts in simulator mode on the first run so the UI is available immediately, writes a local reconfiguration helper for later RS485 setup, installs and starts a `systemd` service by default on Linux devices, and binds the app for LAN access so the web UI can be opened from another PC on the network.

The source installer remains available for local development and debugging.

See `Docs/GETTING_STARTED.md` for a step-by-step first run and deployment path.
