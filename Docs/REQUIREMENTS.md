# Requirements Log

## Functional Requirements

- The system shall read JK inverter BMS devices over RS485.
- The system shall support protocol variants including JK inverter BMS v14, v15, and v19.
- The system shall keep protocol details configurable through JSON rather than hard-coding all register behavior.
- The system shall support configurable polling intervals per device.
- The system shall poll the master device every second.
- The system shall support polling slave devices less frequently than the master.
- The system shall log all monitored parameters into a time-series database.
- The system shall provide a browser-based user interface.
- The system shall provide a live dashboard.
- The system shall provide historical charts.
- The system shall provide configuration capabilities through the UI or platform.
- The system shall provide remote access.
- The system shall expose an API in v1.
- The system shall provide alerts in the UI.
- The system shall send notifications through ntfy in v1.

## Data Requirements

- A single JK BMS may expose roughly 200 registers.
- The system shall preserve high-resolution recent data.
- The system shall retain approximately 1-second resolution data for the most recent 10 minutes.
- The system shall retain approximately 1-minute resolution data for the most recent hour.
- The system shall retain approximately 5-minute resolution data for up to 365 days.
- The system shall support further compaction of older data.
- The system shall be local-first for data storage.
- The system should keep a path open for future cloud backup.

## Technical Preferences

- C# is the preferred language for the backend and logic layer.
- React is acceptable for the frontend.
- Blazor Server is familiar and remains an acceptable fallback.
- Blazor WebAssembly shall not be used.
- Two services are acceptable: a UI service and a backend or API service.
- PostgreSQL with TimescaleDB is currently favored because it can store time-series and other relational data.
- InfluxDB remains a recognized alternative if implementation constraints change.
- The physical RS485 connection is expected to use a USB dongle.
- Cloudflared tunnel is an accepted remote-access approach.

## Operational Requirements

- The system shall require authentication because it will be exposed to the internet.
- The system shall support easy iteration and OTA-style deployment.
- The system should be realistic to run on Raspberry Pi hardware.
- Raspberry Pi 5 is acceptable if Raspberry Pi Zero 2 W proves too constrained.

## Source Material

- Protocol and related reference documents are stored under the existing Docs directory.
- The initial implementation should use those materials to build the first JK RS485 register profile.
