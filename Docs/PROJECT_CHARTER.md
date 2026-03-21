# Project Charter

## Purpose

Build a production-oriented monitoring platform for JK inverter BMS devices connected over RS485.

The system is intended to run locally on Raspberry Pi-class hardware, poll BMS telemetry continuously, retain historical data efficiently, expose a secure HTTP API, and present a browser-based user interface for monitoring and management.

## Problem Statement

Existing tooling and protocol references exist, but there is no dedicated application in this repository that combines polling, storage, API access, and a remotely accessible authenticated UI in a maintainable way.

## Objectives

- Read one or more JK inverter BMS devices over RS485.
- Support JK inverter BMS protocol variants including v14, v15, and v19.
- Keep protocol definitions and polling behavior configurable through JSON.
- Poll the master device every second.
- Poll slave devices on slower configurable intervals.
- Persist telemetry in a time-series oriented data store.
- Retain recent high-resolution data and compact older data through rollups.
- Provide a secured HTTP API for current state, history, configuration, and health.
- Provide a browser UI for dashboarding, charts, and configuration.
- Deliver alerts in the UI and through ntfy.
- Support authenticated remote access for internet exposure.
- Optimize for easy iteration and OTA-style deployment.

## Non-Goals For V1

- Blazor WebAssembly.
- Full cloud backup implementation.
- Broad notification channel support beyond ntfy.
- Every possible downstream integration on day one.

## Constraints

- C# is the preferred backend language unless implementation realities prove a different choice is materially better.
- Raspberry Pi Zero 2 W is the initial idea, but Raspberry Pi 5 is acceptable and likely more realistic for a full local stack.
- The system should remain local-first even if cloud backup is added later.
- The system will be internet-exposed, so authentication is mandatory.

## Working Assumptions

- The physical RS485 connection will use a USB adapter.
- The initial deployment topology can use two services: browser UI and backend/API.
- PostgreSQL with TimescaleDB is the leading storage option because it supports both telemetry and relational application data.
- Cloudflare Tunnel is a viable exposure mechanism.

## Success Criteria

- A configured JK BMS device can be polled reliably at the requested intervals.
- Current values are visible in the UI within a few seconds of acquisition.
- Historical data can be queried through the API and charted in the UI.
- Authentication protects internet-facing access.
- Alert conditions can be surfaced in-app and forwarded to ntfy.
- The system can be deployed and updated repeatably on Raspberry Pi hardware.
