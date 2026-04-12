export type DeviceTelemetrySnapshot = {
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  stateOfChargePercent?: number | null;
};

export type DeviceRuntimeState = {
  deviceId: string;
  displayName: string;
  protocolHandler?: string | null;
  enabled: boolean;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  lastPollStartedAt?: string | null;
  lastPollCompletedAt?: string | null;
  lastOutcome: string;
  lastError?: string | null;
  lastPersistedAt?: string | null;
  latestTelemetry?: DeviceTelemetrySnapshot | null;
};

export type SystemRuntimeMetrics = {
  cpuUtilizationPercent?: number | null;
  cpuCoreCount?: number | null;
  cpuMaxClockSpeedMegahertz?: number | null;
  cpuCurrentClockSpeedMegahertz?: number | null;
  cpuIsThrottled?: boolean | null;
  processCount?: number | null;
  systemUptimeSeconds?: number | null;
  memoryAvailableBytes?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  storageUsedBytes?: number | null;
  storageTotalBytes?: number | null;
  mainFanSpeedRpm?: number | null;
  systemTemperatureCelsius?: number | null;
};

export type BuildRuntimeInfo = {
  releaseTag?: string | null;
  sourceRevisionId?: string | null;
  informationalVersion?: string | null;
  workflowRunNumber?: string | null;
  workflowRunAttempt?: string | null;
  builtAt?: string | null;
};

export type MonitorRuntimeStatus = {
  serviceName: string;
  environmentName: string;
  startupMode: string;
  startedAt: string;
  reportedAt: string;
  configuredDeviceCount: number;
  enabledDeviceCount: number;
  build?: BuildRuntimeInfo | null;
  systemMetrics?: SystemRuntimeMetrics | null;
  devices: DeviceRuntimeState[];
};

export type TableSizeInfo = {
  tableName: string;
  sizeBytes: number;
  sizeFormatted: string;
  rowCount: number;
};

export type DatabaseSizeInfo = {
  totalSizeBytes: number;
  totalSizeFormatted: string;
  tables: TableSizeInfo[];
};

export type DatabaseSettingsState = {
  rawSecondsWindowMinutes: number;
  persistedBucketMinutes: number;
};

export type SaveDatabaseSettingsResponse = {
  restartScheduled: boolean;
  message: string;
  settings: DatabaseSettingsState;
};

export type DatabaseSettingsFormState = {
  rawSecondsWindowMinutes: string;
  persistedBucketMinutes: string;
};

export type CommitInfo = {
  sha?: string | null;
  message?: string | null;
  date?: string | null;
};

export type UpdateCheckResult = {
  currentReleaseTag?: string | null;
  currentSourceRevision?: string | null;
  currentBuiltAt?: string | null;
  currentWorkflowRunNumber?: string | null;
  currentWorkflowRunAttempt?: string | null;
  currentReleasePublishedAt?: string | null;
  currentChannel?: string | null;
  preferredChannel?: string | null;
  targetChannel?: string | null;
  targetReleaseTag?: string | null;
  checkedAt?: string | null;
  canUpdate: boolean;
  reason?: string | null;
  updateAvailable: boolean;
  remoteReleasePublishedAt?: string | null;
  remoteChecksum?: string | null;
  localChecksum?: string | null;
  checkError?: string | null;
  commits?: CommitInfo[] | null;
};

export type SerialPortInfo = {
  name: string;
  description?: string | null;
};

export type BlockDeviceInfo = {
  name: string;
  model?: string | null;
  sizeBytes: number;
  sizeFormatted?: string | null;
  readOnly: boolean;
};

export type NetworkInterfaceInfo = {
  name: string;
  description?: string | null;
  type?: string | null;
  status?: string | null;
  macAddress?: string | null;
  addresses: string[];
  speedMbps?: number | null;
};

export type SystemInterfacesResponse = {
  serialPorts: SerialPortInfo[];
  blockDevices: BlockDeviceInfo[];
  networkInterfaces: NetworkInterfaceInfo[];
};

export type EthernetInterfaceSnapshot = {
  name: string;
  description?: string | null;
  status?: string | null;
  macAddress?: string | null;
  addresses: string[];
  speedMbps?: number | null;
  connectionName?: string | null;
  connectionState?: string | null;
  enabled?: boolean | null;
  carrierDetected?: boolean | null;
};

