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

- Windows: run `./scripts/setup.ps1`
- Linux or macOS: run `./scripts/setup.sh`
- The setup script guides the user through simulator or hardware mode, installs a local .NET toolchain if needed, writes a local config override, and launches the app.

See `Docs/GETTING_STARTED.md` for a step-by-step first run and deployment path.
