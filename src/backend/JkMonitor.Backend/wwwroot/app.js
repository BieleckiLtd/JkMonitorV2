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
const setupNote = document.querySelector("#setup-note");
const setupForm = document.querySelector("#setup-form");
const setupStatus = document.querySelector("#setup-status");
const setupFeedback = document.querySelector("#setup-feedback");
const useDatabaseInput = document.querySelector("#use-database");
const connectionStringInput = document.querySelector("#connection-string");
const connectionGroup = document.querySelector("#connection-group");
const serialGroup = document.querySelector("#serial-group");
const serialPortSelect = document.querySelector("#serial-port-select");
const serialPortInput = document.querySelector("#serial-port-input");
const serialPortHint = document.querySelector("#serial-port-hint");
const refreshPortsButton = document.querySelector("#refresh-ports");
const applySetupButton = document.querySelector("#apply-setup");

let latestSetupState = null;

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

async function loadSetupState() {
  setupStatus.textContent = "Loading current configuration";

  try {
    const response = await fetch("/api/setup");
    if (!response.ok) {
      throw new Error(`Setup request failed (${response.status})`);
    }

    latestSetupState = await response.json();
    renderSetupState(latestSetupState);
  } catch (error) {
    setupStatus.textContent = "Setup unavailable";
    setupFeedback.textContent = error.message;
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
    setupCopy.textContent = "The UI is ready now. Use the setup panel below whenever you want to switch this install to real RS485 hardware.";
    setupNote.textContent = "Pick Hardware in Setup, choose a serial port, then apply the configuration.";
    return;
  }

  setupTitle.textContent = "JK Monitor is live in hardware mode";
  setupCopy.textContent = "The app is using the configured serial device. You can change the port or storage settings below and apply them from the browser.";
  setupNote.textContent = "Changes are saved locally on the device and applied after restart.";
}

function renderSetupState(state) {
  setupStatus.textContent = `Current mode: ${state.currentStartupMode}`;
  setupFeedback.textContent = state.applyMessage;

  const selectedMode = setupForm.querySelector(`input[name="startupMode"][value="${state.currentStartupMode}"]`);
  if (selectedMode) {
    selectedMode.checked = true;
  }

  useDatabaseInput.checked = !!state.useDatabase;
  connectionStringInput.value = state.connectionString ?? "";
  serialPortInput.value = state.serialPort ?? "";

  renderSerialPorts(state.serialPorts ?? [], state.serialPort ?? "");
  updateSetupFieldVisibility();
}

function renderSerialPorts(serialPorts, selectedPort) {
  const options = serialPorts.length === 0
    ? '<option value="">No device ports detected yet</option>'
    : ['<option value="">Select a detected port</option>', ...serialPorts.map((port) => `<option value="${escapeHtml(port)}">${escapeHtml(port)}</option>`)].join("");

  serialPortSelect.innerHTML = options;
  if (selectedPort) {
    serialPortSelect.value = serialPorts.includes(selectedPort) ? selectedPort : "";
  }

  serialPortHint.textContent = serialPorts.length === 0
    ? "No device-side serial ports were detected yet. You can still type one manually."
    : "Pick a detected device port or type one manually if needed.";
}

function updateSetupFieldVisibility() {
  const startupMode = getSelectedStartupMode();
  const isHardware = startupMode === "Hardware";

  serialGroup.classList.toggle("is-hidden", !isHardware);
  connectionGroup.classList.toggle("is-hidden", !useDatabaseInput.checked);
}

function getSelectedStartupMode() {
  return setupForm.querySelector('input[name="startupMode"]:checked')?.value ?? "Simulator";
}

async function applySetup(event) {
  event.preventDefault();

  const startupMode = getSelectedStartupMode();
  const useDatabase = useDatabaseInput.checked;
  const serialPort = serialPortInput.value.trim() || serialPortSelect.value.trim();
  const connectionString = connectionStringInput.value.trim();

  if (startupMode === "Hardware" && !serialPort) {
    setupFeedback.textContent = "Choose or type a serial port before switching to hardware mode.";
    return;
  }

  if (useDatabase && !connectionString) {
    setupFeedback.textContent = "Enter a PostgreSQL connection string before enabling database storage.";
    return;
  }

  applySetupButton.disabled = true;
  refreshPortsButton.disabled = true;
  setupStatus.textContent = "Saving configuration";
  setupFeedback.textContent = "Applying your settings on the device.";

  try {
    const response = await fetch("/api/setup/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        startupMode,
        useDatabase,
        connectionString,
        serialPort,
        restartApplication: true
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message ?? `Setup apply failed (${response.status})`);
    }

    setupStatus.textContent = payload.restartScheduled ? "Restarting JK Monitor" : "Configuration saved";
    setupFeedback.textContent = payload.message;

    if (payload.restartScheduled) {
      await waitForRestart();
      await Promise.all([loadSetupState(), refresh()]);
      setupFeedback.textContent = `${payload.message} The app is back online.`;
    } else {
      await loadSetupState();
    }
  } catch (error) {
    setupStatus.textContent = "Setup update failed";
    setupFeedback.textContent = error.message;
  } finally {
    applySetupButton.disabled = false;
    refreshPortsButton.disabled = false;
  }
}

async function waitForRestart() {
  await delay(1500);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (response.ok) {
        return;
      }
    } catch {
    }

    await delay(1000);
  }

  throw new Error("The app did not come back online in time after restarting.");
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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

setupForm.addEventListener("submit", applySetup);
setupForm.querySelectorAll('input[name="startupMode"]').forEach((input) => {
  input.addEventListener("change", updateSetupFieldVisibility);
});
useDatabaseInput.addEventListener("change", updateSetupFieldVisibility);
refreshPortsButton.addEventListener("click", loadSetupState);
serialPortSelect.addEventListener("change", () => {
  if (!serialPortInput.value.trim()) {
    serialPortInput.value = serialPortSelect.value;
  }
});

loadSetupState();
refresh();
setInterval(refresh, 5000);