export type WifiInterfaceSnapshot = {
  name: string;
  description?: string | null;
  status?: string | null;
  macAddress?: string | null;
  addresses: string[];
  speedMbps?: number | null;
  connectionName?: string | null;
  connectionState?: string | null;
  connectedSsid?: string | null;
  connectedBssid?: string | null;
  signalPercent?: number | null;
  security?: string | null;
  signalBars?: string | null;
};

export type NetworkConnectivitySnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  wifiPowered?: boolean | null;
  hasInternetAccess?: boolean | null;
  ethernetInterfaces: EthernetInterfaceSnapshot[];
  wifiInterfaces: WifiInterfaceSnapshot[];
};

export type WifiAccessPointInfo = {
  interfaceName: string;
  ssid: string;
  bssid?: string | null;
  signalPercent?: number | null;
  security?: string | null;
  signalBars?: string | null;
  isActive: boolean;
};

export type WifiScanResult = {
  supported: boolean;
  statusMessage?: string | null;
  accessPoints: WifiAccessPointInfo[];
};

export type WifiConnectResult = {
  success: boolean;
  message: string;
  interfaceName?: string | null;
  connectedSsid?: string | null;
  hasInternetAccess?: boolean | null;
};

export type WifiStoredCredentialResult = {
  storageAvailable: boolean;
  ssid?: string | null;
  hasStoredPassword: boolean;
  password?: string | null;
  lastBssid?: string | null;
};

export type WifiPowerResult = {
  success: boolean;
  powered: boolean;
  message: string;
};

export type EthernetPowerResult = {
  success: boolean;
  interfaceName: string;
  enabled: boolean;
  message: string;
};

export type BluetoothDeviceSnapshot = {
  address: string;
  alias?: string | null;
  name?: string | null;
  displayName: string;
  isConnected: boolean;
  isPaired: boolean;
  rssi?: number | null;
  advertisedServiceUuids: string[];
};

export type BluetoothRuntimeSnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  powered: boolean;
  devices: BluetoothDeviceSnapshot[];
};

export type BluetoothScanResult = {
  supported: boolean;
  statusMessage?: string | null;
  powered: boolean;
  devices: BluetoothDeviceSnapshot[];
};

export type BluetoothPowerResult = {
  success: boolean;
  powered: boolean;
  message: string;
};

export type SshServiceSnapshot = {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  statusMessage?: string | null;
  serviceLoadState?: string | null;
  serviceActiveState?: string | null;
  serviceSubState?: string | null;
  serviceUnitFileState?: string | null;
  serviceResult?: string | null;
};

export type SshServiceCommandResult = {
  success: boolean;
  enabled: boolean;
  active: boolean;
  message: string;
};

export type WebTerminalSnapshot = {
  supported: boolean;
  enabled: boolean;
  storageAvailable: boolean;
  activeSessionCount: number;
  statusMessage?: string | null;
  shellPath?: string | null;
  transport?: string | null;
};

export type WebTerminalCommandResult = {
  success: boolean;
  enabled: boolean;
  message: string;
  snapshot: WebTerminalSnapshot;
};

export type DirectAccessSettingsSnapshot = {
  storageAvailable: boolean;
  autoStartMode: 'off' | 'when-wifi-not-connected' | string;
  wifiPassword?: string | null;
  hotspotName?: string | null;
  bluetoothDeviceName?: string | null;
};

export type WifiDirectAccessSnapshot = {
  supported: boolean;
  enabled: boolean;
  statusMessage?: string | null;
  interfaceName?: string | null;
  currentNetworkName?: string | null;
  disconnectsCurrentWifi: boolean;
  ssid?: string | null;
  addresses: string[];
};

export type BluetoothDirectAccessSnapshot = {
  supported: boolean;
  enabled: boolean;
  statusMessage?: string | null;
  interfaceName?: string | null;
  deviceName?: string | null;
  requiresPairing: boolean;
  discoverable: boolean;
  pairable: boolean;
  addresses: string[];
};

export type LocalAccessModeSnapshot = {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  hostName: string;
  statusMessage?: string | null;
  hotspotName?: string | null;
  hotspotPassword?: string | null;
  addresses: string[];
};

export type DirectAccessSnapshot = {
  settings: DirectAccessSettingsSnapshot;
  mode: LocalAccessModeSnapshot;
  wifi: WifiDirectAccessSnapshot;
  bluetooth: BluetoothDirectAccessSnapshot;
};

