import { useEffect, useState, useRef, useCallback } from 'react';
import { CircleAlert, LoaderCircle, Wifi } from 'lucide-react';
import { Navigate, useParams } from 'react-router-dom';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { type UpdateProgress } from '../lib/systemUpdate';
import { cn } from '../lib/utils';
import { useAppStore } from '../store/useAppStore';
import { getSystemSectionFromRouteSegment, getSystemSectionPath } from '../lib/systemNavigation';
import { LogsSection } from './system-page/LogsSection';
import { ResourceUsageSection } from './system-page/ResourceUsageSection';
import { SoftwareUpdateSection } from './system-page/SoftwareUpdateSection';
import { WifiMenuItem } from './system-page/WifiMenuItem';
import { BluetoothMenuItem } from './system-page/BluetoothMenuItem';
import { SshMenuItem } from './system-page/SshMenuItem';
import { WebTerminalMenuItem } from './system-page/WebTerminalMenuItem';
import { EthernetMenuItem } from './system-page/EthernetMenuItem';
import { LocalAccessMenuItem } from './system-page/LocalAccessMenuItem';
import { InternetSpeedMenuItem } from './system-page/InternetSpeedMenuItem';
import { TunnelMenuItem } from './system-page/TunnelMenuItem';
import { HardwareInterfacesSection } from './system-page/HardwareInterfacesSection';
import { DatabaseSection } from './system-page/DatabaseSection';
import { ModbusScannerSection } from './system-page/ModbusScannerSection';
import { TerminalSection } from './system-page/TerminalSection';

type DeviceTelemetrySnapshot = {
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  stateOfChargePercent?: number | null;
};

