# Implementation Plan

## Phase 1: Foundation

- Establish repository structure.
- Capture requirements, assumptions, and architectural decisions.
- Create the backend solution scaffold.
- Define JSON configuration contracts for devices, buses, polling, alerts, and retention.
- Create protocol abstraction boundaries before binding to JK-specific logic.

## Phase 2: Acquisition Core

- Implement RS485 serial transport over USB.
- Implement configurable polling schedules.
- Add JK inverter BMS request and response handling.
- Persist raw samples and basic device health status.
- Add retry, timeout, and fault handling.

## Phase 3: Data Platform

- Model measurements, rollups, alerts, and device metadata.
- Integrate PostgreSQL and TimescaleDB.
- Add retention and rollup jobs.
- Add query endpoints for current state and history.

## Phase 4: API and Security

- Expose current status, history, configuration, and health endpoints.
- Add authentication and authorization.
- Add audit-friendly configuration updates.
- Prepare internet exposure behind Cloudflare Tunnel.

## Phase 5: Browser UI

- Create dashboard views for live telemetry.
- Add historical charts.
- Add device and polling configuration views.
- Add alert views and operational status pages.

## Phase 6: Operations

- Add ntfy notifications.
- Add packaging and deployment workflow.
- Add backups, logs, and operational documentation.
- Add recovery and upgrade procedures.

## Immediate Deliverables

- Project charter and implementation plan stored in the repo.
- Backend project scaffold.
- JSON configuration model.
- Initial polling service abstractions.
- Clear next tasks for JK protocol integration.