export type SystemConnectivitySnapshot = {
  network: NetworkConnectivitySnapshot;
  bluetooth: BluetoothRuntimeSnapshot;
  ssh: SshServiceSnapshot;
  terminal: WebTerminalSnapshot;
  directAccess: DirectAccessSnapshot;
};

export type LocalAccessModeCommandResult = {
  success: boolean;
  enabled: boolean;
  active: boolean;
  message: string;
};

export type SaveDirectAccessSettingsResult = {
  success: boolean;
  message: string;
  settings: DirectAccessSettingsSnapshot;
};

export type CloudflareTunnelStatusSnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  tunnelProvider: string;
  hasStoredToken: boolean;
  maskedToken?: string | null;
  configured: boolean;
  packageInstalled: boolean;
  packageVersion?: string | null;
  serviceInstalled: boolean;
  serviceRunning: boolean;
  serviceEnabled: boolean;
  serviceLoadState?: string | null;
  serviceActiveState?: string | null;
  serviceSubState?: string | null;
  serviceUnitFileState?: string | null;
  serviceResult?: string | null;
};

export type InternetSpeedTestServerSnapshot = {
  id?: string | null;
  sponsor?: string | null;
  name?: string | null;
  country?: string | null;
  distanceKilometers?: number | null;
  latencyMilliseconds?: number | null;
};

export type InternetSpeedTestClientSnapshot = {
  ipAddress?: string | null;
  internetServiceProvider?: string | null;
  country?: string | null;
};

export type InternetSpeedTestResult = {
  downloadBitsPerSecond?: number | null;
  uploadBitsPerSecond?: number | null;
  pingMilliseconds?: number | null;
  bytesReceived?: number | null;
  bytesSent?: number | null;
  testedAt?: string | null;
  shareUrl?: string | null;
  connectionMode?: string | null;
  server?: InternetSpeedTestServerSnapshot | null;
  client?: InternetSpeedTestClientSnapshot | null;
};

export type InternetSpeedTestSnapshot = {
  supported: boolean;
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'unsupported' | string;
  backend: string;
  canStart: boolean;
  isRunning: boolean;
  statusMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  lastUpdatedAt?: string | null;
  stage?: string | null;
  stepIndex?: number | null;
  stepCount?: number | null;
  stagePercentComplete?: number | null;
  percentComplete?: number | null;
  result?: InternetSpeedTestResult | null;
};

export type InternetSpeedTestCommandResult = {
  success: boolean;
  message: string;
  snapshot: InternetSpeedTestSnapshot;
};

export type SaveCloudflareTunnelResponse = {
  success: boolean;
  message: string;
  status: CloudflareTunnelStatusSnapshot;
};

export type InlineFeedback = {
  message: string;
  isError: boolean;
};

export type PendingConnectivityAction = {
  kind: 'disable-wifi';
  interfaceName: string;
  connectionName?: string | null;
};

export type WifiConnectDialogState = {
  interfaceName: string;
  ssid: string;
  bssid?: string | null;
  requiresPassword: boolean;
  allowSsidEdit: boolean;
  title: string;
};

export type ModbusRegisterKind = 'holding' | 'input';

export type ModbusScannerReadRequest = {
  portName: string;
  slaveAddress: number;
  baudRate: number;
  parity: string;
  dataBits: number;
  stopBits: number;
  responseTimeoutMs: number;
  retryCount: number;
  startRegister: number;
  registerCount: number;
  registersPerRequest: number;
  registerKind: ModbusRegisterKind;
};

export type ModbusScannerReadBlock = {
  startAddress: number;
  registerCount: number;
  attempts: number;
};

export type ModbusScannerRegisterValue = {
  address: number;
  highByte: number;
  lowByte: number;
  unsignedValue: number;
  hexValue: string;
};

export type ModbusScannerReadResult = {
  portName: string;
  slaveAddress: number;
  baudRate: number;
  parity: string;
  dataBits: number;
  stopBits: number;
  responseTimeoutMs: number;
  retryCount: number;
  registerKind: ModbusRegisterKind;
  startRegister: number;
  registerCount: number;
  registersPerRequest: number;
  collectedAtUtc: string;
  totalRequests: number;
  blocks: ModbusScannerReadBlock[];
  registers: ModbusScannerRegisterValue[];
};
