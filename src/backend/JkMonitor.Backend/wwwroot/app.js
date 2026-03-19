const healthStats = document.querySelector("#health-stats");
const deviceList = document.querySelector("#device-list");
const lastRefresh = document.querySelector("#last-refresh");
const deviceCount = document.querySelector("#device-count");
const serviceStatus = document.querySelector("#service-status");
const deviceTemplate = document.querySelector("#device-template");
const setupBanner = document.querySelector("#setup-banner");
const setupTitle = document.querySelector("#setup-title");
const setupCopy = document.querySelector("#setup-copy");
const setupModeChip = document.querySelector("#setup-mode-chip");
const setupCommand = document.querySelector("#setup-command");

const metricFormatters = {
  totalVoltageVolts: (value) => `${value.toFixed(2)} V`,
  currentAmps: (value) => `${value.toFixed(2)} A`,
  powerWatts: (value) => `${value.toFixed(1)} W`,
  stateOfChargePercent: (value) => `${value.toFixed(0)}%`,
  deltaCellVoltageVolts: (value) => `${(value * 1000).toFixed(0)} mV`,
  mosTemperatureCelsius: (value) => `${value.toFixed(0)} C`
};

async function refresh() {
  try {
    const [healthResponse, devicesResponse] = await Promise.all([
      fetch("/api/health"),
      fetch("/api/devices/current")
    ]);

    if (!healthResponse.ok || !devicesResponse.ok) {
      throw new Error(`Request failed (${healthResponse.status}/${devicesResponse.status})`);
    }

    const health = await healthResponse.json();
    const devices = await devicesResponse.json();
    renderHealth(health);
    renderDevices(devices);
  } catch (error) {
    serviceStatus.innerHTML = `<span class="pill">API unavailable</span>`;
    lastRefresh.textContent = error.message;
  }
}

function renderHealth(health) {
  const onlineDevices = health.devices.filter((device) => device.lastOutcome !== "Failed").length;
  const persistedDevices = health.devices.filter((device) => device.lastPersistedAt).length;

  serviceStatus.innerHTML = `<span class="pill">${health.serviceName} · ${health.environmentName}</span>`;
  lastRefresh.textContent = `Updated ${new Date(health.reportedAt).toLocaleTimeString()}`;
  renderSetupBanner(health);

  const stats = [
    ["Startup mode", health.startupMode],
    ["Configured devices", health.configuredDeviceCount],
    ["Enabled devices", health.enabledDeviceCount],
    ["Polling ok", onlineDevices],
    ["Persisted", persistedDevices],
    ["Started", new Date(health.startedAt).toLocaleString()]
  ];

  healthStats.innerHTML = stats.map(([label, value]) => `
    <article class="stat">
      <span class="stat-label">${label}</span>
      <strong class="stat-value">${value}</strong>
    </article>
  `).join("");
}

function renderSetupBanner(health) {
  if (!setupBanner) {
    return;
  }

  const isSimulator = health.startupMode === "Simulator";

  setupBanner.hidden = false;
  setupModeChip.textContent = health.startupMode;

  if (isSimulator) {
    setupTitle.textContent = "JK Monitor is live in simulator mode";
    setupCopy.textContent = "The UI is ready now. When you want real RS485 hardware, SSH into the device later and run the local configure command to switch modes without reinstalling.";
    setupCommand.textContent = "~/jkmonitor/configure.sh";
    return;
  }

  setupTitle.textContent = "JK Monitor is live in hardware mode";
  setupCopy.textContent = "The app is using the configured serial device. If you need to change the port or database settings later, rerun the local configure command on the device.";
  setupCommand.textContent = "~/jkmonitor/configure.sh";
}

function renderDevices(devices) {
  deviceCount.textContent = `${devices.length} device${devices.length === 1 ? "" : "s"}`;
  deviceList.innerHTML = "";

  for (const device of devices) {
    const node = deviceTemplate.content.cloneNode(true);
    node.querySelector(".device-name").textContent = device.displayName;
    node.querySelector(".device-meta").textContent = `${device.deviceId} · ${device.protocol} · ${device.pollIntervalMilliseconds} ms`;
    node.querySelector(".device-outcome").textContent = device.lastOutcome;
    node.querySelector(".device-error").textContent = device.lastError ?? "";

    const metricsNode = node.querySelector(".device-metrics");
    const telemetry = device.latestTelemetry;
    const metricEntries = telemetry
      ? [
          ["Pack voltage", telemetry.totalVoltageVolts, "totalVoltageVolts"],
          ["Current", telemetry.currentAmps, "currentAmps"],
          ["Power", telemetry.powerWatts, "powerWatts"],
          ["SOC", telemetry.stateOfChargePercent, "stateOfChargePercent"],
          ["Cell delta", telemetry.deltaCellVoltageVolts, "deltaCellVoltageVolts"],
          ["MOS temp", telemetry.mosTemperatureCelsius, "mosTemperatureCelsius"]
        ]
      : [];

    metricsNode.innerHTML = metricEntries.map(([label, value, key]) => `
      <div class="metric">
        <span class="metric-label">${label}</span>
        <span class="metric-value">${formatMetric(key, value)}</span>
      </div>
    `).join("");

    const flagsNode = node.querySelector(".device-flags");
    flagsNode.innerHTML = renderFlags(telemetry);
    deviceList.appendChild(node);
  }
}

function renderFlags(telemetry) {
  if (!telemetry) {
    return '<span class="flag">No telemetry yet</span>';
  }

  const flags = [
    ["Charging", telemetry.chargingEnabled],
    ["Discharging", telemetry.dischargingEnabled],
    ["Balancing", telemetry.balancingEnabled],
    ["Battery online", telemetry.batteryOnline]
  ];

  const warningFlags = (telemetry.activeWarnings ?? []).map((warning) => [warning, true]);

  return [...flags, ...warningFlags].map(([label, active]) => `
    <span class="flag ${active ? "is-active" : ""}">${label}</span>
  `).join("");
}

function formatMetric(key, value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return metricFormatters[key] ? metricFormatters[key](Number(value)) : String(value);
}

refresh();
setInterval(refresh, 5000);