type DeviceRuntimeState = {
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

type SystemRuntimeMetrics = {
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

type BuildRuntimeInfo = {
  releaseTag?: string | null;
  sourceRevisionId?: string | null;
  informationalVersion?: string | null;
  workflowRunNumber?: string | null;
  workflowRunAttempt?: string | null;
  builtAt?: string | null;
};

type MonitorRuntimeStatus = {
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

type MonitorRuntimeStatusStreamEnvelope = {
  status: MonitorRuntimeStatus;
};

const reconnectDelayMs = 2000;
const fallbackRefreshIntervalMs = 5000;
const updateCheckCooldownMs = 30000;
const monitorHttpPort = 5074;
const noDataLabel = 'N/D';

type TableSizeInfo = {
  tableName: string;
  sizeBytes: number;
  sizeFormatted: string;
  rowCount: number;
};

type DatabaseSizeInfo = {
  totalSizeBytes: number;
  totalSizeFormatted: string;
  tables: TableSizeInfo[];
};

type DatabaseSettingsState = {
  rawSecondsWindowMinutes: number;
  persistedBucketMinutes: number;
};

type SaveDatabaseSettingsResponse = {
  restartScheduled: boolean;
  message: string;
  settings: DatabaseSettingsState;
};

type DatabaseSettingsFormState = {
  rawSecondsWindowMinutes: string;
  persistedBucketMinutes: string;
};

const supportedTemporaryHistoryMinutes = [1, 5, 10, 30];
const supportedPersistedBucketMinutes = [1, 5, 10, 30];

type CommitInfo = {
  sha?: string | null;
  message?: string | null;
  date?: string | null;
};

type UpdateCheckResult = {
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

type SerialPortInfo = {
  name: string;
  description?: string | null;
};

type BlockDeviceInfo = {
  name: string;
  model?: string | null;
  sizeBytes: number;
  sizeFormatted?: string | null;
  readOnly: boolean;
};

type NetworkInterfaceInfo = {
  name: string;
  description?: string | null;
  type?: string | null;
  status?: string | null;
  macAddress?: string | null;
  addresses: string[];
  speedMbps?: number | null;
};

type SystemInterfacesResponse = {
  serialPorts: SerialPortInfo[];
  blockDevices: BlockDeviceInfo[];
  networkInterfaces: NetworkInterfaceInfo[];
};

type EthernetInterfaceSnapshot = {
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

type WifiInterfaceSnapshot = {
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

type NetworkConnectivitySnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  wifiPowered?: boolean | null;
  hasInternetAccess?: boolean | null;
  ethernetInterfaces: EthernetInterfaceSnapshot[];
  wifiInterfaces: WifiInterfaceSnapshot[];
};

type WifiAccessPointInfo = {
  interfaceName: string;
  ssid: string;
  bssid?: string | null;
  signalPercent?: number | null;
  security?: string | null;
  signalBars?: string | null;
  isActive: boolean;
};

type WifiScanResult = {
  supported: boolean;
  statusMessage?: string | null;
  accessPoints: WifiAccessPointInfo[];
};

type WifiConnectResult = {
  success: boolean;
  message: string;
  interfaceName?: string | null;
  connectedSsid?: string | null;
  hasInternetAccess?: boolean | null;
};

type WifiStoredCredentialResult = {
  storageAvailable: boolean;
  ssid?: string | null;
  hasStoredPassword: boolean;
  password?: string | null;
  lastBssid?: string | null;
};

type WifiPowerResult = {
  success: boolean;
  powered: boolean;
  message: string;
};

type EthernetPowerResult = {
  success: boolean;
  interfaceName: string;
  enabled: boolean;
  message: string;
};

type BluetoothDeviceSnapshot = {
  address: string;
  alias?: string | null;
  name?: string | null;
  displayName: string;
  isConnected: boolean;
  isPaired: boolean;
  rssi?: number | null;
  advertisedServiceUuids: string[];
};

type BluetoothRuntimeSnapshot = {
  supported: boolean;
  statusMessage?: string | null;
  powered: boolean;
  devices: BluetoothDeviceSnapshot[];
};

type BluetoothScanResult = {
  supported: boolean;
  statusMessage?: string | null;
  powered: boolean;
  devices: BluetoothDeviceSnapshot[];
};

type BluetoothPowerResult = {
  success: boolean;
  powered: boolean;
  message: string;
};

type SshServiceSnapshot = {
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

type SshServiceCommandResult = {
  success: boolean;
  enabled: boolean;
  active: boolean;
  message: string;
};

type WebTerminalSnapshot = {
  supported: boolean;
  enabled: boolean;
  storageAvailable: boolean;
  activeSessionCount: number;
  statusMessage?: string | null;
  shellPath?: string | null;
  transport?: string | null;
};

type WebTerminalCommandResult = {
  success: boolean;
  enabled: boolean;
  message: string;
  snapshot: WebTerminalSnapshot;
};

type SystemConnectivitySnapshot = {
  network: NetworkConnectivitySnapshot;
  bluetooth: BluetoothRuntimeSnapshot;
  ssh: SshServiceSnapshot;
  terminal: WebTerminalSnapshot;
  directAccess: DirectAccessSnapshot;
};

type DirectAccessSettingsSnapshot = {
  storageAvailable: boolean;
  autoStartMode: 'off' | 'when-wifi-not-connected' | string;
  wifiPassword?: string | null;
  hotspotName?: string | null;
  bluetoothDeviceName?: string | null;
};

type WifiDirectAccessSnapshot = {
  supported: boolean;
  enabled: boolean;
  statusMessage?: string | null;
  interfaceName?: string | null;
  currentNetworkName?: string | null;
  disconnectsCurrentWifi: boolean;
  ssid?: string | null;
  addresses: string[];
};

type BluetoothDirectAccessSnapshot = {
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

type DirectAccessSnapshot = {
  settings: DirectAccessSettingsSnapshot;
  mode: LocalAccessModeSnapshot;
  wifi: WifiDirectAccessSnapshot;
  bluetooth: BluetoothDirectAccessSnapshot;
};

type LocalAccessModeSnapshot = {
  supported: boolean;
  enabled: boolean;
  active: boolean;
  hostName: string;
  statusMessage?: string | null;
  hotspotName?: string | null;
  hotspotPassword?: string | null;
  addresses: string[];
};

type LocalAccessModeCommandResult = {
  success: boolean;
  enabled: boolean;
  active: boolean;
  message: string;
};

type SaveDirectAccessSettingsResult = {
  success: boolean;
  message: string;
  settings: DirectAccessSettingsSnapshot;
};

type CloudflareTunnelStatusSnapshot = {
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

type InternetSpeedTestServerSnapshot = {
  id?: string | null;
  sponsor?: string | null;
  name?: string | null;
  country?: string | null;
  distanceKilometers?: number | null;
  latencyMilliseconds?: number | null;
};

type InternetSpeedTestClientSnapshot = {
  ipAddress?: string | null;
  internetServiceProvider?: string | null;
  country?: string | null;
};

type InternetSpeedTestResult = {
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

type InternetSpeedTestSnapshot = {
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

type InternetSpeedTestCommandResult = {
  success: boolean;
  message: string;
  snapshot: InternetSpeedTestSnapshot;
};

type SaveCloudflareTunnelResponse = {
  success: boolean;
  message: string;
  status: CloudflareTunnelStatusSnapshot;
};

type InlineFeedback = {
  message: string;
  isError: boolean;
};

type PendingConnectivityAction = {
  kind: 'disable-wifi';
  interfaceName: string;
  connectionName?: string | null;
};

type WifiConnectDialogState = {
  interfaceName: string;
  ssid: string;
  bssid?: string | null;
  requiresPassword: boolean;
  allowSsidEdit: boolean;
  title: string;
};

type FluxMonitorWindow = Window & typeof globalThis & {
  __fluxMonitorSoftwareUpdateCheckInFlight?: boolean;
  __fluxMonitorSoftwareUpdateCheckStartedAt?: number;
  __fluxMonitorSoftwareUpdateCheckResult?: UpdateCheckResult | null;
};

function createDatabaseSettingsFormState(settings: DatabaseSettingsState): DatabaseSettingsFormState {
  return {
    rawSecondsWindowMinutes: String(settings.rawSecondsWindowMinutes),
    persistedBucketMinutes: String(settings.persistedBucketMinutes),
  };
}

function parsePositiveInteger(value: string, label: string) {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${label} must be a whole number greater than zero.`);
  }

  return Number.parseInt(trimmed, 10);
}

function parseSupportedMinutes(value: string, label: string, supportedValues: number[]) {
  const minutes = parsePositiveInteger(value, label);
  if (!supportedValues.includes(minutes)) {
    throw new Error(`${label} must be one of: ${supportedValues.join(', ')}.`);
  }

  return minutes;
}

function getFluxMonitorWindow() {
  return typeof window === 'undefined' ? null : window as FluxMonitorWindow;
}

export function SystemPage() {
  const { sectionId } = useParams<{ sectionId?: string }>();
  const routedSystemSection = getSystemSectionFromRouteSegment(sectionId);
  const activeSystemSection = routedSystemSection;
  const updateProgress = useAppStore((state) => state.updateProgress);
  const updateActionPending = useAppStore((state) => state.updateActionPending);
  const startSystemUpdate = useAppStore((state) => state.startSystemUpdate);
  const [status, setStatus] = useState<MonitorRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dbSize, setDbSize] = useState<DatabaseSizeInfo | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbSettings, setDbSettings] = useState<DatabaseSettingsState | null>(null);
  const [dbSettingsForm, setDbSettingsForm] = useState<DatabaseSettingsFormState | null>(null);
  const [dbSettingsLoading, setDbSettingsLoading] = useState(false);
  const [dbSettingsSaving, setDbSettingsSaving] = useState(false);
  const [dbSettingsFeedback, setDbSettingsFeedback] = useState<InlineFeedback | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(() => getFluxMonitorWindow()?.__fluxMonitorSoftwareUpdateCheckResult ?? null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateActionError, setUpdateActionError] = useState<string | null>(null);
  const [updateChannelSaving, setUpdateChannelSaving] = useState(false);
  const [updateChannelError, setUpdateChannelError] = useState<string | null>(null);
  const [interfaces, setInterfaces] = useState<SystemInterfacesResponse | null>(null);
  const [connectivity, setConnectivity] = useState<SystemConnectivitySnapshot | null>(null);
  const [connectivityLoading, setConnectivityLoading] = useState(true);
  const [connectivityError, setConnectivityError] = useState<string | null>(null);
  const [cloudflareTunnelStatus, setCloudflareTunnelStatus] = useState<CloudflareTunnelStatusSnapshot | null>(null);
  const [cloudflareTunnelLoading, setCloudflareTunnelLoading] = useState(true);
  const [cloudflareTunnelError, setCloudflareTunnelError] = useState<string | null>(null);
  const [cloudflareTunnelFeedback, setCloudflareTunnelFeedback] = useState<InlineFeedback | null>(null);
  const [cloudflareTunnelSaving, setCloudflareTunnelSaving] = useState(false);
  const [cloudflareTunnelEnabled, setCloudflareTunnelEnabled] = useState(false);
  const [cloudflareTunnelTokenOrCommand, setCloudflareTunnelTokenOrCommand] = useState('');
  const [internetSpeedTest, setInternetSpeedTest] = useState<InternetSpeedTestSnapshot | null>(null);
  const [internetSpeedTestLoading, setInternetSpeedTestLoading] = useState(true);
  const [internetSpeedTestStarting, setInternetSpeedTestStarting] = useState(false);
  const [internetSpeedTestError, setInternetSpeedTestError] = useState<string | null>(null);
  const [wifiScanLoading, setWifiScanLoading] = useState<string | null>(null);
  const [wifiAccessPoints, setWifiAccessPoints] = useState<Record<string, WifiAccessPointInfo[]>>({});
  const [wifiTargetInterface, setWifiTargetInterface] = useState('');
  const [wifiTargetSsid, setWifiTargetSsid] = useState('');
  const [wifiTargetBssid, setWifiTargetBssid] = useState<string | null>(null);
  const [wifiPassword, setWifiPassword] = useState('');
  const [wifiShowPassword, setWifiShowPassword] = useState(false);
  const [wifiPasswordDirty, setWifiPasswordDirty] = useState(false);
  const [wifiConnectDialog, setWifiConnectDialog] = useState<WifiConnectDialogState | null>(null);
  const [wifiFeedback, setWifiFeedback] = useState<InlineFeedback | null>(null);
  const [wifiConnectLoading, setWifiConnectLoading] = useState(false);
  const [wifiPowerLoading, setWifiPowerLoading] = useState(false);
  const [bluetoothScanResult, setBluetoothScanResult] = useState<BluetoothScanResult | null>(null);
  const [bluetoothScanLoading, setBluetoothScanLoading] = useState(false);
  const [bluetoothPowerLoading, setBluetoothPowerLoading] = useState(false);
  const [bluetoothFeedback, setBluetoothFeedback] = useState<InlineFeedback | null>(null);
  const [sshToggleLoading, setSshToggleLoading] = useState(false);
  const [terminalToggleLoading, setTerminalToggleLoading] = useState(false);
  const [localAccessModeLoading, setLocalAccessModeLoading] = useState(false);
  const [localAccessModeFeedback, setLocalAccessModeFeedback] = useState<InlineFeedback | null>(null);
  const [localAccessHotspotName, setLocalAccessHotspotName] = useState('');
  const [localAccessBluetoothName, setLocalAccessBluetoothName] = useState('');
  const [localAccessWifiPassword, setLocalAccessWifiPassword] = useState('');
  const [localAccessShowPassword, setLocalAccessShowPassword] = useState(false);
  const [localAccessAdvancedOpen, setLocalAccessAdvancedOpen] = useState(false);
  const [localAccessSettingsSaving, setLocalAccessSettingsSaving] = useState(false);
  const [localAccessSettingsFeedback, setLocalAccessSettingsFeedback] = useState<InlineFeedback | null>(null);
  const [ethernetPowerLoading, setEthernetPowerLoading] = useState(false);
  const [ethernetFeedback, setEthernetFeedback] = useState<InlineFeedback | null>(null);
  const [pendingConnectivityAction, setPendingConnectivityAction] = useState<PendingConnectivityAction | null>(null);
  const [expandedConnectivitySection, setExpandedConnectivitySection] = useState<'wifi' | 'bluetooth' | 'ethernet' | 'local-access' | 'internet-speed' | 'tunnel' | null>(null);
  const previousUpdateStatusRef = useRef<UpdateProgress['status'] | null>(null);
  const wifiCredentialRequestRef = useRef(0);
  const cloudflareTunnelDirtyRef = useRef(false);
  const internetSpeedTestRequestInFlightRef = useRef(false);
  const localAccessSettingsDirtyRef = useRef(false);
  const systemPageRef = useRef<HTMLDivElement>(null);

  const loadInternetSpeedTest = useCallback(async () => {
    if (internetSpeedTestRequestInFlightRef.current) {
      return;
    }

    internetSpeedTestRequestInFlightRef.current = true;

    try {
      const response = await fetch('/api/system/internet-speed', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load internet speed status.');
      }

      const data = await response.json() as InternetSpeedTestSnapshot;
      setInternetSpeedTest(data);
      setInternetSpeedTestError(null);
    } catch (error) {
      setInternetSpeedTestError(error instanceof Error ? error.message : 'Unable to load internet speed status.');
    } finally {
      internetSpeedTestRequestInFlightRef.current = false;
      setInternetSpeedTestLoading(false);
    }
  }, []);

  const loadCloudflareTunnelStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/system/cloudflare-tunnel', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load Cloudflare Tunnel status.');
      }

      const data = await response.json() as CloudflareTunnelStatusSnapshot;
      setCloudflareTunnelStatus(data);
      setCloudflareTunnelError(null);

      if (!cloudflareTunnelDirtyRef.current) {
        setCloudflareTunnelEnabled(stringEqualsIgnoreCase(data.tunnelProvider, 'cloudflared'));
      }
    } catch (error) {
      setCloudflareTunnelError(error instanceof Error ? error.message : 'Unable to load Cloudflare Tunnel status.');
    } finally {
      setCloudflareTunnelLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    let requestInFlight = false;
    let eventSource: EventSource | null = null;
    let reconnectTimerId: number | null = null;
    let fallbackIntervalId: number | null = null;

    const applyStatus = (nextStatus: MonitorRuntimeStatus) => {
      if (!isMounted) {
        return;
      }

      setStatus(nextStatus);
      setLoadError(null);
      setIsLoading(false);
    };

    const loadStatus = async () => {
      if (requestInFlight) {
        return;
      }

      requestInFlight = true;

      try {
        const response = await fetch('/api/health', { cache: 'no-store' });

        if (!response.ok) {
          throw new Error('Unable to load runtime status.');
        }

        const data = (await response.json()) as MonitorRuntimeStatus;
        applyStatus(data);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setLoadError(error instanceof Error ? error.message : 'Unable to load runtime status.');
      } finally {
        requestInFlight = false;

        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerId == null) {
        return;
      }

      window.clearTimeout(reconnectTimerId);
      reconnectTimerId = null;
    };

    const closeEventSource = () => {
      if (!eventSource) {
        return;
      }

      eventSource.close();
      eventSource = null;
    };

    const connectStream = () => {
      if (!isMounted) {
        return;
      }

      if (typeof EventSource === 'undefined') {
        if (fallbackIntervalId == null) {
          fallbackIntervalId = window.setInterval(() => {
            void loadStatus();
          }, fallbackRefreshIntervalMs);
        }
        return;
      }

      clearReconnectTimer();
      closeEventSource();

      const stream = new EventSource('/api/health/stream');
      eventSource = stream;

      stream.onmessage = (event) => {
        let payload: MonitorRuntimeStatus | MonitorRuntimeStatusStreamEnvelope;

        try {
          payload = JSON.parse(event.data) as MonitorRuntimeStatus | MonitorRuntimeStatusStreamEnvelope;
        } catch {
          setLoadError('Unable to read runtime status stream.');
          return;
        }

        if ('status' in payload && payload.status) {
          applyStatus(payload.status);
          return;
        }

        applyStatus(payload as MonitorRuntimeStatus);
      };

      stream.onerror = () => {
        if (eventSource === stream) {
          closeEventSource();
        }

        void loadStatus();

        if (!isMounted || reconnectTimerId != null) {
          return;
        }

        reconnectTimerId = window.setTimeout(() => {
          reconnectTimerId = null;
          connectStream();
        }, reconnectDelayMs);
      };
    };

    void loadStatus();
    connectStream();

    return () => {
      isMounted = false;
      closeEventSource();
      clearReconnectTimer();

      if (fallbackIntervalId != null) {
        window.clearInterval(fallbackIntervalId);
      }
    };
  }, []);

  const loadDbSize = async () => {
    setDbLoading(true);
    try {
      const response = await fetch('/api/database/size', { cache: 'no-store' });
      if (response.ok) {
        setDbSize(await response.json() as DatabaseSizeInfo);
      }
    } catch {
      // Silently ignore — the card will show a loading state.
    } finally {
      setDbLoading(false);
    }
  };

  const loadDbSettings = async () => {
    setDbSettingsLoading(true);
    try {
      const response = await fetch('/api/database/settings', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load database settings.');
      }

      const data = await response.json() as DatabaseSettingsState;
      setDbSettings(data);
      setDbSettingsForm(createDatabaseSettingsFormState(data));
      setDbSettingsFeedback(null);
    } catch (error) {
      setDbSettingsFeedback({
        message: error instanceof Error ? error.message : 'Unable to load database settings.',
        isError: true,
      });
    } finally {
      setDbSettingsLoading(false);
    }
  };

  useEffect(() => {
    void loadDbSize();
    void loadDbSettings();
  }, []);

  const checkForUpdate = useCallback(async (force = false) => {
    const fluxMonitorWindow = getFluxMonitorWindow();
    if (fluxMonitorWindow?.__fluxMonitorSoftwareUpdateCheckInFlight) {
      return;
    }

    const now = Date.now();
    const lastCheckStartedAt = fluxMonitorWindow?.__fluxMonitorSoftwareUpdateCheckStartedAt ?? null;
    if (!force && lastCheckStartedAt != null && now - lastCheckStartedAt < updateCheckCooldownMs) {
      if (fluxMonitorWindow?.__fluxMonitorSoftwareUpdateCheckResult) {
        setUpdateCheck((current) => current ?? fluxMonitorWindow.__fluxMonitorSoftwareUpdateCheckResult ?? null);
      }

      return;
    }

    if (fluxMonitorWindow) {
      fluxMonitorWindow.__fluxMonitorSoftwareUpdateCheckInFlight = true;
      fluxMonitorWindow.__fluxMonitorSoftwareUpdateCheckStartedAt = now;
    }

    setUpdateChecking(true);

    try {
      const response = await fetch('/api/system/update/check', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to check for updates.');
      }

      const result = await response.json() as UpdateCheckResult;
      if (fluxMonitorWindow) {
        fluxMonitorWindow.__fluxMonitorSoftwareUpdateCheckResult = result;
      }

      setUpdateCheck(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to check for updates.';
      setUpdateCheck((current) => {
        const nextResult = current
          ? { ...current, checkError: message }
          : {
            canUpdate: false,
            updateAvailable: false,
            checkError: message,
          };

        if (fluxMonitorWindow) {
          fluxMonitorWindow.__fluxMonitorSoftwareUpdateCheckResult = nextResult;
        }

        return nextResult;
      });
    } finally {
      if (fluxMonitorWindow) {
        fluxMonitorWindow.__fluxMonitorSoftwareUpdateCheckInFlight = false;
      }

      setUpdateChecking(false);
    }
  }, []);

  const saveUpdateChannel = useCallback(async (nextChannel: string | null) => {
    if (nextChannel == null) {
      return;
    }

    const normalizedChannel = nextChannel === 'main' ? 'main' : 'dev';
    const previousChannel = updateCheck?.preferredChannel ?? updateCheck?.targetChannel ?? updateCheck?.currentChannel ?? getReleaseChannel(status?.build?.releaseTag);
    if (normalizedChannel === previousChannel) {
      return;
    }

    setUpdateChannelError(null);
    setUpdateChannelSaving(true);
    setUpdateCheck((current) => current ? { ...current, preferredChannel: normalizedChannel, targetChannel: normalizedChannel } : current);

    try {
      const response = await fetch('/api/system/update/channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: normalizedChannel }),
      });
      const body = await response.json().catch(() => null) as { preferredChannel?: string; error?: string } | null;

      if (!response.ok) {
        throw new Error(body?.error ?? 'Unable to save the update channel.');
      }

      const persistedChannel = body?.preferredChannel === 'main' ? 'main' : 'dev';
      setUpdateCheck((current) => current ? { ...current, preferredChannel: persistedChannel, targetChannel: persistedChannel } : current);
      await checkForUpdate(true);
    } catch (error) {
      setUpdateCheck((current) => current ? { ...current, preferredChannel: previousChannel, targetChannel: previousChannel } : current);
      setUpdateChannelError(error instanceof Error ? error.message : 'Unable to save the update channel.');
    } finally {
      setUpdateChannelSaving(false);
    }
  }, [checkForUpdate, status?.build?.releaseTag, updateCheck]);

  useEffect(() => {
    if (!wifiConnectDialog?.requiresPassword) {
      return;
    }

    const trimmedSsid = wifiTargetSsid.trim();
    if (!trimmedSsid) {
      if (!wifiPasswordDirty) {
        setWifiPassword('');
      }

      return;
    }

    let isCancelled = false;
    const requestId = ++wifiCredentialRequestRef.current;

    const loadWifiCredential = async () => {
      try {
        const response = await fetch(`/api/system/network/wifi/credential?ssid=${encodeURIComponent(trimmedSsid)}`, {
          cache: 'no-store',
        });

        if (!response.ok) {
          return;
        }

        const data = await response.json() as WifiStoredCredentialResult;
        if (isCancelled || requestId !== wifiCredentialRequestRef.current) {
          return;
        }

        if (!wifiPasswordDirty) {
          setWifiPassword(data.password ?? '');
        }
      } catch {
        // Best effort. Leave the current password field unchanged on lookup failures.
      }
    };

    void loadWifiCredential();

    return () => {
      isCancelled = true;
    };
  }, [wifiConnectDialog, wifiPasswordDirty, wifiTargetSsid]);

  useEffect(() => {
    if (activeSystemSection !== 'software-update') {
      return;
    }

    void checkForUpdate();
  }, [activeSystemSection, checkForUpdate]);

  const loadConnectivity = useCallback(async () => {
    try {
      const response = await fetch('/api/system/connectivity', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load connectivity status.');
      }

      const data = await response.json() as SystemConnectivitySnapshot;
      setConnectivity(data);
      setConnectivityError(null);
    } catch (error) {
      setConnectivityError(error instanceof Error ? error.message : 'Unable to load connectivity status.');
    } finally {
      setConnectivityLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnectivity();
  }, [loadConnectivity]);

  useEffect(() => {
    void loadInternetSpeedTest();
  }, [loadInternetSpeedTest]);

  useEffect(() => {
    if (!internetSpeedTest?.isRunning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadInternetSpeedTest();
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [internetSpeedTest?.isRunning, loadInternetSpeedTest]);

  useEffect(() => {
    void loadCloudflareTunnelStatus();
  }, [loadCloudflareTunnelStatus]);

  useEffect(() => {
    const firstWifiInterface = connectivity?.network.wifiInterfaces[0];
    if (!firstWifiInterface) {
      setWifiTargetInterface('');
      setWifiTargetSsid('');
      setWifiTargetBssid(null);
      return;
    }

    setWifiTargetInterface((current) => {
      if (current && connectivity?.network.wifiInterfaces.some((wifiInterface) => wifiInterface.name === current)) {
        return current;
      }

      return firstWifiInterface.name;
    });
    setWifiTargetSsid((current) => current || firstWifiInterface.connectedSsid || '');
    setWifiTargetBssid((current) => current || firstWifiInterface.connectedBssid || null);
  }, [connectivity]);

  useEffect(() => {
    const settings = connectivity?.directAccess.settings;
    if (!settings || localAccessSettingsDirtyRef.current) {
      return;
    }

    setLocalAccessHotspotName(settings.hotspotName ?? '');
    setLocalAccessBluetoothName(settings.bluetoothDeviceName ?? '');
    setLocalAccessWifiPassword(settings.wifiPassword ?? '');
  }, [connectivity]);

  const installUpdate = async () => {
    setUpdateActionError(null);
    const result = await startSystemUpdate();
    if (!result.ok) {
      setUpdateActionError(result.error ?? 'Unable to start the update.');
    }
  };

  const startInternetSpeedTest = async () => {
    setInternetSpeedTestStarting(true);
    setInternetSpeedTestError(null);

    try {
      const response = await fetch('/api/system/internet-speed/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const data = await response.json() as InternetSpeedTestCommandResult;
      setInternetSpeedTest(data.snapshot);

      if (!response.ok || !data.success) {
        setInternetSpeedTestError(data.message || 'Unable to start the internet speed test.');
        return;
      }
    } catch (error) {
      setInternetSpeedTestError(error instanceof Error ? error.message : 'Unable to start the internet speed test.');
    } finally {
      setInternetSpeedTestStarting(false);
    }
  };

  useEffect(() => {
    if (updateProgress?.isRunning) {
      setUpdateActionError(null);
    }

    if (activeSystemSection === 'software-update' && previousUpdateStatusRef.current !== 'succeeded' && updateProgress?.status === 'succeeded') {
      void checkForUpdate();
    }

    previousUpdateStatusRef.current = updateProgress?.status ?? null;
  }, [activeSystemSection, checkForUpdate, updateProgress]);

  useEffect(() => {
    const loadInterfaces = async () => {
      try {
        const response = await fetch('/api/system/interfaces', { cache: 'no-store' });
        if (response.ok) {
          setInterfaces(await response.json() as SystemInterfacesResponse);
        }
      } catch {
        // Silently ignore.
      }
    };
    void loadInterfaces();
  }, []);

  const scanWifi = async (interfaceName: string) => {
    setWifiScanLoading(interfaceName);
    setWifiFeedback(null);
    setWifiTargetInterface(interfaceName);
    setWifiAccessPoints((current) => ({ ...current, [interfaceName]: [] }));

    try {
      const response = await fetch(`/api/system/network/wifi/scan?interfaceName=${encodeURIComponent(interfaceName)}`, { cache: 'no-store' });
      const data = await response.json() as WifiScanResult;

      if (!response.ok || !data.supported) {
        setWifiFeedback({ message: data.statusMessage ?? 'Unable to scan Wi-Fi networks.', isError: true });
        return;
      }

      setWifiAccessPoints((current) => ({ ...current, [interfaceName]: data.accessPoints }));

      const activeAccessPoint = data.accessPoints.find((accessPoint) => accessPoint.isActive);
      if (activeAccessPoint) {
        setWifiTargetSsid(activeAccessPoint.ssid);
        setWifiTargetBssid(activeAccessPoint.bssid ?? null);
      } else if (data.accessPoints.length > 0) {
        setWifiTargetSsid((current) => current || data.accessPoints[0].ssid);
        setWifiTargetBssid((current) => current ?? data.accessPoints[0].bssid ?? null);
      }

      if (data.statusMessage) {
        setWifiFeedback({ message: data.statusMessage, isError: false });
      }

      if (data.accessPoints.length === 0) {
        setWifiFeedback({ message: `No Wi-Fi networks were found on ${interfaceName}.`, isError: false });
      }
    } catch (error) {
      setWifiFeedback({
        message: error instanceof Error ? error.message : 'Unable to scan Wi-Fi networks.',
        isError: true,
      });
    } finally {
      setWifiScanLoading(null);
    }
  };

  const connectWifi = async (request?: { ssid?: string; interfaceName?: string; password?: string | null; bssid?: string | null }) => {
    const ssid = request?.ssid ?? wifiTargetSsid;
    const interfaceName = request?.interfaceName ?? wifiTargetInterface;
    const password = request?.password ?? wifiPassword;
    const bssid = request?.bssid ?? wifiTargetBssid;

    if (!ssid.trim()) {
      setWifiFeedback({ message: 'Enter or select an SSID before connecting.', isError: true });
      return;
    }

    if (!interfaceName.trim()) {
      setWifiFeedback({ message: 'No Wi-Fi interface is selected.', isError: true });
      return;
    }

    setWifiConnectLoading(true);
    setWifiFeedback(null);

    try {
      const response = await fetch('/api/system/network/wifi/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ssid: ssid.trim(),
          password: password || null,
          interfaceName,
          bssid,
        }),
      });

      const data = await response.json() as WifiConnectResult;
      setWifiFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        setWifiPassword('');
        setWifiShowPassword(false);
        setWifiPasswordDirty(false);
        setWifiConnectDialog(null);
        setExpandedConnectivitySection('wifi');
        if (data.interfaceName) {
          setWifiTargetInterface(data.interfaceName);
        }
        if (data.connectedSsid) {
          setWifiTargetSsid(data.connectedSsid);
        }
        await loadConnectivity();
      }
    } catch (error) {
      setWifiFeedback({
        message: getWifiConnectRequestErrorMessage(error),
        isError: true,
      });
    } finally {
      setWifiConnectLoading(false);
    }
  };

  const toggleWifiPower = async () => {
    const enabled = connectivity?.network.wifiPowered === false;
    setWifiPowerLoading(true);
    setWifiFeedback(null);

    try {
      const response = await fetch('/api/system/network/wifi/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json() as WifiPowerResult;
      setWifiFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        if (!data.powered) {
          setWifiAccessPoints({});
          setWifiPassword('');
          setWifiShowPassword(false);
          setWifiPasswordDirty(false);
          setExpandedConnectivitySection((current) => current === 'wifi' ? null : current);
        } else {
          setExpandedConnectivitySection('wifi');
        }

        await loadConnectivity();
      }
    } catch (error) {
      setWifiFeedback({
        message: error instanceof Error ? error.message : 'Unable to change Wi-Fi power state.',
        isError: true,
      });
    } finally {
      setWifiPowerLoading(false);
    }
  };

  const toggleLocalAccessMode = async (enabled: boolean) => {
    setLocalAccessModeLoading(true);
    setLocalAccessModeFeedback(null);

    try {
      const response = await fetch('/api/system/local-access-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json() as LocalAccessModeCommandResult;
      setLocalAccessModeFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        await loadConnectivity();
      }
    } catch (error) {
      setLocalAccessModeFeedback({
        message: error instanceof Error ? error.message : 'Unable to change fallback local access.',
        isError: true,
      });
    } finally {
      setLocalAccessModeLoading(false);
    }
  };

  const saveLocalAccessAdvancedSettings = async () => {
    setLocalAccessSettingsSaving(true);
    setLocalAccessSettingsFeedback(null);

    try {
      const response = await fetch('/api/system/local-access-mode/advanced', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hotspotName: localAccessHotspotName,
          bluetoothDeviceName: localAccessBluetoothName,
          wifiPassword: localAccessWifiPassword,
        }),
      });

      const data = await response.json() as SaveDirectAccessSettingsResult;
      setLocalAccessSettingsFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        localAccessSettingsDirtyRef.current = false;
        setLocalAccessHotspotName(data.settings.hotspotName ?? '');
        setLocalAccessBluetoothName(data.settings.bluetoothDeviceName ?? '');
        setLocalAccessWifiPassword(data.settings.wifiPassword ?? '');
        await loadConnectivity();
      }
    } catch (error) {
      setLocalAccessSettingsFeedback({
        message: error instanceof Error ? error.message : 'Unable to save fallback local access settings.',
        isError: true,
      });
    } finally {
      setLocalAccessSettingsSaving(false);
    }
  };

  const toggleEthernetPower = async (enabled: boolean) => {
    const interfaceName = activeEthernetInterface?.name;
    if (!interfaceName) {
      setEthernetFeedback({
        message: 'No Ethernet interface is available.',
        isError: true,
      });
      return;
    }

    setEthernetPowerLoading(true);
    setEthernetFeedback(null);

    try {
      const response = await fetch('/api/system/network/ethernet/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interfaceName, enabled }),
      });

      const data = await response.json() as EthernetPowerResult;
      setEthernetFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        setExpandedConnectivitySection('ethernet');
        await loadConnectivity();
      }
    } catch (error) {
      setEthernetFeedback({
        message: error instanceof Error ? error.message : 'Unable to change the Ethernet interface state.',
        isError: true,
      });
    } finally {
      setEthernetPowerLoading(false);
    }
  };

  const requestWifiPowerToggle = () => {
    const isDisabling = wifiPowered !== false;
    if (isDisabling && isWifiInterfaceInUse(connectedWifiInterface)) {
      setPendingConnectivityAction({
        kind: 'disable-wifi',
        interfaceName: connectedWifiInterface?.name ?? 'wifi',
        connectionName: connectedWifiInterface?.connectedSsid,
      });
      return;
    }

    void toggleWifiPower();
  };

  const openWifiConnectDialog = ({
    interfaceName,
    ssid,
    requiresPassword,
    allowSsidEdit,
    title,
    bssid,
  }: WifiConnectDialogState) => {
    setWifiFeedback(null);
    setWifiTargetInterface(interfaceName);
    setWifiTargetSsid(ssid);
    setWifiTargetBssid(bssid ?? null);
    setWifiPassword('');
    setWifiShowPassword(false);
    setWifiPasswordDirty(false);
    setWifiConnectDialog({ interfaceName, ssid, bssid, requiresPassword, allowSsidEdit, title });
  };

  const selectWifiAccessPoint = async (accessPoint: WifiAccessPointInfo) => {
    if (isWifiNetworkSecured(accessPoint)) {
      openWifiConnectDialog({
        interfaceName: accessPoint.interfaceName,
        ssid: accessPoint.ssid,
        bssid: accessPoint.bssid,
        requiresPassword: true,
        allowSsidEdit: false,
        title: accessPoint.ssid,
      });
      return;
    }

    setWifiTargetInterface(accessPoint.interfaceName);
    setWifiTargetSsid(accessPoint.ssid);
    setWifiTargetBssid(accessPoint.bssid ?? null);
    setWifiPassword('');
    setWifiShowPassword(false);
    setWifiPasswordDirty(false);
    await connectWifi({
      ssid: accessPoint.ssid,
      interfaceName: accessPoint.interfaceName,
      password: null,
      bssid: accessPoint.bssid,
    });
  };

  const openOtherWifiDialog = () => {
    if (!selectedWifiInterface) {
      setWifiFeedback({ message: 'No Wi-Fi interface is selected.', isError: true });
      return;
    }

    openWifiConnectDialog({
      interfaceName: selectedWifiInterface.name,
      ssid: '',
      bssid: null,
      requiresPassword: true,
      allowSsidEdit: true,
      title: 'Other network',
    });
  };

  const confirmPendingConnectivityAction = async () => {
    const action = pendingConnectivityAction;
    if (!action) {
      return;
    }

    setPendingConnectivityAction(null);

    if (action.kind === 'disable-wifi') {
      await toggleWifiPower();
    }
  };

  const selectWifiInterface = async (wifiInterface: WifiInterfaceSnapshot) => {
    setWifiTargetInterface(wifiInterface.name);
    setWifiTargetSsid(wifiInterface.connectedSsid || '');
    setWifiTargetBssid(wifiInterface.connectedBssid || null);
    await scanWifi(wifiInterface.name);
  };

  const toggleConnectivitySection = async (section: 'wifi' | 'bluetooth' | 'ethernet' | 'local-access' | 'internet-speed' | 'tunnel') => {
    const isOpen = expandedConnectivitySection === section;
    const nextSection = isOpen ? null : section;
    setExpandedConnectivitySection(nextSection);

    if (!nextSection) {
      return;
    }

    if (section === 'wifi' && connectivity?.network.supported && wifiPowered !== false && selectedWifiInterface) {
      setWifiTargetInterface(selectedWifiInterface.name);
      setWifiTargetSsid(selectedWifiInterface.connectedSsid || '');
      setWifiTargetBssid(selectedWifiInterface.connectedBssid || null);
      await scanWifi(selectedWifiInterface.name);
    }
  };

  const toggleBluetoothPower = async () => {
    const enabled = !(connectivity?.bluetooth.powered ?? false);
    setBluetoothPowerLoading(true);
    setBluetoothFeedback(null);

    try {
      const response = await fetch('/api/system/bluetooth/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json() as BluetoothPowerResult;
      setBluetoothFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        if (!data.powered) {
          setBluetoothScanResult(null);
          setExpandedConnectivitySection((current) => current === 'bluetooth' ? null : current);
        } else {
          setExpandedConnectivitySection('bluetooth');
        }

        await loadConnectivity();
      }
    } catch (error) {
      setBluetoothFeedback({
        message: error instanceof Error ? error.message : 'Unable to change Bluetooth power state.',
        isError: true,
      });
    } finally {
      setBluetoothPowerLoading(false);
    }
  };

  const toggleSshAccess = async (enabled: boolean) => {
    setSshToggleLoading(true);

    try {
      const response = await fetch('/api/system/ssh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json() as SshServiceCommandResult;

      if (response.ok && data.success) {
        await loadConnectivity();
      }
    } catch (error) {
      console.error('Unable to change SSH access.', error);
    } finally {
      setSshToggleLoading(false);
    }
  };

  const toggleWebTerminalAccess = async (enabled: boolean) => {
    setTerminalToggleLoading(true);

    try {
      const response = await fetch('/api/system/terminal-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

      const data = await response.json() as WebTerminalCommandResult;

      if (response.ok && data.success) {
        await loadConnectivity();
      }
    } catch (error) {
      console.error('Unable to change web terminal access.', error);
    } finally {
      setTerminalToggleLoading(false);
    }
  };

  const scanBluetooth = async () => {
    setBluetoothScanLoading(true);
    setBluetoothFeedback(null);

    try {
      const response = await fetch('/api/system/bluetooth/scan?timeoutMs=6000', { cache: 'no-store' });
      const data = await response.json() as BluetoothScanResult;
      setBluetoothScanResult(data);

      if (!response.ok || !data.supported || data.statusMessage) {
        setBluetoothFeedback({
          message: data.statusMessage ?? 'Unable to scan nearby Bluetooth devices.',
          isError: !response.ok || !data.supported,
        });
      }
    } catch (error) {
      setBluetoothFeedback({
        message: error instanceof Error ? error.message : 'Unable to scan nearby Bluetooth devices.',
        isError: true,
      });
    } finally {
      setBluetoothScanLoading(false);
    }
  };

  const saveDatabaseSettings = async () => {
    if (!dbSettingsForm) {
      return;
    }

    let payload: {
      rawSecondsWindowMinutes: number;
      persistedBucketMinutes: number;
      restartApplication: boolean;
    };

    try {
      payload = {
        rawSecondsWindowMinutes: parseSupportedMinutes(dbSettingsForm.rawSecondsWindowMinutes, 'Temporary history window', supportedTemporaryHistoryMinutes),
        persistedBucketMinutes: parseSupportedMinutes(dbSettingsForm.persistedBucketMinutes, 'Persisted bucket size', supportedPersistedBucketMinutes),
        restartApplication: false,
      };
    } catch (error) {
      setDbSettingsFeedback({
        message: error instanceof Error ? error.message : 'Enter valid database retention values.',
        isError: true,
      });
      return;
    }

    setDbSettingsSaving(true);
    setDbSettingsFeedback(null);

    try {
      const response = await fetch('/api/database/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => null) as SaveDatabaseSettingsResponse | { message?: string } | null;
      if (!response.ok || !body || !('settings' in body)) {
        throw new Error(body && 'message' in body && body.message ? body.message : 'Unable to save database settings.');
      }

      setDbSettings(body.settings);
      setDbSettingsForm(createDatabaseSettingsFormState(body.settings));
      setDbSettingsFeedback({ message: body.message, isError: false });
    } catch (error) {
      setDbSettingsFeedback({
        message: error instanceof Error ? error.message : 'Unable to save database settings.',
        isError: true,
      });
    } finally {
      setDbSettingsSaving(false);
    }
  };

  const handleExport = () => {
    window.location.href = '/api/database/export';
  };

  const saveCloudflareTunnel = async () => {
    setCloudflareTunnelSaving(true);
    setCloudflareTunnelFeedback(null);

    try {
      const response = await fetch('/api/system/cloudflare-tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: cloudflareTunnelEnabled,
          tunnelTokenOrCommand: cloudflareTunnelTokenOrCommand.trim() || null,
        }),
      });

      const data = await response.json() as SaveCloudflareTunnelResponse;
      setCloudflareTunnelStatus(data.status);
      setCloudflareTunnelFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        cloudflareTunnelDirtyRef.current = false;
        setCloudflareTunnelEnabled(stringEqualsIgnoreCase(data.status.tunnelProvider, 'cloudflared'));
        setCloudflareTunnelTokenOrCommand('');
      }
    } catch (error) {
      setCloudflareTunnelFeedback({
        message: error instanceof Error ? error.message : 'Unable to save Cloudflare Tunnel settings.',
        isError: true,
      });
    } finally {
      setCloudflareTunnelSaving(false);
    }
  };

  const handleImport = async (file: File) => {
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/database/import', { method: 'POST', body: formData });
      if (response.ok) {
        setImportResult('Import completed successfully.');
        void loadDbSize();
      } else {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setImportResult(body?.error ?? 'Import failed.');
      }
    } catch {
      setImportResult('Import failed — network error.');
    } finally {
      setImporting(false);
    }
  };

  const metrics = status?.systemMetrics ?? null;
  const dbSettingsDirty = !!(dbSettings && dbSettingsForm && (
    dbSettingsForm.rawSecondsWindowMinutes !== String(dbSettings.rawSecondsWindowMinutes) ||
    dbSettingsForm.persistedBucketMinutes !== String(dbSettings.persistedBucketMinutes)
  ));
  const applicationUptime = status ? formatDuration(status.startedAt, status.reportedAt) : noDataLabel;
  const workflowRun = formatWorkflowRun(
    updateCheck?.currentWorkflowRunNumber ?? status?.build?.workflowRunNumber,
    updateCheck?.currentWorkflowRunAttempt ?? status?.build?.workflowRunAttempt,
  );
  const installedChannel = updateCheck?.currentChannel ?? getReleaseChannel(status?.build?.releaseTag);
  const preferredUpdateChannel = updateCheck?.preferredChannel ?? updateCheck?.targetChannel ?? installedChannel;
  const installedCommit = updateCheck?.currentSourceRevision ?? status?.build?.sourceRevisionId ?? null;
  const installedReleasePublishedAt = updateCheck?.currentReleasePublishedAt ?? null;
  const installedReleasePublishedLabel = installedReleasePublishedAt ? formatTimestamp(installedReleasePublishedAt) : 'Not checked yet';
  const ethernetInterfaces = connectivity?.network.ethernetInterfaces ?? [];
  const wifiInterfaces = connectivity?.network.wifiInterfaces ?? [];
  const wifiPowered = connectivity?.network.wifiPowered ?? null;
  const selectedWifiInterface = wifiInterfaces.find((wifiInterface) => wifiInterface.name === wifiTargetInterface) ?? wifiInterfaces[0] ?? null;
  const selectedWifiAccessPoints = selectedWifiInterface ? wifiAccessPoints[selectedWifiInterface.name] ?? [] : [];
  const bluetoothDevices = connectivity?.bluetooth.devices ?? [];
  const scannedBluetoothDevices = bluetoothScanResult?.devices ?? [];
  const visibleBluetoothDevices = mergeBluetoothDevices(bluetoothDevices, scannedBluetoothDevices);
  const connectedWifiInterface = wifiInterfaces.find((wifiInterface) => wifiInterface.connectedSsid) ?? selectedWifiInterface;
  const hasInternetAccess = connectivity?.network.hasInternetAccess ?? null;
  const activeBluetoothDevice = visibleBluetoothDevices.find((device) => device.isConnected) ?? visibleBluetoothDevices[0] ?? null;
  const activeEthernetInterface = ethernetInterfaces.find((ethernetInterface) => isEthernetInterfaceEnabled(ethernetInterface)) ?? ethernetInterfaces[0] ?? null;
  const internetSpeedResult = internetSpeedTest?.result ?? null;
  const internetSpeedStage = internetSpeedTest?.stage ?? null;
  const internetSpeedStagePercent = clampPercent(internetSpeedTest?.stagePercentComplete);
  const internetSpeedActiveMetric = internetSpeedTest?.isRunning ? getInternetSpeedActiveMetric(internetSpeedStage) : null;
  const internetSpeedDownloadMbps = getMegabitsPerSecond(internetSpeedResult?.downloadBitsPerSecond);
  const internetSpeedUploadMbps = getMegabitsPerSecond(internetSpeedResult?.uploadBitsPerSecond);
  const internetSpeedPing = internetSpeedResult?.pingMilliseconds ?? null;
  const internetSpeedDownloadGauge = getBandwidthGaugePercent(internetSpeedDownloadMbps);
  const internetSpeedUploadGauge = getBandwidthGaugePercent(internetSpeedUploadMbps);
  const internetSpeedPingGauge = getLatencyGaugePercent(internetSpeedPing);
  const internetSpeedRunningMessage = internetSpeedTest?.isRunning
    ? internetSpeedTest.statusMessage ?? `Measuring ${getInternetSpeedStageLabel(internetSpeedStage).toLowerCase()}.`
    : null;
  const internetSpeedDownloadIsActive = internetSpeedActiveMetric === 'download';
  const internetSpeedUploadIsActive = internetSpeedActiveMetric === 'upload';
  const internetSpeedPingIsActive = internetSpeedActiveMetric === 'ping';
  const internetSpeedDownloadPending = Boolean(internetSpeedTest?.isRunning && !internetSpeedDownloadIsActive && internetSpeedResult?.downloadBitsPerSecond == null);
  const internetSpeedUploadPending = Boolean(internetSpeedTest?.isRunning && !internetSpeedUploadIsActive && internetSpeedResult?.uploadBitsPerSecond == null);
  const internetSpeedDownloadDialDisplay = internetSpeedDownloadIsActive
    ? formatProgressDialValue(internetSpeedStagePercent)
    : internetSpeedDownloadPending
      ? '--'
      : formatSpeedDialValue(internetSpeedResult?.downloadBitsPerSecond);
  const internetSpeedUploadDialDisplay = internetSpeedUploadIsActive
    ? formatProgressDialValue(internetSpeedStagePercent)
    : internetSpeedUploadPending
      ? '--'
      : formatSpeedDialValue(internetSpeedResult?.uploadBitsPerSecond);
  const internetSpeedPingDialDisplay = internetSpeedPingIsActive
    ? formatProgressDialValue(internetSpeedStagePercent)
    : formatLatencyDialValue(internetSpeedResult?.pingMilliseconds);
  const internetSpeedDownloadValue = internetSpeedDownloadIsActive
    ? 'Measuring download'
    : internetSpeedDownloadPending
      ? 'Waiting to start'
      : formatSpeedMbps(internetSpeedResult?.downloadBitsPerSecond);
  const internetSpeedUploadValue = internetSpeedUploadIsActive
    ? 'Measuring upload'
    : internetSpeedUploadPending
      ? 'Waiting to start'
      : formatSpeedMbps(internetSpeedResult?.uploadBitsPerSecond);
  const internetSpeedPingValue = internetSpeedPingIsActive
    ? 'Measuring ping'
    : formatLatency(internetSpeedResult?.pingMilliseconds);
  const internetSpeedDownloadCaption = internetSpeedDownloadIsActive
    ? getInternetSpeedActiveCaption('download', internetSpeedRunningMessage)
    : internetSpeedDownloadPending
      ? 'Queued for this run.'
      : formatTransferSize(internetSpeedResult?.bytesReceived, 'received');
  const internetSpeedUploadCaption = internetSpeedUploadIsActive
    ? getInternetSpeedActiveCaption('upload', internetSpeedRunningMessage)
    : internetSpeedUploadPending
      ? 'Queued for this run.'
      : formatTransferSize(internetSpeedResult?.bytesSent, 'sent');
  const internetSpeedPingCaption = internetSpeedPingIsActive
    ? getInternetSpeedActiveCaption('ping', internetSpeedRunningMessage)
    : undefined;
  const internetSpeedDownloadDialGauge = internetSpeedDownloadIsActive
    ? Math.max(internetSpeedStagePercent, 6)
    : internetSpeedDownloadGauge;
  const internetSpeedUploadDialGauge = internetSpeedUploadIsActive
    ? Math.max(internetSpeedStagePercent, 6)
    : internetSpeedUploadGauge;
  const internetSpeedPingDialGauge = internetSpeedPingIsActive
    ? Math.max(internetSpeedStagePercent, 6)
    : internetSpeedPingGauge;
  const internetSpeedPingTone = internetSpeedPingIsActive ? 'amber' : getLatencyTone(internetSpeedPing);
  const internetSpeedConnectionMode = formatInternetSpeedConnectionMode(internetSpeedResult?.connectionMode);
  const cloudflareTunnelSupported = cloudflareTunnelStatus?.supported ?? false;
  const cloudflareTunnelMaskedToken = cloudflareTunnelStatus?.maskedToken ?? null;
  const wifiSectionOpen = expandedConnectivitySection === 'wifi';
  const bluetoothSectionOpen = expandedConnectivitySection === 'bluetooth';
  const ethernetSectionOpen = expandedConnectivitySection === 'ethernet';
  const localAccessSectionOpen = expandedConnectivitySection === 'local-access';
  const internetSpeedSectionOpen = expandedConnectivitySection === 'internet-speed';
  const tunnelSectionOpen = expandedConnectivitySection === 'tunnel';
  const sshAccess = connectivity?.ssh ?? null;
  const sshToggleChecked = Boolean(sshAccess?.enabled || sshAccess?.active);
  const terminalAccess = connectivity?.terminal ?? null;
  const wifiSummary = connectedWifiInterface?.connectedSsid
    ? connectedWifiInterface.connectedSsid
    : wifiInterfaces.length > 0
      ? 'Manage nearby networks'
      : 'Wireless networking';
  const bluetoothSummary = activeBluetoothDevice?.displayName ?? 'Nearby devices';
  const localAccessSettings = connectivity?.directAccess.settings ?? null;
  const localAccessMode = connectivity?.directAccess.mode ?? null;
  const savedLocalAccessHotspotName = localAccessSettings?.hotspotName ?? '';
  const savedLocalAccessBluetoothName = localAccessSettings?.bluetoothDeviceName ?? '';
  const savedLocalAccessWifiPassword = localAccessSettings?.wifiPassword ?? '';
  const localAccessSettingsDirty = localAccessHotspotName !== savedLocalAccessHotspotName
    || localAccessBluetoothName !== savedLocalAccessBluetoothName
    || localAccessWifiPassword !== savedLocalAccessWifiPassword;
  const localAccessUsesWpa3Only = requiresSaeForLocalAccessPassword(localAccessWifiPassword);
  const localAccessAddresses = localAccessMode?.addresses ?? [];
  const localAccessPrimaryAddress = localAccessAddresses[0] ?? null;
  const localAccessBluetoothDeviceName = formatLocalAccessBluetoothDeviceName(connectivity?.directAccess.bluetooth.deviceName ?? localAccessSettings?.bluetoothDeviceName);
  const localAccessHotspotSsid = formatLocalAccessName(localAccessMode?.hotspotName ?? localAccessSettings?.hotspotName);
  const localAccessStatus = buildFallbackLocalAccessStatus(localAccessMode, localAccessPrimaryAddress);
  const connectivityPanelLinks = buildConnectivityPanelLinks(localAccessMode?.hostName, wifiInterfaces, ethernetInterfaces);
  const localAccessSummary = 'Starts a local hotspot if the router is unavailable.';
  const ethernetSummary = 'Wired network connection';
  const pendingConnectivityDialogTitle = pendingConnectivityAction?.kind === 'disable-wifi'
    ? 'Turn off Wi-Fi?'
    : null;
  const pendingConnectivityDialogDescription = pendingConnectivityAction?.kind === 'disable-wifi'
    ? `You are currently using ${pendingConnectivityAction.connectionName ?? pendingConnectivityAction.interfaceName}. Turning Wi-Fi off will disconnect this device from that network.`
    : null;
  const pendingConnectivityConfirmLabel = pendingConnectivityAction?.kind === 'disable-wifi'
    ? 'Turn off Wi-Fi'
    : null;
  const isLogsSystemSection = activeSystemSection === 'logs';

  if (sectionId === 'internet-speed' || sectionId === 'tunnel') {
    return <Navigate to={getSystemSectionPath('connectivity')} replace />;
  }

  if (sectionId && routedSystemSection === null) {
    return <Navigate to='/system' replace />;
  }

  return (
    <div
      ref={systemPageRef}
      className={cn(
        'min-w-0',
        isLogsSystemSection
          ? 'flex min-h-full flex-1 flex-col gap-6 overflow-hidden'
          : 'space-y-6 pb-8'
      )}
    >
      {isLogsSystemSection ? <LogsSection /> : (
        <>
          {loadError ? (
            <div className='flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-4 text-sm text-destructive'>
              <CircleAlert className='mt-0.5 h-5 w-5 shrink-0' />
              <div>
                <div className='font-semibold'>Status feed unavailable</div>
                <div className='mt-1 text-destructive/90'>{loadError}</div>
              </div>
            </div>
          ) : null}

          {isLoading && !status ? (
            <div className='flex min-h-64 items-center justify-center rounded-2xl border border-border bg-card/60'>
              <LoaderCircle className='h-6 w-6 animate-spin text-primary' />
            </div>
          ) : null}

          {status ? (
            <div className='min-w-0 space-y-6'>
              {activeSystemSection === 'resource-usage' ? (
                <ResourceUsageSection
                  metrics={metrics}
                  applicationUptime={applicationUptime}
                />
              ) : null}

              {activeSystemSection === 'software-update' ? (
                <SoftwareUpdateSection
                  preferredUpdateChannel={preferredUpdateChannel}
                  updateChannelSaving={updateChannelSaving}
                  updateChecking={updateChecking}
                  updateProgress={updateProgress}
                  updateCheck={updateCheck}
                  installedCommit={formatCommit(installedCommit)}
                  workflowRun={workflowRun}
                  installedReleasePublishedLabel={installedReleasePublishedLabel}
                  updateActionError={updateActionError}
                  updateChannelError={updateChannelError}
                  updateActionPending={updateActionPending}
                  onSaveUpdateChannel={saveUpdateChannel}
                  onInstallUpdate={installUpdate}
                />
              ) : null}
            <Card className={cn('border border-border/80 bg-card/85 shadow-sm', activeSystemSection !== 'connectivity' && 'hidden')}>
              <CardContent className='space-y-4 pt-4'>
                {connectivityLoading && !connectivity ? (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                ) : (
                  <>
                    {connectivityError ? (
                      <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                        {connectivityError}
                      </div>
                    ) : null}

                    <div className='space-y-3'>
                      {connectivityPanelLinks.length > 0 ? (
                        <div className='flex flex-wrap gap-x-4 gap-y-2 px-1'>
                          {connectivityPanelLinks.map((link) => (
                            <a
                              key={link}
                              href={link}
                              target='_blank'
                              rel='noreferrer'
                              className='break-all text-sm text-primary underline-offset-4 hover:underline'
                            >
                              {link}
                            </a>
                          ))}
                        </div>
                      ) : null}

                      <WifiMenuItem
                        connectivity={connectivity}
                        wifiPowered={wifiPowered}
                        wifiSummary={wifiSummary}
                        wifiSectionOpen={wifiSectionOpen}
                        wifiPowerLoading={wifiPowerLoading}
                        wifiFeedback={wifiFeedback}
                        wifiInterfaces={wifiInterfaces}
                        selectedWifiInterface={selectedWifiInterface}
                        selectedWifiAccessPoints={selectedWifiAccessPoints}
                        hasInternetAccess={hasInternetAccess}
                        wifiScanLoading={wifiScanLoading}
                        onToggleExpanded={() => { void toggleConnectivitySection('wifi'); }}
                        onTogglePower={requestWifiPowerToggle}
                        onSelectInterface={selectWifiInterface}
                        onSelectAccessPoint={selectWifiAccessPoint}
                        onOpenOtherDialog={openOtherWifiDialog}
                        onScan={scanWifi}
                      />

                      <BluetoothMenuItem
                        connectivity={connectivity}
                        bluetoothSummary={bluetoothSummary}
                        bluetoothSectionOpen={bluetoothSectionOpen}
                        bluetoothPowerLoading={bluetoothPowerLoading}
                        bluetoothScanLoading={bluetoothScanLoading}
                        bluetoothFeedback={bluetoothFeedback}
                        visibleBluetoothDevices={visibleBluetoothDevices}
                        onToggleExpanded={() => { void toggleConnectivitySection('bluetooth'); }}
                        onTogglePower={toggleBluetoothPower}
                        onScan={scanBluetooth}
                      />

                      <SshMenuItem
                        sshAccess={sshAccess}
                        sshToggleChecked={sshToggleChecked}
                        sshToggleLoading={sshToggleLoading}
                        onToggle={() => toggleSshAccess(!sshToggleChecked)}
                      />

                      <WebTerminalMenuItem
                        terminalAccess={terminalAccess}
                        terminalToggleLoading={terminalToggleLoading}
                        onToggle={() => toggleWebTerminalAccess(!(terminalAccess?.enabled ?? false))}
                      />

                      <EthernetMenuItem
                        ethernetSummary={ethernetSummary}
                        ethernetSectionOpen={ethernetSectionOpen}
                        ethernetPowerLoading={ethernetPowerLoading}
                        ethernetFeedback={ethernetFeedback}
                        ethernetInterfaces={ethernetInterfaces}
                        activeEthernetInterface={activeEthernetInterface}
                        onToggleExpanded={() => { void toggleConnectivitySection('ethernet'); }}
                        onTogglePower={() => toggleEthernetPower(!isEthernetInterfaceEnabled(activeEthernetInterface))}
                      />

                      <LocalAccessMenuItem
                        localAccessSummary={localAccessSummary}
                        localAccessSectionOpen={localAccessSectionOpen}
                        localAccessModeLoading={localAccessModeLoading}
                        localAccessModeFeedback={localAccessModeFeedback}
                        localAccessMode={localAccessMode}
                        localAccessSettings={localAccessSettings}
                        localAccessBluetoothDeviceName={localAccessBluetoothDeviceName}
                        localAccessHotspotSsid={localAccessHotspotSsid}
                        localAccessStatus={localAccessStatus}
                        localAccessAddresses={localAccessAddresses}
                        localAccessAdvancedOpen={localAccessAdvancedOpen}
                        localAccessSettingsFeedback={localAccessSettingsFeedback}
                        localAccessBluetoothName={localAccessBluetoothName}
                        localAccessHotspotName={localAccessHotspotName}
                        localAccessWifiPassword={localAccessWifiPassword}
                        localAccessShowPassword={localAccessShowPassword}
                        localAccessSettingsSaving={localAccessSettingsSaving}
                        localAccessSettingsDirty={localAccessSettingsDirty}
                        localAccessUsesWpa3Only={localAccessUsesWpa3Only}
                        onToggleExpanded={() => { void toggleConnectivitySection('local-access'); }}
                        onToggleMode={() => toggleLocalAccessMode(!(localAccessMode?.enabled ?? false))}
                        onToggleAdvanced={() => setLocalAccessAdvancedOpen((current) => !current)}
                        onBluetoothNameChange={(value) => {
                          localAccessSettingsDirtyRef.current = true;
                          setLocalAccessSettingsFeedback(null);
                          setLocalAccessBluetoothName(value);
                        }}
                        onHotspotNameChange={(value) => {
                          localAccessSettingsDirtyRef.current = true;
                          setLocalAccessSettingsFeedback(null);
                          setLocalAccessHotspotName(value);
                        }}
                        onWifiPasswordChange={(value) => {
                          localAccessSettingsDirtyRef.current = true;
                          setLocalAccessSettingsFeedback(null);
                          setLocalAccessWifiPassword(value);
                        }}
                        onShowPasswordChange={setLocalAccessShowPassword}
                        onSaveSettings={saveLocalAccessAdvancedSettings}
                      />

                      <InternetSpeedMenuItem
                        internetSpeedSectionOpen={internetSpeedSectionOpen}
                        hasMeasuredInternetSpeed={internetSpeedDownloadMbps != null || internetSpeedUploadMbps != null}
                        downloadSummary={formatSpeedMbps(internetSpeedResult?.downloadBitsPerSecond)}
                        uploadSummary={formatSpeedMbps(internetSpeedResult?.uploadBitsPerSecond)}
                        internetSpeedTestLoading={internetSpeedTestLoading}
                        internetSpeedTest={internetSpeedTest}
                        internetSpeedTestError={internetSpeedTestError}
                        internetSpeedPingValue={internetSpeedPingValue}
                        internetSpeedPingDialDisplay={internetSpeedPingDialDisplay}
                        internetSpeedPingCaption={internetSpeedPingCaption}
                        internetSpeedPingDialGauge={internetSpeedPingDialGauge}
                        internetSpeedPingTone={internetSpeedPingTone}
                        internetSpeedPingIsActive={internetSpeedPingIsActive}
                        internetSpeedDownloadValue={internetSpeedDownloadValue}
                        internetSpeedDownloadDialDisplay={internetSpeedDownloadDialDisplay}
                        internetSpeedDownloadCaption={internetSpeedDownloadCaption}
                        internetSpeedDownloadDialGauge={internetSpeedDownloadDialGauge}
                        internetSpeedDownloadIsActive={internetSpeedDownloadIsActive}
                        internetSpeedUploadValue={internetSpeedUploadValue}
                        internetSpeedUploadDialDisplay={internetSpeedUploadDialDisplay}
                        internetSpeedUploadCaption={internetSpeedUploadCaption}
                        internetSpeedUploadDialGauge={internetSpeedUploadDialGauge}
                        internetSpeedUploadIsActive={internetSpeedUploadIsActive}
                        internetSpeedServer={formatInternetSpeedServer(
                          internetSpeedResult?.server?.sponsor,
                          internetSpeedResult?.server?.name,
                          internetSpeedResult?.server?.country
                        )}
                        internetSpeedDistance={formatDistance(internetSpeedResult?.server?.distanceKilometers)}
                        internetSpeedProvider={internetSpeedResult?.client?.internetServiceProvider ?? noDataLabel}
                        internetSpeedIpAddress={internetSpeedResult?.client?.ipAddress ?? noDataLabel}
                        internetSpeedConnectionMode={internetSpeedConnectionMode}
                        internetSpeedMeasuredAt={formatTimestamp(internetSpeedResult?.testedAt ?? internetSpeedTest?.completedAt)}
                        internetSpeedTestStarting={internetSpeedTestStarting}
                        onToggleExpanded={() => { void toggleConnectivitySection('internet-speed'); }}
                        onStartTest={startInternetSpeedTest}
                      />

                      <TunnelMenuItem
                        tunnelSectionOpen={tunnelSectionOpen}
                        cloudflareTunnelLoading={cloudflareTunnelLoading}
                        cloudflareTunnelStatus={cloudflareTunnelStatus}
                        cloudflareTunnelError={cloudflareTunnelError}
                        cloudflareTunnelFeedback={cloudflareTunnelFeedback}
                        cloudflareTunnelEnabled={cloudflareTunnelEnabled}
                        cloudflareTunnelSaving={cloudflareTunnelSaving}
                        cloudflareTunnelSupported={cloudflareTunnelSupported}
                        cloudflareTunnelMaskedToken={cloudflareTunnelMaskedToken}
                        cloudflareTunnelTokenOrCommand={cloudflareTunnelTokenOrCommand}
                        onToggleExpanded={() => { void toggleConnectivitySection('tunnel'); }}
                        onEnabledChange={(checked) => {
                          cloudflareTunnelDirtyRef.current = true;
                          setCloudflareTunnelEnabled(checked);
                          setCloudflareTunnelFeedback(null);
                        }}
                        onTokenChange={(value) => {
                          cloudflareTunnelDirtyRef.current = true;
                          setCloudflareTunnelTokenOrCommand(value);
                        }}
                        onSave={saveCloudflareTunnel}
                      />
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

              {activeSystemSection === 'hardware-interfaces' ? (
                <HardwareInterfacesSection interfaces={interfaces} />
              ) : null}

              {activeSystemSection === 'tools' ? (
                <ModbusScannerSection interfaces={interfaces} />
              ) : null}

              {activeSystemSection === 'database' ? (
                <DatabaseSection
                  dbLoading={dbLoading}
                  dbSize={dbSize}
                  dbSettingsLoading={dbSettingsLoading}
                  dbSettings={dbSettings}
                  dbSettingsForm={dbSettingsForm}
                  dbSettingsSaving={dbSettingsSaving}
                  dbSettingsDirty={dbSettingsDirty}
                  dbSettingsFeedback={dbSettingsFeedback}
                  importing={importing}
                  importResult={importResult}
                  fileInputRef={fileInputRef}
                  onRawWindowChange={(value) => {
                    setDbSettingsForm((current) => current ? { ...current, rawSecondsWindowMinutes: value } : current);
                    setDbSettingsFeedback(null);
                  }}
                  onPersistedBucketChange={(value) => {
                    setDbSettingsForm((current) => current ? { ...current, persistedBucketMinutes: value } : current);
                    setDbSettingsFeedback(null);
                  }}
                  onSaveSettings={saveDatabaseSettings}
                  onExport={handleExport}
                  onImportFile={handleImport}
                />
              ) : null}

              {activeSystemSection === 'terminal' ? (
                <TerminalSection
                  terminalAccess={terminalAccess}
                  connectivityLoading={connectivityLoading}
                />
              ) : null}

            </div>
          ) : null}
        </>
      )}

      {wifiConnectDialog ? (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm'>
          <div className='w-full max-w-md rounded-3xl border border-border/80 bg-card p-5 shadow-2xl'>
            <div className='text-base font-semibold text-foreground'>{wifiConnectDialog.title}</div>
            <div className='mt-1 text-sm text-muted-foreground'>
              Connect via <span className='font-mono text-foreground'>{wifiConnectDialog.interfaceName}</span>
            </div>

            <div className='mt-5 space-y-3'>
              {wifiFeedback ? (
                <div className={cn(
                  'rounded-2xl border px-3 py-2 text-xs',
                  wifiFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                )}>
                  {wifiFeedback.message}
                </div>
              ) : null}
              <Input
                value={wifiTargetSsid}
                onChange={(event) => {
                  setWifiTargetSsid(event.target.value);
                  if (wifiConnectDialog.allowSsidEdit) {
                    setWifiTargetBssid(null);
                  }
                }}
                placeholder='SSID'
                disabled={!wifiConnectDialog.allowSsidEdit}
              />
              <Input
                type={wifiShowPassword ? 'text' : 'password'}
                value={wifiPassword}
                onChange={(event) => {
                  setWifiPassword(event.target.value);
                  setWifiPasswordDirty(true);
                }}
                placeholder={wifiConnectDialog.requiresPassword ? 'Password' : 'Password (optional)'}
              />
              <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                <input
                  type='checkbox'
                  checked={wifiShowPassword}
                  onChange={(event) => setWifiShowPassword(event.target.checked)}
                  className='h-4 w-4 rounded border border-input bg-background/70'
                />
                <span>Show password</span>
              </label>
            </div>

            <div className='mt-5 flex justify-end gap-2'>
              <button
                type='button'
                onClick={() => {
                  setWifiConnectDialog(null);
                  setWifiPassword('');
                  setWifiShowPassword(false);
                  setWifiPasswordDirty(false);
                  setWifiFeedback(null);
                }}
                className='inline-flex items-center justify-center rounded-xl border border-border bg-background/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
              >
                Cancel
              </button>
              <button
                type='button'
                disabled={wifiConnectLoading || !wifiTargetSsid.trim()}
                onClick={() => void connectWifi()}
                className='inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
              >
                {wifiConnectLoading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Wifi className='h-4 w-4' />}
                Connect
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingConnectivityAction && pendingConnectivityDialogTitle && pendingConnectivityDialogDescription && pendingConnectivityConfirmLabel ? (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm'>
          <div className='w-full max-w-md rounded-3xl border border-border/80 bg-card p-5 shadow-2xl'>
            <div className='flex items-start gap-3'>
              <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-300'>
                <CircleAlert className='h-5 w-5' />
              </div>
              <div className='min-w-0'>
                <div className='text-base font-semibold text-foreground'>{pendingConnectivityDialogTitle}</div>
                <div className='mt-1 text-sm text-muted-foreground'>{pendingConnectivityDialogDescription}</div>
              </div>
            </div>

            <div className='mt-5 flex justify-end gap-2'>
              <button
                type='button'
                onClick={() => setPendingConnectivityAction(null)}
                className='inline-flex items-center justify-center rounded-xl border border-border bg-background/70 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
              >
                Cancel
              </button>
              <button
                type='button'
                onClick={() => void confirmPendingConnectivityAction()}
                className='inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'
              >
                {pendingConnectivityConfirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function mergeBluetoothDevices(primary: BluetoothDeviceSnapshot[], secondary: BluetoothDeviceSnapshot[]) {
  const devices = new Map<string, BluetoothDeviceSnapshot>();

  for (const device of [...primary, ...secondary]) {
    const existing = devices.get(device.address);
    if (!existing) {
      devices.set(device.address, device);
      continue;
    }

    devices.set(device.address, {
      ...existing,
      ...device,
      displayName: device.displayName || existing.displayName,
      address: device.address || existing.address,
      rssi: device.rssi ?? existing.rssi,
      advertisedServiceUuids: device.advertisedServiceUuids.length > 0 ? device.advertisedServiceUuids : existing.advertisedServiceUuids,
      isConnected: device.isConnected || existing.isConnected,
      isPaired: device.isPaired || existing.isPaired,
    });
  }

  return Array.from(devices.values())
    .sort((left, right) => {
      const leftScore = (left.isConnected ? 4 : 0) + (left.isPaired ? 2 : 0) + (left.rssi ?? -200);
      const rightScore = (right.isConnected ? 4 : 0) + (right.isPaired ? 2 : 0) + (right.rssi ?? -200);

      if (leftScore !== rightScore) {
        return rightScore - leftScore;
      }

      return left.displayName.localeCompare(right.displayName);
    });
}

function isWifiNetworkSecured(accessPoint: WifiAccessPointInfo) {
  return Boolean(accessPoint.security && accessPoint.security.trim() && accessPoint.security.trim() !== '--');
}

function getWifiConnectRequestErrorMessage(error: unknown) {
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
    return 'The Wi-Fi change interrupted the request. If the device switched networks, reconnect to its new address and check Wi-Fi status again.';
  }

  return error instanceof Error ? error.message : 'Unable to connect to the selected Wi-Fi network.';
}

function formatLocalAccessHostName(hostName: string | null | undefined) {
  const trimmed = hostName?.trim();
  if (!trimmed) {
    return 'Waiting';
  }

  return trimmed.includes('.') ? trimmed : `${trimmed}.local`;
}

function formatLocalAccessBluetoothDeviceName(deviceName: string | null | undefined) {
  const trimmed = deviceName?.trim();
  if (!trimmed) {
    return 'Waiting';
  }

  return trimmed;
}

function formatLocalAccessName(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return 'Waiting';
  }

  return trimmed;
}

function buildFallbackLocalAccessStatus(
  localAccessMode: LocalAccessModeSnapshot | null | undefined,
  primaryAddress: string | null,
) {
  if (!localAccessMode?.enabled) {
    return 'Disabled';
  }

  if (localAccessMode.active) {
    return primaryAddress ?? 'Active';
  }

  return 'Starts when needed';
}

function buildConnectivityPanelLinks(
  hostName: string | null | undefined,
  wifiInterfaces: WifiInterfaceSnapshot[],
  ethernetInterfaces: EthernetInterfaceSnapshot[],
) {
  const links = new Set<string>();
  const formattedHostName = formatLocalAccessHostName(hostName);

  if (formattedHostName !== 'Waiting') {
    links.add(`http://${formattedHostName}:${monitorHttpPort}`);
  }

  for (const address of [...wifiInterfaces.flatMap((wifiInterface) => wifiInterface.addresses), ...ethernetInterfaces.flatMap((ethernetInterface) => ethernetInterface.addresses)]) {
    const normalizedAddress = normalizeConnectivityLinkAddress(address);
    if (!normalizedAddress) {
      continue;
    }

    links.add(`http://${normalizedAddress}:${monitorHttpPort}`);
  }

  return Array.from(links);
}

function normalizeConnectivityLinkAddress(address: string | null | undefined) {
  const trimmed = address?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed === '::1' || trimmed.startsWith('127.')) {
    return null;
  }

  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) ? trimmed : null;
}

function requiresSaeForLocalAccessPassword(password: string) {
  if (password.length === 0) {
    return false;
  }

  if (password.length >= 8 && password.length <= 63) {
    return false;
  }

  if (password.length === 64 && /^[\da-f]+$/i.test(password)) {
    return false;
  }

  return true;
}

function isWifiInterfaceInUse(wifiInterface: WifiInterfaceSnapshot | null | undefined) {
  return Boolean(wifiInterface?.connectedSsid) || (wifiInterface?.addresses.length ?? 0) > 0;
}

function isEthernetInterfaceEnabled(ethernetInterface: EthernetInterfaceSnapshot | null | undefined) {
  if (!ethernetInterface) {
    return false;
  }

  if (ethernetInterface.enabled != null) {
    return ethernetInterface.enabled;
  }

  return isEthernetInterfaceActive(ethernetInterface);
}

function isEthernetInterfaceActive(ethernetInterface: EthernetInterfaceSnapshot | null | undefined) {
  if (!ethernetInterface) {
    return false;
  }

  return (ethernetInterface.connectionState ?? ethernetInterface.status ?? '').toLowerCase().includes('connected')
    || stringEqualsIgnoreCase(ethernetInterface.status, 'up')
    || ethernetInterface.addresses.length > 0;
}

function stringEqualsIgnoreCase(left: string | null | undefined, right: string) {
  return typeof left === 'string' && left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function formatBytes(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let currentValue = value;

  while (currentValue >= 1024 && unitIndex < units.length - 1) {
    currentValue /= 1024;
    unitIndex += 1;
  }

  const digits = currentValue >= 100 || unitIndex === 0 ? 0 : 1;
  return `${currentValue.toFixed(digits)} ${units[unitIndex]}`;
}

function formatSpeedMbps(bitsPerSecond: number | null | undefined) {
  const megabitsPerSecond = getMegabitsPerSecond(bitsPerSecond);
  if (megabitsPerSecond == null) {
    return noDataLabel;
  }

  if (megabitsPerSecond >= 100) {
    return `${megabitsPerSecond.toFixed(0)} Mbps`;
  }

  if (megabitsPerSecond >= 10) {
    return `${megabitsPerSecond.toFixed(1)} Mbps`;
  }

  return `${megabitsPerSecond.toFixed(2)} Mbps`;
}

function formatSpeedDialValue(bitsPerSecond: number | null | undefined) {
  const megabitsPerSecond = getMegabitsPerSecond(bitsPerSecond);
  if (megabitsPerSecond == null) {
    return '—';
  }

  if (megabitsPerSecond >= 100) {
    return megabitsPerSecond.toFixed(0);
  }

  if (megabitsPerSecond >= 10) {
    return megabitsPerSecond.toFixed(1);
  }

  return megabitsPerSecond.toFixed(2);
}

function formatLatency(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds)) {
    return noDataLabel;
  }

  return `${milliseconds.toFixed(milliseconds >= 100 ? 0 : 1)} ms`;
}

function formatLatencyDialValue(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds)) {
    return '—';
  }

  return milliseconds.toFixed(milliseconds >= 100 ? 0 : 1);
}

function formatTransferSize(bytes: number | null | undefined, suffix: string) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return `Traffic ${suffix} unavailable`;
  }

  return `${formatBytes(bytes)} ${suffix}`;
}

function formatDistance(kilometers: number | null | undefined) {
  if (kilometers == null || !Number.isFinite(kilometers)) {
    return noDataLabel;
  }

  return `${kilometers.toFixed(kilometers >= 100 ? 0 : 1)} km`;
}

function formatInternetSpeedServer(sponsor: string | null | undefined, name: string | null | undefined, country: string | null | undefined) {
  const segments = [sponsor, name, country].filter((value): value is string => Boolean(value?.trim()));
  return segments.length > 0 ? segments.join(' • ') : noDataLabel;
}

function getMegabitsPerSecond(bitsPerSecond: number | null | undefined) {
  if (bitsPerSecond == null || !Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) {
    return null;
  }

  return bitsPerSecond / 1_000_000;
}

function getBandwidthGaugePercent(megabitsPerSecond: number | null) {
  if (megabitsPerSecond == null) {
    return 0;
  }

  const percent = Math.log10(megabitsPerSecond + 1) / Math.log10(1000 + 1);
  return Math.max(8, Math.min(100, Math.round(percent * 100)));
}

function getLatencyGaugePercent(milliseconds: number | null | undefined) {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds <= 0) {
    return 0;
  }

  const percent = 100 - ((Math.min(milliseconds, 250) / 250) * 100);
  return Math.max(8, Math.min(100, Math.round(percent)));
}

function getLatencyTone(milliseconds: number | null | undefined): 'emerald-soft' | 'amber' | 'rose' {
  if (milliseconds == null || !Number.isFinite(milliseconds)) {
    return 'rose';
  }

  if (milliseconds <= 25) {
    return 'emerald-soft';
  }

  if (milliseconds <= 80) {
    return 'amber';
  }

  return 'rose';
}

function clampPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatProgressDialValue(percent: number | null | undefined) {
  return `${clampPercent(percent)}%`;
}

function getInternetSpeedActiveMetric(stage: string | null | undefined): 'download' | 'upload' | 'ping' {
  if (stage === 'download' || stage === 'upload') {
    return stage;
  }

  return 'ping';
}

function getInternetSpeedStageLabel(stage: string | null | undefined) {
  return stage === 'download'
    ? 'Download'
    : stage === 'upload'
      ? 'Upload'
      : 'Ping';
}

function getInternetSpeedActiveCaption(stage: 'download' | 'upload' | 'ping', statusMessage: string | null | undefined) {
  if (!statusMessage) {
    return undefined;
  }

  const normalizedMessage = statusMessage.trim().toLowerCase();
  if ((stage === 'download' && normalizedMessage === 'measuring download speed.')
    || (stage === 'upload' && normalizedMessage === 'measuring upload speed.')
    || (stage === 'ping' && normalizedMessage === 'measuring ping speed.')) {
    return undefined;
  }

  return statusMessage;
}

function formatInternetSpeedConnectionMode(connectionMode: string | null | undefined) {
  if (!connectionMode) {
    return noDataLabel;
  }

  return stringEqualsIgnoreCase(connectionMode, 'single')
    ? 'Single'
    : stringEqualsIgnoreCase(connectionMode, 'multi')
      ? 'Multi'
      : connectionMode;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return noDataLabel;
  }

  return new Date(value).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCommit(value: string | null | undefined) {
  if (!value) {
    return noDataLabel;
  }

  return value.slice(0, 12);
}

function getReleaseChannel(releaseTag: string | null | undefined) {
  return releaseTag === 'dev-latest' ? 'dev' : 'main';
}

function formatWorkflowRun(runNumber: string | null | undefined, runAttempt: string | null | undefined) {
  if (!runNumber) {
    return noDataLabel;
  }

  if (!runAttempt) {
    return `#${runNumber}`;
  }

  return `#${runNumber} · attempt ${runAttempt}`;
}

function formatDuration(startedAt: string, reportedAt: string) {
  if (!startedAt || !reportedAt) {
    return noDataLabel;
  }

  const elapsedMilliseconds = Math.max(new Date(reportedAt).getTime() - new Date(startedAt).getTime(), 0);
  const totalSeconds = Math.floor(elapsedMilliseconds / 1000);

  return formatElapsedDuration(totalSeconds);
}

function formatElapsedDuration(totalSeconds: number | null | undefined) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) {
    return noDataLabel;
  }

  const wholeSeconds = Math.max(Math.floor(totalSeconds), 0);
  const days = Math.floor(wholeSeconds / 86400);
  const hours = Math.floor((wholeSeconds % 86400) / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return '<1m';
}


