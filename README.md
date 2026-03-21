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

- New install on Windows x64 from the published GitHub release:

```powershell
powershell -ExecutionPolicy Bypass -Command "& { $tmp = Join-Path $env:TEMP 'jkmonitor-release-install.ps1'; Invoke-WebRequest 'https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.ps1' -OutFile $tmp; & powershell -ExecutionPolicy Bypass -File $tmp -Repository 'https://github.com/BieleckiLtd/JkMonitorV2' -ReleaseTag 'dev-latest' }"
```

- Developer install from source on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-github.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev
```

- Already installed from source locally: use `./scripts/update.ps1` or `./scripts/update.sh` inside the installed folder to refresh from the default `dev` branch.

The release installers download published builds from GitHub Releases, install only the ASP.NET Core runtime when needed, start in simulator mode on the first run so the UI is available immediately, let the user finish RS485 setup from the browser UI, and print LAN URLs that can be opened from another PC on the network.

The source installer remains available for local development and debugging.

See `Docs/GETTING_STARTED.md` for a step-by-step first run and deployment path.

## Publish skill

Use the built-in publish skill for full end-to-end publish from source:

```bash
./scripts/publish-skill.sh "chore: publish changes"
```

This script:
- commits and pushes current working copy to `dev`
- waits for `publish-backend` GitHub Actions workflow
- SSHs to `pi@fm.local`
- pulls `dev`, publishes backend ARM64, syncs frontend assets, and restarts `jkmonitor.service`
- checks service endpoints (if `curl` is available locally)

