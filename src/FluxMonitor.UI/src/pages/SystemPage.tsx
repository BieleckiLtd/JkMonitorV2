import { useEffect, useState, useRef, useCallback } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSignal, type IconDefinition } from '@fortawesome/free-solid-svg-icons';
import { Bluetooth, Cable, ChevronDown, ChevronRight, CircleAlert, Cloud, Cpu, Database, Download, ExternalLink, HardDrive, Leaf, Link2, LoaderCircle, Lock, MemoryStick, RefreshCcw, CheckCircle2, Terminal, Thermometer, Upload, Wifi, XCircle } from 'lucide-react';
import { Navigate, useParams } from 'react-router-dom';
import { PanelHeader } from '../components/PanelHeader';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Switch } from '../components/ui/switch';
import { type UpdateProgress, getUpdateStateTone } from '../lib/systemUpdate';
import { cn } from '../lib/utils';
import { LogsPanel } from '../components/LogsPanel';
import { useAppStore } from '../store/useAppStore';
import { getSystemSectionFromRouteSegment, getSystemSectionPath } from '../lib/systemNavigation';

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

const refreshIntervalMs = 5000;
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

type EthernetDisconnectResult = {
  success: boolean;
  interfaceName: string;
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

type SystemConnectivitySnapshot = {
  network: NetworkConnectivitySnapshot;
  bluetooth: BluetoothRuntimeSnapshot;
  ssh: SshServiceSnapshot;
  directAccess: DirectAccessSnapshot;
};

type DirectAccessSettingsSnapshot = {
  storageAvailable: boolean;
  autoStartMode: 'off' | 'when-wifi-not-connected' | string;
  wifiPassword?: string | null;
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

type PendingConnectivityAction =
  | {
    kind: 'disable-wifi';
    interfaceName: string;
    connectionName?: string | null;
  }
  | {
    kind: 'disconnect-ethernet';
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
  const [localAccessModeLoading, setLocalAccessModeLoading] = useState(false);
  const [localAccessModeFeedback, setLocalAccessModeFeedback] = useState<InlineFeedback | null>(null);
  const [localAccessWifiPassword, setLocalAccessWifiPassword] = useState('');
  const [localAccessShowPassword, setLocalAccessShowPassword] = useState(false);
  const [localAccessAdvancedOpen, setLocalAccessAdvancedOpen] = useState(false);
  const [localAccessSettingsSaving, setLocalAccessSettingsSaving] = useState(false);
  const [localAccessSettingsFeedback, setLocalAccessSettingsFeedback] = useState<InlineFeedback | null>(null);
  const [ethernetDisconnectLoading, setEthernetDisconnectLoading] = useState<string | null>(null);
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

        if (!isMounted) {
          return;
        }

        setStatus(data);
        setLoadError(null);
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

    void loadStatus();

    const intervalId = window.setInterval(() => {
      void loadStatus();
    }, refreshIntervalMs);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
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
        message: error instanceof Error ? error.message : 'Unable to change local access mode.',
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
          wifiPassword: localAccessWifiPassword,
        }),
      });

      const data = await response.json() as SaveDirectAccessSettingsResult;
      setLocalAccessSettingsFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        localAccessSettingsDirtyRef.current = false;
        setLocalAccessWifiPassword(data.settings.wifiPassword ?? '');
        await loadConnectivity();
      }
    } catch (error) {
      setLocalAccessSettingsFeedback({
        message: error instanceof Error ? error.message : 'Unable to save local access settings.',
        isError: true,
      });
    } finally {
      setLocalAccessSettingsSaving(false);
    }
  };

  const disconnectEthernet = async (interfaceName: string) => {
    setEthernetDisconnectLoading(interfaceName);
    setEthernetFeedback(null);

    try {
      const response = await fetch('/api/system/network/ethernet/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interfaceName }),
      });

      const data = await response.json() as EthernetDisconnectResult;
      setEthernetFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        await loadConnectivity();
      }
    } catch (error) {
      setEthernetFeedback({
        message: error instanceof Error ? error.message : 'Unable to disconnect the Ethernet interface.',
        isError: true,
      });
    } finally {
      setEthernetDisconnectLoading(null);
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

  const requestEthernetDisconnect = (ethernetInterface: EthernetInterfaceSnapshot) => {
    if (isEthernetInterfaceActive(ethernetInterface)) {
      setPendingConnectivityAction({
        kind: 'disconnect-ethernet',
        interfaceName: ethernetInterface.name,
        connectionName: ethernetInterface.connectionName,
      });
      return;
    }

    void disconnectEthernet(ethernetInterface.name);
  };

  const confirmPendingConnectivityAction = async () => {
    const action = pendingConnectivityAction;
    if (!action) {
      return;
    }

    setPendingConnectivityAction(null);

    if (action.kind === 'disable-wifi') {
      await toggleWifiPower();
      return;
    }

    await disconnectEthernet(action.interfaceName);
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
  const cpuUsage = metrics?.cpuUtilizationPercent ?? null;
  const cpuBaseClockSpeed = metrics?.cpuMaxClockSpeedMegahertz ?? null;
  const cpuCurrentClockSpeed = metrics?.cpuCurrentClockSpeedMegahertz ?? null;
  const isCpuThrottled = metrics?.cpuIsThrottled ?? false;
  const isCpuBelowBaseSpeed =
    cpuBaseClockSpeed != null &&
    cpuCurrentClockSpeed != null &&
    Number.isFinite(cpuBaseClockSpeed) &&
    Number.isFinite(cpuCurrentClockSpeed) &&
    cpuCurrentClockSpeed < cpuBaseClockSpeed;
  const cpuStatusIcon = isCpuThrottled ? Thermometer : isCpuBelowBaseSpeed ? Leaf : undefined;
  const cpuStatusIconClassName = isCpuThrottled ? 'text-rose-400' : 'text-emerald-400';
  const memoryUsed = metrics?.memoryUsedBytes ?? getDerivedUsedBytes(metrics?.memoryTotalBytes, metrics?.memoryAvailableBytes);
  const memoryTotal = metrics?.memoryTotalBytes ?? null;
  const storageUsed = metrics?.storageUsedBytes ?? null;
  const storageTotal = metrics?.storageTotalBytes ?? null;
  const memoryUsagePercent = getUsagePercent(memoryUsed, memoryTotal);
  const storageUsagePercent = getUsagePercent(storageUsed, storageTotal);
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
  const activeEthernetInterface = ethernetInterfaces.find((ethernetInterface) => isEthernetInterfaceActive(ethernetInterface)) ?? ethernetInterfaces[0] ?? null;
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
  const wifiSummary = connectedWifiInterface?.connectedSsid
    ? connectedWifiInterface.connectedSsid
    : wifiInterfaces.length > 0
      ? 'Manage nearby networks'
      : 'Wireless networking';
  const bluetoothSummary = activeBluetoothDevice?.displayName ?? 'Nearby devices';
  const localAccessSettings = connectivity?.directAccess.settings ?? null;
  const localAccessMode = connectivity?.directAccess.mode ?? null;
  const savedLocalAccessWifiPassword = localAccessSettings?.wifiPassword ?? '';
  const localAccessSettingsDirty = localAccessWifiPassword !== savedLocalAccessWifiPassword;
  const localAccessUsesWpa3Only = requiresSaeForLocalAccessPassword(localAccessWifiPassword);
  const localAccessAddresses = localAccessMode?.addresses ?? [];
  const localAccessPrimaryAddress = localAccessAddresses[0] ?? null;
  const localAccessHostname = formatLocalAccessHostName(localAccessMode?.hostName);
  const localAccessBluetoothDeviceName = formatLocalAccessBluetoothDeviceName(connectivity?.directAccess.bluetooth.deviceName);
  const localAccessEnabledSummary = buildLocalAccessIdentitySummary(localAccessHostname, localAccessBluetoothDeviceName);
  const localAccessEnabledDescription = buildLocalAccessEnabledDescription(localAccessHostname, localAccessBluetoothDeviceName);
  const connectivityPanelLinks = buildConnectivityPanelLinks(localAccessMode?.hostName, wifiInterfaces, ethernetInterfaces);
  const localAccessSummary = localAccessMode?.enabled
    ? localAccessEnabledSummary
    : 'Keeps nearby access available';
  const ethernetSummary = activeEthernetInterface
    ? activeEthernetInterface.connectionName
      ? activeEthernetInterface.connectionName
      : activeEthernetInterface.description || activeEthernetInterface.name
    : 'Wired network';
  const pendingConnectivityDialogTitle = pendingConnectivityAction?.kind === 'disable-wifi'
    ? 'Turn off Wi-Fi?'
    : pendingConnectivityAction?.kind === 'disconnect-ethernet'
      ? 'Disconnect Ethernet?'
      : null;
  const pendingConnectivityDialogDescription = pendingConnectivityAction?.kind === 'disable-wifi'
    ? `You are currently using ${pendingConnectivityAction.connectionName ?? pendingConnectivityAction.interfaceName}. Turning Wi-Fi off will disconnect this device from that network.`
    : pendingConnectivityAction?.kind === 'disconnect-ethernet'
      ? `Disconnect ${pendingConnectivityAction.interfaceName}${pendingConnectivityAction.connectionName ? ` from ${pendingConnectivityAction.connectionName}` : ''}? This can interrupt access to the device.`
      : null;
  const pendingConnectivityConfirmLabel = pendingConnectivityAction?.kind === 'disable-wifi'
    ? 'Turn off Wi-Fi'
    : pendingConnectivityAction?.kind === 'disconnect-ethernet'
      ? 'Disconnect Ethernet'
      : null;
  const isLogsSystemSection = activeSystemSection === 'logs';

  const renderLogsPage = () => (
    <div className='flex min-h-full flex-1 flex-col overflow-hidden'>
      <div className='flex min-h-0 flex-1 flex-col'>
        <LogsPanel />
      </div>
    </div>
  );

  const renderInternetSpeedSection = () => {
    const hasMeasuredInternetSpeed = internetSpeedDownloadMbps != null || internetSpeedUploadMbps != null;

    return (
      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
        <button
          type='button'
          onClick={() => void toggleConnectivitySection('internet-speed')}
          className='flex w-full min-w-0 items-center gap-3 px-4 py-4 text-left'
          aria-expanded={internetSpeedSectionOpen}
        >
          <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
            <Wifi className='h-4 w-4 text-muted-foreground' />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='text-sm font-semibold text-foreground'>Internet speed</div>
            {hasMeasuredInternetSpeed ? (
              <div className='mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
                <span className='inline-flex items-center gap-1'>
                  <Download className='h-3 w-3' />
                  {formatSpeedMbps(internetSpeedResult?.downloadBitsPerSecond)}
                </span>
                <span className='inline-flex items-center gap-1'>
                  <Upload className='h-3 w-3' />
                  {formatSpeedMbps(internetSpeedResult?.uploadBitsPerSecond)}
                </span>
              </div>
            ) : (
              <div className='mt-0.5 truncate text-xs text-muted-foreground'>Never measured</div>
            )}
          </div>
          <div className='pl-3 text-muted-foreground'>
            {internetSpeedSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
          </div>
        </button>

        {internetSpeedSectionOpen ? (
          <div className='space-y-4 border-t border-border/60 px-4 py-4'>
            {internetSpeedTestLoading && !internetSpeedTest ? (
              <div className='flex items-center justify-center py-8'>
                <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
              </div>
            ) : (
              <>
                {internetSpeedTestError ? (
                  <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                    {internetSpeedTestError}
                  </div>
                ) : null}

                {internetSpeedTest?.statusMessage && !internetSpeedTest.isRunning && (!internetSpeedTest.supported || internetSpeedTest.status === 'failed' || (!internetSpeedResult && internetSpeedTest.status !== 'succeeded')) ? (
                  <div className={cn(
                    'rounded-2xl border px-4 py-4',
                    internetSpeedTest.status === 'failed'
                      ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                      : 'border-border/70 bg-background/40 text-foreground'
                  )}>
                    <div className='flex items-start gap-3'>
                      {!internetSpeedTest.supported ? (
                        <CircleAlert className='mt-0.5 h-4 w-4 shrink-0' />
                      ) : internetSpeedTest.status === 'failed' ? (
                        <CircleAlert className='mt-0.5 h-4 w-4 shrink-0' />
                      ) : (
                        <CheckCircle2 className='mt-0.5 h-4 w-4 shrink-0 text-emerald-400' />
                      )}
                      <div className='min-w-0'>
                        <div className='text-sm font-semibold'>
                          {!internetSpeedTest.supported
                            ? 'Speed test unavailable'
                            : internetSpeedTest.status === 'failed'
                              ? 'Speed test did not finish'
                              : 'Internet speed ready'}
                        </div>
                        <div className='mt-1 text-xs opacity-85'>
                          {internetSpeedTest.statusMessage}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                <div className='grid gap-3 sm:grid-cols-3'>
                  <SpeedMetricCard
                    label='Ping'
                    value={internetSpeedPingValue}
                    dialValue={internetSpeedPingDialDisplay}
                    caption={internetSpeedPingCaption}
                    gaugePercent={internetSpeedPingDialGauge}
                    tone={internetSpeedPingTone}
                    isActive={internetSpeedPingIsActive}
                  />
                  <SpeedMetricCard
                    label='Download'
                    value={internetSpeedDownloadValue}
                    dialValue={internetSpeedDownloadDialDisplay}
                    caption={internetSpeedDownloadCaption}
                    gaugePercent={internetSpeedDownloadDialGauge}
                    tone='emerald'
                    isActive={internetSpeedDownloadIsActive}
                  />
                  <SpeedMetricCard
                    label='Upload'
                    value={internetSpeedUploadValue}
                    dialValue={internetSpeedUploadDialDisplay}
                    caption={internetSpeedUploadCaption}
                    gaugePercent={internetSpeedUploadDialGauge}
                    tone='sky'
                    isActive={internetSpeedUploadIsActive}
                  />
                </div>

                <div className='grid gap-3 sm:grid-cols-2'>
                  <DetailTile
                    label='Server'
                    value={formatInternetSpeedServer(
                      internetSpeedResult?.server?.sponsor,
                      internetSpeedResult?.server?.name,
                      internetSpeedResult?.server?.country
                    )}
                  />
                  <DetailTile label='Distance' value={formatDistance(internetSpeedResult?.server?.distanceKilometers)} />
                  <DetailTile label='Provider' value={internetSpeedResult?.client?.internetServiceProvider ?? noDataLabel} />
                  <DetailTile label='IP address' value={internetSpeedResult?.client?.ipAddress ?? noDataLabel} />
                  <DetailTile label='Connections' value={internetSpeedConnectionMode} />
                  <DetailTile label='Measured at' value={formatTimestamp(internetSpeedResult?.testedAt ?? internetSpeedTest?.completedAt)} />
                </div>

                <div>
                  <button
                    type='button'
                    disabled={internetSpeedTestStarting || internetSpeedTest?.isRunning || !internetSpeedTest?.canStart}
                    onClick={() => void startInternetSpeedTest()}
                    className='inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
                  >
                    {internetSpeedTestStarting || internetSpeedTest?.isRunning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Wifi className='h-4 w-4' />}
                    {internetSpeedTest?.isRunning ? 'Speed test running… please wait' : 'Run internet speed test'}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const renderTunnelSection = () => (
    <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
      <div className='flex items-center gap-3 px-4 py-4'>
        <button
          type='button'
          onClick={() => void toggleConnectivitySection('tunnel')}
          className='flex min-w-0 flex-1 items-center gap-3 text-left'
          aria-expanded={tunnelSectionOpen}
        >
          <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
            <Cloud className='h-4 w-4 text-muted-foreground' />
          </div>
          <div className='min-w-0 flex-1'>
            <div className='text-sm font-semibold text-foreground'>Tunnel</div>
            <div className='mt-0.5 truncate text-xs text-muted-foreground'>Access over the internet</div>
          </div>
        </button>

        <div className='flex shrink-0 items-center justify-end'>
          <Switch
            checked={cloudflareTunnelEnabled}
            disabled={cloudflareTunnelSaving || !cloudflareTunnelSupported}
            onCheckedChange={(checked) => {
              cloudflareTunnelDirtyRef.current = true;
              setCloudflareTunnelEnabled(checked);
              setCloudflareTunnelFeedback(null);
            }}
            aria-label='Toggle Tunnel'
          />
        </div>

        <button
          type='button'
          onClick={() => void toggleConnectivitySection('tunnel')}
          className='flex shrink-0 items-center justify-center text-muted-foreground'
          aria-label={tunnelSectionOpen ? 'Collapse tunnel details' : 'Expand tunnel details'}
          aria-expanded={tunnelSectionOpen}
        >
          {tunnelSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
        </button>
      </div>

      {tunnelSectionOpen ? (
        <div className='space-y-4 border-t border-border/60 px-4 py-4'>
          {cloudflareTunnelLoading && !cloudflareTunnelStatus ? (
            <div className='flex items-center justify-center py-6'>
              <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
            </div>
          ) : (
            <>
              {cloudflareTunnelError ? (
                <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                  {cloudflareTunnelError}
                </div>
              ) : null}

              {cloudflareTunnelFeedback ? (
                <div className={cn(
                  'rounded-xl border px-3 py-2 text-xs',
                  cloudflareTunnelFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                )}>
                  {cloudflareTunnelFeedback.message}
                </div>
              ) : null}

              {!cloudflareTunnelSupported ? (
                <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                  {cloudflareTunnelStatus?.statusMessage ?? 'Cloudflare Tunnel is unavailable on this host.'}
                </div>
              ) : (
                <>
                  <div className='rounded-2xl border border-border/70 bg-background/35 px-4 py-4'>
                    <div className='text-sm font-semibold text-foreground'>How it works</div>
                    <div className='mt-3 space-y-1 font-mono text-sm text-muted-foreground'>
                      <div>Your browser eg. on the phone</div>
                      <div>↓</div>
                      <div>Cloudflare (login + protection)</div>
                      <div>↓</div>
                      <div>Tunnel (secure pipe)</div>
                      <div>↓</div>
                      <div>Flux Monitor app on Raspberry Pi</div>
                    </div>
                    <div className='mt-3 text-xs text-muted-foreground'>
                      This exposes Flux Monitor to the internet on your own hostname or on a Cloudflare URL such as
                      {' '}
                      <span className='font-mono text-foreground'>random-name.trycloudflare.com</span>
                      . Because it is reachable from outside your home network, add a Cloudflare login wall first.
                    </div>
                  </div>

                  <div className='rounded-2xl border border-border/70 bg-background/35 px-4 py-4'>
                    <div className='text-sm font-semibold text-foreground'>Cloudflare setup</div>
                    <div className='mt-3 space-y-2 text-sm text-muted-foreground'>
                      <div>1. In Cloudflare Tunnel, create a tunnel and copy the command or token shown on the connector page.</div>
                      <div>2. In Published applications, choose your hostname. Use your own domain if you have one. If you use a temporary Cloudflare URL, that is configured on the Cloudflare side, not here in Flux Monitor.</div>
                      <div>3. Leave Path empty unless you only want to expose part of the app.</div>
                      <div>4. Set Service Type to <span className='font-mono text-foreground'>HTTP</span>.</div>
                      <div>5. Set URL to <span className='font-mono text-foreground'>127.0.0.1:5074</span> or <span className='font-mono text-foreground'>localhost:5074</span>.</div>
                    </div>
                    <div className='mt-3 flex flex-wrap gap-3 text-sm'>
                      <a
                        href='https://developers.cloudflare.com/tunnel/setup/'
                        target='_blank'
                        rel='noreferrer'
                        className='inline-flex items-center gap-2 text-primary hover:underline'
                      >
                        <ExternalLink className='h-4 w-4' />
                        Open Tunnel hostname docs
                      </a>
                      <a
                        href='https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/'
                        target='_blank'
                        rel='noreferrer'
                        className='inline-flex items-center gap-2 text-primary hover:underline'
                      >
                        <ExternalLink className='h-4 w-4' />
                        Open connector setup docs
                      </a>
                    </div>
                  </div>

                  <div className='rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-4'>
                    <div className='text-sm font-semibold text-foreground'>Protect it with Cloudflare Access</div>
                    <div className='mt-3 space-y-2 text-sm text-amber-50/90'>
                      <div>Access → Applications</div>
                      <div>Add application</div>
                      <div>Enter your hostname</div>
                      <div>Add policy: Allow → Emails → your@email.com</div>
                      <div>Choose login method: OTP or Google</div>
                    </div>
                    <div className='mt-3 text-xs text-amber-100/80'>
                      OTP is the simplest option if you already use one-time email codes. This puts a login wall in front of the app before traffic reaches your Raspberry Pi.
                    </div>
                    <div className='mt-3'>
                      <a
                        href='https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/'
                        target='_blank'
                        rel='noreferrer'
                        className='inline-flex items-center gap-2 text-sm text-amber-100 hover:underline'
                      >
                        <ExternalLink className='h-4 w-4' />
                        Open Access application docs
                      </a>
                    </div>
                  </div>

                  <div className='space-y-2'>
                    <label className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground' htmlFor='cloudflare-token'>
                      Tunnel token or Cloudflare command
                    </label>
                    <textarea
                      id='cloudflare-token'
                      value={cloudflareTunnelTokenOrCommand}
                      onChange={(event) => {
                        cloudflareTunnelDirtyRef.current = true;
                        setCloudflareTunnelTokenOrCommand(event.target.value);
                      }}
                      placeholder={cloudflareTunnelMaskedToken
                        ? `Leave blank to keep the saved token (${cloudflareTunnelMaskedToken}).`
                        : 'Paste the cloudflared install command, run command, or the raw tunnel token.'}
                      disabled={cloudflareTunnelSaving || !cloudflareTunnelSupported}
                      className='min-h-24 w-full rounded-xl border border-input bg-background/70 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
                    />
                    <div className='text-xs text-muted-foreground'>
                      Flux Monitor extracts the token automatically if you paste a command copied from the Cloudflare page.
                    </div>
                  </div>

                  <div className='flex justify-end'>
                    <button
                      type='button'
                      disabled={cloudflareTunnelSaving || !cloudflareTunnelSupported}
                      onClick={() => void saveCloudflareTunnel()}
                      className='inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
                    >
                      {cloudflareTunnelSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Cloud className='h-4 w-4' />}
                      Save tunnel settings
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  );

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
      {isLogsSystemSection ? renderLogsPage() : (
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
              <Card className='border border-border/80 bg-card/85 shadow-sm'>
                <PanelHeader
                  title='Resource usage'
                  description='CPU, memory, and storage capacity on the host running the monitor service.'
                  aside={(
                    <div className='space-y-1 text-right text-xs text-muted-foreground'>
                      <div>Host uptime {formatElapsedDuration(metrics?.systemUptimeSeconds)}</div>
                      <div>App uptime {applicationUptime}</div>
                    </div>
                  )}
                />
                <CardContent className='grid gap-5 pt-5'>
                  <UsagePanel
                    icon={Cpu}
                    label='CPU'
                    percent={cpuUsage}
                    summary={`Current ${formatFrequency(metrics?.cpuCurrentClockSpeedMegahertz)}`}
                    secondary={`Base ${formatFrequency(metrics?.cpuMaxClockSpeedMegahertz)} • ${formatWholeNumber(metrics?.cpuCoreCount)} cores`}
                    details={[
                      `${formatWholeNumber(metrics?.processCount)} processes`,
                      `System temperature ${formatDecimalValue(metrics?.systemTemperatureCelsius, '°C')}`,
                      `Fan speed ${formatRpm(metrics?.mainFanSpeedRpm)}`,
                    ]}
                    labelIcon={cpuStatusIcon}
                    labelIconClassName={cpuStatusIconClassName}
                  />
                  <UsagePanel
                    icon={MemoryStick}
                    label='Memory'
                    percent={memoryUsagePercent}
                    summary={formatUsage(memoryUsed, memoryTotal)}
                    secondary={metrics?.memoryAvailableBytes != null ? `${formatBytes(metrics.memoryAvailableBytes)} free` : noDataLabel}
                  />
                  <UsagePanel
                    icon={HardDrive}
                    label='Storage'
                    percent={storageUsagePercent}
                    summary={formatUsage(storageUsed, storageTotal)}
                    secondary={storageTotal != null && storageUsed != null ? `${formatBytes(Math.max(storageTotal - storageUsed, 0))} free` : noDataLabel}
                  />
                </CardContent>
              </Card>
            ) : null}

            <Card className={cn('border border-border/80 bg-card/85 shadow-sm', activeSystemSection !== 'software-update' && 'hidden')}>
              <CardContent className='space-y-4 pt-6'>
                  <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
                    <UpdateChannelTile
                      value={preferredUpdateChannel}
                      disabled={updateChannelSaving || updateChecking || (updateProgress?.isRunning ?? false)}
                      pending={updateChannelSaving}
                      onChange={saveUpdateChannel}
                    />
                    <DetailTile label='Commit' value={formatCommit(installedCommit)} />
                    <DetailTile label='Workflow' value={workflowRun} />
                    <DetailTile label='Published' value={installedReleasePublishedLabel} />
                  </div>
                  {updateCheck?.currentChannel && preferredUpdateChannel && updateCheck.currentChannel !== preferredUpdateChannel ? (
                    <div className='rounded-xl border border-border bg-muted/70 px-3 py-2 text-xs text-muted-foreground'>
                      Installed build is on the {formatReleaseChannel(updateCheck.currentChannel)} channel. New update checks use the {formatReleaseChannel(preferredUpdateChannel)} branch.
                    </div>
                  ) : null}
                  {updateChecking && !updateCheck ? (
                    <div className='flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-3 py-2 text-sm text-muted-foreground'>
                      <LoaderCircle className='h-4 w-4 animate-spin' />
                      Checking the current release channel…
                    </div>
                  ) : null}
                  {updateCheck ? (
                    <>
                      {updateCheck.checkError ? (
                        <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                          Update check failed: {updateCheck.checkError}
                        </div>
                      ) : updateCheck.updateAvailable && updateProgress?.success !== true ? (
                        <div className='rounded-xl border border-primary/20 bg-primary/10 px-3 py-2 text-sm text-primary'>
                          <div className='flex items-center gap-2'>
                            <Download className='h-4 w-4' />
                            A new version is available.
                          </div>
                          {updateCheck.targetReleaseTag ? (
                            <div className='mt-1 text-xs text-primary/80'>
                              {updateCheck.targetReleaseTag} on the {formatReleaseChannel(updateCheck.targetChannel)} channel
                            </div>
                          ) : null}
                          {updateCheck.commits && updateCheck.commits.length > 0 ? (
                            <div className='mt-2 space-y-1'>
                              <div className='text-[10px] font-medium uppercase tracking-[0.16em] text-primary/60'>Changes</div>
                              <ul className='space-y-0.5 text-xs text-primary/80'>
                                {updateCheck.commits.map((c, i) => (
                                  <li key={i} className='flex gap-1.5'>
                                    <span className='shrink-0 font-mono text-[10px] text-primary/50'>{c.sha ?? ''}</span>
                                    <span>{c.message ?? ''}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      ) : !updateCheck.updateAvailable ? (
                        <div className='flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200'>
                          <CheckCircle2 className='h-4 w-4' />
                          Installed version is current.
                        </div>
                      ) : null}

                      {!updateCheck.canUpdate ? (
                        <div className='rounded-xl border border-border bg-muted/70 px-3 py-2 text-xs text-muted-foreground'>
                          {updateCheck.reason}
                        </div>
                      ) : null}

                      {updateActionError ? (
                        <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                          {updateActionError}
                        </div>
                      ) : null}

                      {updateChannelError ? (
                        <div className='rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200'>
                          {updateChannelError}
                        </div>
                      ) : null}

                      {updateProgress ? (
                        <div className={cn(
                          'rounded-xl border px-3 py-2 text-xs',
                          getUpdateStateTone(updateProgress.status) === 'success'
                            ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                            : getUpdateStateTone(updateProgress.status) === 'error'
                              ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                              : getUpdateStateTone(updateProgress.status) === 'warning'
                                ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                                : 'border-primary/20 bg-primary/10 text-primary'
                        )}>
                          <div className='flex items-center gap-2'>
                            {updateProgress.isRunning ? <LoaderCircle className='h-3.5 w-3.5 animate-spin shrink-0' /> : updateProgress.status === 'succeeded' ? <CheckCircle2 className='h-3.5 w-3.5 shrink-0' /> : updateProgress.status === 'cancelled' ? <CircleAlert className='h-3.5 w-3.5 shrink-0' /> : <XCircle className='h-3.5 w-3.5 shrink-0' />}
                            {updateProgress.stage}
                          </div>
                          <div className='mt-1.5 opacity-90'>
                            {updateProgress.detail}
                          </div>
                          {updateProgress.percentComplete != null ? (
                            <div className='mt-3'>
                              <div className='mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.16em] opacity-70'>
                                <span>
                                  {updateProgress.stepIndex && updateProgress.stepCount ? `Step ${updateProgress.stepIndex} of ${updateProgress.stepCount}` : 'Progress'}
                                </span>
                                <span>{updateProgress.percentComplete}%</span>
                              </div>
                              <div className='h-1.5 overflow-hidden rounded-full bg-background/40'>
                                <div className='h-full rounded-full bg-current transition-[width] duration-500 ease-out' style={{ width: `${Math.max(updateProgress.percentComplete, 4)}%` }} />
                              </div>
                            </div>
                          ) : null}
                          {updateProgress.isRunning ? (
                            <div className='mt-2 opacity-80'>
                              {updateProgress.canCancel
                                ? 'You can still cancel now if you need to stop the update.'
                                : updateProgress.cancelUnavailableReason ?? 'Do not turn off the device while the update is being finalized.'}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {updateCheck?.canUpdate && updateCheck?.updateAvailable ? (
                    <div className='pt-2'>
                      <button
                        type='button'
                        disabled={updateActionPending === 'starting' || (updateProgress?.isRunning ?? false)}
                        onClick={() => void installUpdate()}
                        className='inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
                      >
                        {updateActionPending === 'starting' || updateProgress?.isRunning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Download className='h-4 w-4' />}
                        Install update
                      </button>
                    </div>
                  ) : null}
              </CardContent>
            </Card>
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

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <div className='flex items-center gap-3 px-4 py-4'>
                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('wifi')}
                            className='flex min-w-0 flex-1 items-center gap-3 text-left'
                            aria-expanded={wifiSectionOpen}
                          >
                            <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                              <Wifi className='h-4 w-4 text-muted-foreground' />
                            </div>
                            <div className='min-w-0 flex-1'>
                              <div className='text-sm font-semibold text-foreground'>Wi-Fi</div>
                              <div className='mt-0.5 truncate text-xs text-muted-foreground'>{wifiSummary}</div>
                            </div>
                          </button>

                          <div className='flex shrink-0 items-center justify-end'>
                            <Switch
                              checked={Boolean(connectivity?.network.supported) && wifiPowered !== false}
                              disabled={wifiPowerLoading || !(connectivity?.network.supported ?? false)}
                              onCheckedChange={() => requestWifiPowerToggle()}
                              aria-label='Toggle Wi-Fi power'
                            />
                          </div>

                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('wifi')}
                            className='flex shrink-0 items-center justify-center text-muted-foreground'
                            aria-label={wifiSectionOpen ? 'Collapse Wi-Fi details' : 'Expand Wi-Fi details'}
                            aria-expanded={wifiSectionOpen}
                          >
                            {wifiSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
                          </button>
                        </div>

                        {wifiSectionOpen ? (
                          <div className='space-y-4 border-t border-border/60 px-4 py-4'>
                            {wifiFeedback ? (
                              <div className={cn(
                                'rounded-2xl border px-3 py-2 text-xs',
                                wifiFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                              )}>
                                {wifiFeedback.message}
                              </div>
                            ) : null}

                            {!connectivity?.network.supported ? (
                              <div className='rounded-2xl border border-border bg-muted/70 px-3 py-3 text-xs text-muted-foreground'>
                                {connectivity?.network.statusMessage ?? 'Wi-Fi controls are unavailable on this host.'}
                              </div>
                            ) : wifiPowered === false ? (
                              <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                Turn Wi-Fi on to scan nearby networks and switch access points.
                              </div>
                            ) : wifiInterfaces.length === 0 || !selectedWifiInterface ? (
                              <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                No Wi-Fi interfaces detected.
                              </div>
                            ) : (
                              <>
                                {wifiInterfaces.length > 1 ? (
                                  <div className='flex flex-wrap gap-2'>
                                    {wifiInterfaces.map((wifiInterface) => (
                                      <button
                                        key={wifiInterface.name}
                                        type='button'
                                        disabled={wifiScanLoading === wifiInterface.name}
                                        onClick={() => void selectWifiInterface(wifiInterface)}
                                        className={cn(
                                          'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                                          selectedWifiInterface.name === wifiInterface.name
                                            ? 'border-primary/40 bg-primary/10 text-foreground'
                                            : 'border-border bg-background/60 text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                                        )}
                                      >
                                        {wifiInterface.name}
                                      </button>
                                    ))}
                                  </div>
                                ) : null}

                                <div className='rounded-2xl border border-border/70 bg-background/30 px-4 py-3'>
                                  <div className='min-w-0'>
                                    <div className='text-sm font-semibold text-foreground font-mono'>{selectedWifiInterface.name}</div>
                                    {selectedWifiInterface.connectedSsid ? (
                                      <div className='mt-1 flex items-center gap-2 text-xs text-muted-foreground'>
                                        <span>{selectedWifiInterface.connectedSsid}</span>
                                        <SignalStrengthIndicator
                                          kind='wifi'
                                          percent={selectedWifiInterface.signalPercent}
                                        />
                                      </div>
                                    ) : (
                                      <div className='mt-1 text-xs text-muted-foreground'>Not connected</div>
                                    )}
                                    {selectedWifiInterface.addresses.length > 0 ? (
                                      <div className='mt-1 break-all text-[11px] font-mono text-muted-foreground'>
                                        {selectedWifiInterface.addresses.join(' • ')}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                <div className='space-y-2'>
                                  <div className='flex items-center justify-between gap-3'>
                                    <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Nearby networks</div>
                                    {hasInternetAccess === false ? (
                                      <div className='text-[11px] text-amber-300'>No internet. Scanning nearby networks.</div>
                                    ) : null}
                                  </div>
                                  {selectedWifiAccessPoints.length > 0 ? (
                                    <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
                                      {selectedWifiAccessPoints.map((accessPoint, index) => (
                                        <button
                                          key={`${accessPoint.bssid ?? accessPoint.ssid}-${accessPoint.interfaceName}`}
                                          type='button'
                                          onClick={() => void selectWifiAccessPoint(accessPoint)}
                                          className={cn(
                                            'group flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-background/70',
                                            index > 0 ? 'border-t border-border/60' : '',
                                            accessPoint.isActive ? 'bg-primary/8' : ''
                                          )}
                                        >
                                          <div className='flex min-w-0 items-center gap-2'>
                                            {isWifiNetworkSecured(accessPoint) ? <Lock className='h-3.5 w-3.5 shrink-0 text-muted-foreground' /> : null}
                                            <div className='truncate text-sm font-medium text-foreground'>{accessPoint.ssid}</div>
                                          </div>
                                          <SignalStrengthIndicator
                                            kind='wifi'
                                            percent={accessPoint.signalPercent}
                                            revealOnParentInteraction
                                            className='shrink-0'
                                          />
                                        </button>
                                      ))}
                                    </div>
                                  ) : wifiScanLoading === selectedWifiInterface.name ? (
                                    <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                      Scanning nearby networks...
                                    </div>
                                  ) : wifiScanLoading !== selectedWifiInterface.name ? (
                                    <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                      No scan results yet. Click scan to refresh nearby networks.
                                    </div>
                                  ) : null}

                                  <button
                                    type='button'
                                    onClick={openOtherWifiDialog}
                                    className='flex w-full items-center justify-between gap-3 rounded-2xl border border-border/70 bg-background/20 px-4 py-3 text-left transition-colors hover:bg-background/70'
                                  >
                                    <div className='text-sm font-medium text-foreground'>Other</div>
                                    <ChevronRight className='h-4 w-4 text-muted-foreground' />
                                  </button>
                                </div>

                                <button
                                  type='button'
                                  disabled={wifiScanLoading === selectedWifiInterface.name}
                                  onClick={() => void scanWifi(selectedWifiInterface.name)}
                                  className='inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                                >
                                  {wifiScanLoading === selectedWifiInterface.name ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
                                  Scan networks
                                </button>
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <div className='flex items-center gap-3 px-4 py-4'>
                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('bluetooth')}
                            className='flex min-w-0 flex-1 items-center gap-3 text-left'
                            aria-expanded={bluetoothSectionOpen}
                          >
                            <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                              <Bluetooth className='h-4 w-4 text-muted-foreground' />
                            </div>
                            <div className='min-w-0 flex-1'>
                              <div className='text-sm font-semibold text-foreground'>Bluetooth</div>
                              <div className='mt-0.5 truncate text-xs text-muted-foreground'>{bluetoothSummary}</div>
                            </div>
                          </button>

                          <div className='flex shrink-0 items-center justify-end'>
                            <Switch
                              checked={Boolean(connectivity?.bluetooth.supported) && Boolean(connectivity?.bluetooth.powered)}
                              disabled={bluetoothPowerLoading || !(connectivity?.bluetooth.supported ?? false)}
                              onCheckedChange={() => void toggleBluetoothPower()}
                              aria-label='Toggle Bluetooth power'
                            />
                          </div>

                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('bluetooth')}
                            className='flex shrink-0 items-center justify-center text-muted-foreground'
                            aria-label={bluetoothSectionOpen ? 'Collapse Bluetooth details' : 'Expand Bluetooth details'}
                            aria-expanded={bluetoothSectionOpen}
                          >
                            {bluetoothSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
                          </button>
                        </div>

                        {bluetoothSectionOpen ? (
                          <div className='space-y-4 border-t border-border/60 px-4 py-4'>
                            {connectivity?.bluetooth.statusMessage ? (
                              <div className='rounded-2xl border border-border bg-muted/70 px-3 py-2 text-xs text-muted-foreground'>
                                {connectivity.bluetooth.statusMessage}
                              </div>
                            ) : null}

                            {bluetoothFeedback ? (
                              <div className={cn(
                                'rounded-2xl border px-3 py-2 text-xs',
                                bluetoothFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                              )}>
                                {bluetoothFeedback.message}
                              </div>
                            ) : null}

                            {!connectivity?.bluetooth.supported ? (
                              <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                Bluetooth controls are unavailable on this host.
                              </div>
                            ) : !connectivity.bluetooth.powered ? (
                              <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                Turn Bluetooth on to scan nearby devices.
                              </div>
                            ) : (
                              <>
                                {visibleBluetoothDevices.length > 0 ? (
                                  <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
                                    {visibleBluetoothDevices.map((device, index) => (
                                      <div key={device.address} className={index > 0 ? 'border-t border-border/60' : undefined}>
                                        <BluetoothDeviceCard device={device} />
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                    No Bluetooth devices found.
                                  </div>
                                )}

                                <button
                                  type='button'
                                  disabled={bluetoothScanLoading}
                                  onClick={() => void scanBluetooth()}
                                  className='inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                                >
                                  {bluetoothScanLoading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
                                  Scan networks
                                </button>
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <div className='flex items-center gap-3 px-4 py-4'>
                          <div className='flex min-w-0 flex-1 items-center gap-3'>
                            <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                              <Terminal className='h-4 w-4 text-muted-foreground' />
                            </div>
                            <div className='min-w-0 flex-1'>
                              <div className='text-sm font-semibold text-foreground'>SSH</div>
                              <div className='mt-0.5 text-xs text-muted-foreground'>Enable secure remote terminal access to this device.</div>
                            </div>
                          </div>

                          <div className='flex shrink-0 items-center justify-end'>
                            <Switch
                              checked={sshToggleChecked}
                              disabled={sshToggleLoading || !(sshAccess?.supported ?? false)}
                              onCheckedChange={() => void toggleSshAccess(!sshToggleChecked)}
                              aria-label='Toggle SSH access'
                            />
                          </div>
                        </div>
                      </div>

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <button
                          type='button'
                          onClick={() => void toggleConnectivitySection('ethernet')}
                          className='flex w-full min-w-0 items-center gap-3 px-4 py-4 text-left'
                        >
                          <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                            <Cable className='h-4 w-4 text-muted-foreground' />
                          </div>
                          <div className='min-w-0 flex-1'>
                            <div className='text-sm font-semibold text-foreground'>Ethernet</div>
                            <div className='mt-0.5 truncate text-xs text-muted-foreground'>{ethernetSummary}</div>
                          </div>
                          <div className='pl-3 text-muted-foreground'>
                            {ethernetSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
                          </div>
                        </button>

                        {ethernetSectionOpen ? (
                          <div className='space-y-4 border-t border-border/60 px-4 py-4'>
                            {ethernetFeedback ? (
                              <div className={cn(
                                'rounded-2xl border px-3 py-2 text-xs',
                                ethernetFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                              )}>
                                {ethernetFeedback.message}
                              </div>
                            ) : null}

                            {ethernetInterfaces.length > 0 ? (
                              <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
                                {ethernetInterfaces.map((ethernetInterface, index) => (
                                  <div
                                    key={ethernetInterface.name}
                                    className={cn(
                                      'flex flex-col items-start gap-3 px-4 py-3 sm:flex-row sm:justify-between',
                                      index > 0 ? 'border-t border-border/60' : ''
                                    )}
                                  >
                                    <div className='min-w-0 flex-1'>
                                      <div className='text-sm font-semibold text-foreground font-mono'>{ethernetInterface.name}</div>
                                      <div className='mt-1 text-xs text-muted-foreground'>
                                        {ethernetInterface.connectionName
                                          ? `${ethernetInterface.connectionName}${ethernetInterface.speedMbps ? ` • ${ethernetInterface.speedMbps} Mbps` : ''}`
                                          : ethernetInterface.description || 'Wired interface'}
                                      </div>
                                      {ethernetInterface.addresses.length > 0 ? (
                                        <div className='mt-1 break-all text-[11px] font-mono text-muted-foreground'>
                                          {ethernetInterface.addresses.join(' • ')}
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className='flex w-full flex-col items-start gap-2 sm:w-auto sm:shrink-0 sm:items-end'>
                                      <div className='text-xs text-muted-foreground sm:text-right'>
                                        {ethernetInterface.connectionState ?? ethernetInterface.status ?? 'Unknown'}
                                      </div>
                                      {isEthernetInterfaceActive(ethernetInterface) ? (
                                        <button
                                          type='button'
                                          disabled={ethernetDisconnectLoading === ethernetInterface.name}
                                          onClick={() => requestEthernetDisconnect(ethernetInterface)}
                                          className='inline-flex items-center justify-center rounded-lg border border-border bg-background/80 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                                        >
                                          {ethernetDisconnectLoading === ethernetInterface.name ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : 'Disconnect'}
                                        </button>
                                      ) : null}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                No Ethernet interfaces detected.
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <div className='flex items-center gap-3 px-4 py-4'>
                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('local-access')}
                            className='flex min-w-0 flex-1 items-center gap-3 text-left'
                            aria-expanded={localAccessSectionOpen}
                          >
                            <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                              <Link2 className='h-4 w-4 text-muted-foreground' />
                            </div>
                            <div className='min-w-0 flex-1'>
                              <div className='text-sm font-semibold text-foreground'>Local access mode</div>
                              <div className='mt-0.5 truncate text-xs text-muted-foreground'>{localAccessSummary}</div>
                            </div>
                          </button>

                          <div className='flex shrink-0 items-center justify-end'>
                            <Switch
                              checked={Boolean(localAccessMode?.supported) && Boolean(localAccessMode?.enabled)}
                              disabled={localAccessModeLoading || !(localAccessMode?.supported ?? false)}
                              onCheckedChange={() => void toggleLocalAccessMode(!(localAccessMode?.enabled ?? false))}
                              aria-label='Toggle local access mode'
                            />
                          </div>

                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('local-access')}
                            className='flex shrink-0 items-center justify-center text-muted-foreground'
                            aria-label={localAccessSectionOpen ? 'Collapse local access details' : 'Expand local access details'}
                            aria-expanded={localAccessSectionOpen}
                          >
                            {localAccessSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
                          </button>
                        </div>

                        {localAccessSectionOpen ? (
                          <div className='space-y-4 border-t border-border/60 px-4 py-4'>
                            <div className='text-xs leading-5 text-muted-foreground'>
                              {localAccessMode?.enabled
                                ? localAccessEnabledDescription
                                : 'Lets you connect to the device if it loses connection to the Wi-Fi router.'}
                            </div>

                            {localAccessModeFeedback ? (
                              <div className={cn(
                                'rounded-2xl border px-3 py-2 text-xs',
                                localAccessModeFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                              )}>
                                {localAccessModeFeedback.message}
                              </div>
                            ) : null}

                            {!localAccessMode?.supported ? (
                              <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                {localAccessMode?.statusMessage ?? 'Local access mode is unavailable on this host.'}
                              </div>
                            ) : null}

                            {localAccessMode?.active ? (
                              <div className='rounded-2xl border border-border/70 bg-background/35 px-4 py-4'>
                                <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
                                  <DetailTile label='Hostname' value={localAccessHostname} />
                                  <DetailTile label='IP address' value={localAccessPrimaryAddress ?? 'Waiting'} />
                                  <DetailTile label='Hotspot name' value={localAccessMode.hotspotName ?? 'Waiting'} />
                                  <DetailTile label='Password' value={localAccessMode.hotspotPassword || 'No password'} />
                                </div>
                                {localAccessAddresses.length > 1 ? (
                                  <div className='mt-3 break-all text-[11px] font-mono text-muted-foreground'>
                                    {localAccessAddresses.join(' • ')}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}

                            <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/30'>
                              <button
                                type='button'
                                onClick={() => setLocalAccessAdvancedOpen((current) => !current)}
                                className='flex w-full items-center justify-between gap-3 px-4 py-3 text-left'
                              >
                                <div className='text-sm font-medium text-foreground'>Advanced</div>
                                {localAccessAdvancedOpen ? <ChevronDown className='h-4 w-4 text-muted-foreground' /> : <ChevronRight className='h-4 w-4 text-muted-foreground' />}
                              </button>

                              {localAccessAdvancedOpen ? (
                                <div className='space-y-4 border-t border-border/60 px-4 py-4'>
                                  {!localAccessSettings?.storageAvailable ? (
                                    <div className='rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-100'>
                                      Local access settings cannot be saved until PostgreSQL storage is configured.
                                    </div>
                                  ) : null}

                                  {localAccessSettingsFeedback ? (
                                    <div className={cn(
                                      'rounded-2xl border px-3 py-2 text-xs',
                                      localAccessSettingsFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                                    )}>
                                      {localAccessSettingsFeedback.message}
                                    </div>
                                  ) : null}

                                  <div className='space-y-2'>
                                    <label className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>
                                      Hotspot password
                                    </label>
                                    <Input
                                      aria-label='Local access hotspot password'
                                      type={localAccessShowPassword ? 'text' : 'password'}
                                      value={localAccessWifiPassword}
                                      onChange={(event) => {
                                        localAccessSettingsDirtyRef.current = true;
                                        setLocalAccessSettingsFeedback(null);
                                        setLocalAccessWifiPassword(event.target.value);
                                      }}
                                      placeholder='No password'
                                    />
                                    <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                                      <input
                                        type='checkbox'
                                        checked={localAccessShowPassword}
                                        onChange={(event) => setLocalAccessShowPassword(event.target.checked)}
                                        className='h-4 w-4 rounded border border-input bg-background/70'
                                      />
                                      <span>Show password</span>
                                    </label>
                                    <div className='text-xs leading-5 text-muted-foreground'>
                                      {localAccessWifiPassword.length === 0
                                        ? 'Leave this blank if you want local access to start without a password.'
                                        : localAccessUsesWpa3Only
                                          ? 'This password uses WPA3-only hotspot security.'
                                          : 'This password uses the standard hotspot security mode.'}
                                    </div>
                                  </div>

                                  <div className='flex justify-end'>
                                    <button
                                      type='button'
                                      aria-label='Save local access settings'
                                      disabled={localAccessSettingsSaving || !localAccessSettings?.storageAvailable || !localAccessSettingsDirty}
                                      onClick={() => void saveLocalAccessAdvancedSettings()}
                                      className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                                    >
                                      {localAccessSettingsSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : null}
                                      Save
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      {renderInternetSpeedSection()}

                      {renderTunnelSection()}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card className={cn('border border-border/80 bg-card/85 shadow-sm', activeSystemSection !== 'hardware-interfaces' && 'hidden')}>
              <PanelHeader
                title='Hardware interfaces'
                description='Serial ports and block devices detected on this host.'
              />
              <CardContent className='space-y-4 pt-5'>
                {interfaces ? (
                  <>
                    {interfaces.serialPorts.length > 0 ? (
                      <div className='space-y-2'>
                        <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Serial ports</div>
                        {interfaces.serialPorts.map((port) => (
                          <div key={port.name} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                            <div className='text-sm font-semibold text-foreground font-mono'>{port.name}</div>
                            {port.description ? <div className='mt-1 text-xs text-muted-foreground'>{port.description}</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className='rounded-2xl border border-dashed border-border bg-background/40 px-4 py-3 text-center text-xs text-muted-foreground'>
                        No serial ports detected.
                      </div>
                    )}

                    {interfaces.blockDevices.length > 0 ? (
                      <div className='space-y-2'>
                        <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Block devices</div>
                        {interfaces.blockDevices.map((dev) => (
                          <div key={dev.name} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                            <div className='flex flex-wrap items-center justify-between gap-2'>
                              <div className='min-w-0 break-all text-sm font-semibold text-foreground font-mono'>{dev.name}</div>
                              <div className='text-xs text-muted-foreground'>{dev.sizeFormatted}</div>
                            </div>
                            {dev.model ? <div className='mt-1 text-xs text-muted-foreground'>{dev.model}</div> : null}
                            {dev.readOnly ? <div className='mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400'>Read-only</div> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}

                  </>
                ) : (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className={cn('border border-border/80 bg-card/85 shadow-sm', activeSystemSection !== 'database' && 'hidden')}>
              <PanelHeader
                title='Database'
                description='TimescaleDB storage size, backup, and restore.'
              />
              <CardContent className='space-y-4 pt-5'>
                {dbLoading && !dbSize ? (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                ) : dbSize ? (
                  <>
                    <DetailTile label='Total database size' value={dbSize.totalSizeFormatted} />
                    <div className='space-y-2'>
                      {dbSize.tables.map((t) => (
                        <div key={t.tableName} className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
                          <div className='flex flex-wrap items-center justify-between gap-2'>
                            <div className='min-w-0 break-all text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground font-mono'>{t.tableName}</div>
                            <div className='text-xs text-muted-foreground'>{t.rowCount.toLocaleString()} rows</div>
                          </div>
                          <div className='mt-1 text-sm font-semibold text-foreground'>{t.sizeFormatted}</div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className='text-sm text-muted-foreground'>Unable to load database info.</div>
                )}

                <div className='rounded-2xl border border-border/70 bg-background/50 px-4 py-4'>
                  <div className='space-y-1'>
                    <div className='text-sm font-semibold text-foreground'>Storage policy</div>
                    <div className='max-w-2xl text-xs leading-5 text-muted-foreground'>
                      Temporary history stays in memory at the device&apos;s raw poll cadence, so faster polling can keep sub-second samples. Persisted buckets are written to the database forever.
                    </div>
                  </div>

                  {dbSettingsLoading && !dbSettingsForm ? (
                    <div className='flex items-center justify-center py-8'>
                      <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                    </div>
                  ) : dbSettings && dbSettingsForm ? (
                    <div className='space-y-4 pt-4'>
                      <div className='grid gap-4 sm:grid-cols-2'>
                        <label className='space-y-2'>
                          <span className='block text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Temporary memory history</span>
                          <Select
                            value={dbSettingsForm.rawSecondsWindowMinutes}
                            onValueChange={(value) => {
                              if (value === null) {
                                return;
                              }

                              setDbSettingsForm((current) => current ? { ...current, rawSecondsWindowMinutes: value } : current);
                              setDbSettingsFeedback(null);
                            }}
                          >
                            <SelectTrigger aria-label='Temporary memory history minutes' className='w-full'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {supportedTemporaryHistoryMinutes.map((minutes) => (
                                <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span className='block text-[11px] leading-5 text-muted-foreground'>Larger temporary memory windows use more RAM, especially when devices poll faster than once per second.</span>
                        </label>

                        <label className='space-y-2'>
                          <span className='block text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Persisted bucket size</span>
                          <Select
                            value={dbSettingsForm.persistedBucketMinutes}
                            onValueChange={(value) => {
                              if (value === null) {
                                return;
                              }

                              setDbSettingsForm((current) => current ? { ...current, persistedBucketMinutes: value } : current);
                              setDbSettingsFeedback(null);
                            }}
                          >
                            <SelectTrigger aria-label='Persisted bucket minutes' className='w-full'>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {supportedPersistedBucketMinutes.map((minutes) => (
                                <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span className='block text-[11px] leading-5 text-muted-foreground'>Smaller persisted buckets capture more detail, but they also grow the database faster.</span>
                        </label>
                      </div>

                      {dbSettingsFeedback ? (
                        <div className={cn(
                          'rounded-xl border px-3 py-2 text-xs',
                          dbSettingsFeedback.isError ? 'border-rose-500/20 bg-rose-500/10 text-rose-200' : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                        )}>
                          {dbSettingsFeedback.message}
                        </div>
                      ) : null}

                      <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
                        <div className='text-[11px] leading-5 text-muted-foreground'>
                          Current policy: {dbSettings.rawSecondsWindowMinutes}m of temporary in-memory history, {dbSettings.persistedBucketMinutes}m persisted buckets stored forever in the database.
                        </div>
                        <button
                          type='button'
                          disabled={dbSettingsSaving || !dbSettingsDirty}
                          onClick={() => { void saveDatabaseSettings(); }}
                          className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50'
                        >
                          {dbSettingsSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Database className='h-4 w-4' />}
                          {dbSettingsSaving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className='pt-4 text-sm text-muted-foreground'>Unable to load database retention settings.</div>
                  )}
                </div>

                <div className='flex flex-col gap-2 pt-2'>
                  <button
                    type='button'
                    onClick={handleExport}
                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
                  >
                    <Download className='h-4 w-4' />
                    Export database
                  </button>

                  <input
                    ref={fileInputRef}
                    type='file'
                    accept='.csv,.sql'
                    className='hidden'
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleImport(file);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type='button'
                    disabled={importing}
                    onClick={() => fileInputRef.current?.click()}
                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                  >
                    {importing ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Upload className='h-4 w-4' />}
                    {importing ? 'Importing…' : 'Import database'}
                  </button>

                  {importResult ? (
                    <div className={cn('rounded-xl border px-3 py-2 text-xs', importResult.includes('successfully') ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200')}>
                      {importResult}
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>

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

function UsagePanel({
  icon: Icon,
  label,
  percent,
  summary,
  secondary,
  details,
  labelIcon: LabelIcon,
  labelIconClassName,
}: {
  icon: typeof Cpu;
  label: string;
  percent: number | null;
  summary: string;
  secondary: string;
  details?: string[];
  labelIcon?: typeof Cpu;
  labelIconClassName?: string;
}) {
  const footerSegments = [secondary, ...(details ?? [])];

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <Icon className='h-4 w-4 shrink-0 text-muted-foreground' />
            <div className='flex items-center gap-1.5 text-sm font-semibold text-foreground'>
              <span>{label}</span>
              {LabelIcon ? <LabelIcon className={cn('h-3.5 w-3.5 shrink-0', labelIconClassName)} /> : null}
            </div>
          </div>
          <div className='text-sm text-muted-foreground'>{summary}</div>
        </div>
        <div className='shrink-0 text-sm font-semibold text-foreground'>{formatPercent(percent)}</div>
      </div>
      <div className='h-2 overflow-hidden rounded-full bg-muted'>
        <div className='h-full rounded-full bg-primary transition-[width] duration-500 ease-out' style={{ width: `${Math.max(percent ?? 0, 4)}%` }} />
      </div>
      <div className='flex flex-wrap items-center gap-y-1 text-xs text-muted-foreground'>
        {footerSegments.map((segment, index) => (
          <span key={`${index}-${segment}`} className='whitespace-nowrap'>
            {index > 0 ? <span className='px-1 text-muted-foreground/70'>•</span> : null}
            {segment}
          </span>
        ))}
      </div>
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
      <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>{label}</div>
      <div className='mt-2 text-sm font-semibold text-foreground'>{value}</div>
    </div>
  );
}

function UpdateChannelTile({
  value,
  disabled,
  pending,
  onChange,
}: {
  value: string;
  disabled: boolean;
  pending: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className='rounded-2xl border border-border/70 bg-background/50 px-4 py-3'>
      <div className='flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>
        <span>Channel</span>
        {pending ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : null}
      </div>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label='Software update channel' className='mt-2 w-full'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='dev'>Dev</SelectItem>
          <SelectItem value='main'>Main</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function SpeedMetricCard({
  label,
  value,
  dialValue,
  caption,
  gaugePercent,
  tone,
  isActive = false,
}: {
  label: string;
  value: string;
  dialValue: string;
  caption?: string;
  gaugePercent: number;
  tone: 'emerald' | 'sky' | 'emerald-soft' | 'amber' | 'rose';
  isActive?: boolean;
}) {
  const toneClassName = tone === 'emerald'
    ? 'text-emerald-400'
    : tone === 'sky'
      ? 'text-sky-400'
      : tone === 'amber'
        ? 'text-amber-400'
        : tone === 'rose'
          ? 'text-rose-400'
          : 'text-emerald-300';
  const toneBarClassName = tone === 'emerald'
    ? 'bg-emerald-400'
    : tone === 'sky'
      ? 'bg-sky-400'
      : tone === 'amber'
        ? 'bg-amber-400'
        : tone === 'rose'
          ? 'bg-rose-400'
          : 'bg-emerald-300';

  return (
    <div className={cn(
      'rounded-2xl border border-border/70 bg-background/50 px-4 py-4 transition-colors duration-300',
      isActive && 'border-primary/35 bg-primary/5'
    )}>
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0 space-y-1'>
          <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>{label}</div>
          <div className='text-sm font-semibold text-foreground'>{value}</div>
          {caption ? <div className='text-xs leading-5 text-muted-foreground'>{caption}</div> : null}
        </div>
        <div className='shrink-0 text-right'>
          <div className={cn('text-xl font-semibold tracking-tight', toneClassName)}>{dialValue}</div>
          <div className='mt-1 text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Current</div>
        </div>
      </div>
      <div className='mt-4 h-1.5 overflow-hidden rounded-full bg-background/70'>
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', toneBarClassName)}
          style={{ width: `${Math.max(8, Math.min(100, gaugePercent))}%` }}
        />
      </div>
    </div>
  );
}

function BluetoothDeviceCard({ device }: { device: BluetoothDeviceSnapshot }) {
  return (
    <div className='flex items-center justify-between gap-3 px-4 py-3'>
      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold text-foreground'>{device.displayName}</div>
        <div className='mt-1 text-[11px] font-mono text-muted-foreground'>{device.address}</div>
      </div>
      <SignalStrengthIndicator
        kind='signal'
        percent={normalizeBluetoothSignalPercent(device.rssi)}
        unavailableLabel='Signal unavailable'
        className='shrink-0'
      />
    </div>
  );
}

function SignalStrengthIndicator({
  kind,
  percent,
  disabled = false,
  unavailableLabel = 'Unavailable',
  revealOnParentInteraction = false,
  className,
}: {
  kind: 'wifi' | 'signal';
  percent: number | null | undefined;
  disabled?: boolean;
  unavailableLabel?: string;
  revealOnParentInteraction?: boolean;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const normalizedPercent = normalizeSignalPercent(percent);
  const label = normalizedPercent != null ? `${normalizedPercent}%` : unavailableLabel;

  return (
    <span
      role='button'
      tabIndex={0}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setRevealed((current) => !current);
      }}
      onMouseEnter={() => setRevealed(true)}
      onMouseLeave={() => setRevealed(false)}
      onBlur={() => setRevealed(false)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          setRevealed((current) => !current);
        }
      }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-background/60',
        revealOnParentInteraction ? 'group-hover:bg-background/60 group-focus:bg-background/60 group-active:bg-background/60' : '',
        className
      )}
    >
      <SignalStrengthGlyph kind={kind} percent={normalizedPercent} disabled={disabled} />
      <span className={cn(
        'overflow-hidden whitespace-nowrap transition-all duration-150',
        revealed
          ? 'max-w-16 opacity-100'
          : revealOnParentInteraction
            ? 'max-w-0 opacity-0 group-hover:max-w-16 group-hover:opacity-100 group-focus:max-w-16 group-focus:opacity-100 group-active:max-w-16 group-active:opacity-100'
            : 'max-w-0 opacity-0'
      )}>
        {label}
      </span>
    </span>
  );
}

function SignalStrengthGlyph({
  kind,
  percent,
  disabled,
}: {
  kind: 'wifi' | 'signal';
  percent: number | null;
  disabled: boolean;
}) {
  if (kind === 'wifi') {
    return <WifiSignalGlyph percent={percent} disabled={disabled} />;
  }

  const toneClassName = getSignalToneClassName(percent, disabled);

  return (
    <span className='inline-flex items-center justify-center' aria-hidden='true'>
      <FontAwesomeIcon icon={faSignal as IconDefinition} className={cn('h-3.5 w-3.5 transition-opacity', toneClassName)} />
    </span>
  );
}

function WifiSignalGlyph({ percent, disabled }: { percent: number | null; disabled: boolean }) {
  const state = getWifiSignalState(percent, disabled);
  const toneClassName = getWifiSignalToneClassName(state);

  return (
    <span className={cn('inline-flex items-center justify-center', toneClassName)} aria-hidden='true'>
      <svg viewBox='0 0 640 512' className='h-3.5 w-4 fill-current'>
        {state === 'weak' ? (
          <>
            <path opacity='.4' d='M0 179.8c0 8 3 15.9 8.9 22.2c12.2 12.8 32.5 13.2 45.2 .9C123.2 136.7 216.8 96 320 96s196.8 40.7 265.8 106.9c12.8 12.2 33 11.8 45.2-.9c6-6.2 8.9-14.2 8.9-22.2c0-8.4-3.3-16.8-9.8-23.1C549.7 79.5 440.4 32 320 32S90.3 79.5 9.8 156.7C3.3 163 0 171.4 0 179.8zM126.7 309.2c11.7 13.3 31.9 14.5 45.2 2.8c39.5-34.9 91.3-56 148.2-56s108.6 21.1 148.2 56c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2C459.8 219.2 393 192 320 192s-139.8 27.2-190.5 72c-13.3 11.7-14.5 31.9-2.8 45.2z' />
            <path d='M256 416a64 64 0 1 1 128 0 64 64 0 1 1 -128 0z' />
          </>
        ) : state === 'fair' ? (
          <>
            <path opacity='.4' d='M0 179.8c0 8 3 15.9 8.9 22.2c6.3 6.5 14.7 9.8 23.1 9.8c8 0 15.9-3 22.2-8.9C123.2 136.7 216.8 96 320 96s196.8 40.7 265.8 106.9c6.2 6 14.2 8.9 22.2 8.9c8.4 0 16.8-3.3 23.1-9.8c12.2-12.8 11.8-33-.9-45.2C549.7 79.5 440.4 32 320 32S90.3 79.5 9.8 156.7C3.3 163 0 171.4 0 179.8z' />
            <path d='M171.8 312c39.5-34.9 91.3-56 148.2-56s108.7 21.1 148.2 56c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2C459.8 219.2 393 192 320 192s-139.8 27.2-190.5 72c-13.3 11.7-14.5 31.9-2.8 45.2s31.9 14.5 45.2 2.8zM320 480a64 64 0 1 0 0-128 64 64 0 1 0 0 128z' />
          </>
        ) : state === 'strong' ? (
          <path d='M54.2 202.9C123.2 136.7 216.8 96 320 96s196.8 40.7 265.8 106.9c12.8 12.2 33 11.8 45.2-.9s11.8-33-.9-45.2C549.7 79.5 440.4 32 320 32S90.3 79.5 9.8 156.7C-2.9 169-3.3 189.2 8.9 202s32.5 13.2 45.2 .9zM320 256c56.8 0 108.6 21.1 148.2 56c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2C459.8 219.2 393 192 320 192s-139.8 27.2-190.5 72c-13.3 11.7-14.5 31.9-2.8 45.2s31.9 14.5 45.2 2.8c39.5-34.9 91.3-56 148.2-56zm64 160a64 64 0 1 0 -128 0 64 64 0 1 0 128 0z' />
        ) : state === 'none' ? (
          <>
            <path opacity='.4' d='M8.9 202c12.2 12.8 32.5 13.2 45.2 .9c51.3-49.2 116.2-84.3 188.5-99.1l-1.4-19.3c-1.2-17.4 3.3-33.9 11.9-47.6C159.4 51 75.1 94.1 9.8 156.7C-2.9 169-3.3 189.2 8.9 202zM126.7 309.2c11.7 13.3 31.9 14.5 45.2 2.8c23.6-20.8 51.6-36.7 82.4-46.2l-4.7-65.1C204.4 212 163.4 234.1 129.5 264c-13.3 11.7-14.5 31.9-2.8 45.2zm259.1-43.4c30.8 9.4 58.8 25.4 82.4 46.2c13.3 11.7 33.5 10.4 45.2-2.8s10.4-33.5-2.8-45.2c-33.9-29.9-74.9-52-120.1-63.3l-4.6 65.1zM386.8 37c8.6 13.7 13.1 30.1 11.9 47.6l-1.4 19.3c72.3 14.8 137.2 49.9 188.5 99.1c12.8 12.2 33 11.8 45.2-.9c6-6.2 8.9-14.2 8.9-22.2c0-8.4-3.3-16.8-9.8-23.1C564.9 94.1 480.6 51 386.8 37z' />
            <path d='M320 32c-27.2 0-48.7 23.1-46.8 50.2l14.9 208C289.3 307 303.2 320 320 320s30.7-13 31.9-29.7l14.9-208C368.7 55.1 347.2 32 320 32zm0 448a64 64 0 1 0 0-128 64 64 0 1 0 0 128z' />
          </>
        ) : (
          <>
            <path opacity='.4' d='M8.9 202c-12.2-12.8-11.8-33 .9-45.2C20 147 30.7 137.7 41.7 128.9l51.9 40.9C79.7 179.9 66.6 191 54.2 202.9c-12.8 12.2-33 11.8-45.2-.9zM126.7 309.2c-11.7-13.3-10.4-33.5 2.8-45.2c13.4-11.9 28-22.5 43.5-31.7L228 275.7c-20.6 9.3-39.5 21.6-56.2 36.3c-13.3 11.7-33.5 10.4-45.2-2.8zm1.4-234.1C186.3 47.5 251.3 32 320 32c120.4 0 229.7 47.5 310.2 124.7c12.8 12.2 13.2 32.5 .9 45.2s-32.5 13.2-45.2 .9C516.8 136.7 423.2 96 320 96c-47.3 0-92.6 8.5-134.4 24.2c-19.2-15-38.3-30.1-57.5-45.1zM256 416c0-35.3 28.7-64 64-64c1.7 0 3.5 .1 5.2 .2L380.8 396c2.1 6.3 3.2 13 3.2 20c0 35.3-28.7 64-64 64s-64-28.7-64-64zm24.7-221.3c12.9-1.8 26-2.7 39.3-2.7c73 0 139.8 27.2 190.5 72c13.2 11.7 14.5 31.9 2.8 45.2s-31.9 14.5-45.2 2.8c-28.9-25.5-64.4-43.7-103.6-51.6c-28-21.9-55.9-43.8-83.9-65.8z' />
            <path d='M5.1 9.2C13.3-1.2 28.4-3.1 38.8 5.1l592 464c10.4 8.2 12.3 23.3 4.1 33.7s-23.3 12.3-33.7 4.1L9.2 42.9C-1.2 34.7-3.1 19.6 5.1 9.2z' />
          </>
        )}
      </svg>
    </span>
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

function normalizeSignalPercent(percent: number | null | undefined) {
  if (percent == null || !Number.isFinite(percent)) {
    return null;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeBluetoothSignalPercent(rssi: number | null | undefined) {
  if (rssi == null || !Number.isFinite(rssi)) {
    return null;
  }

  return normalizeSignalPercent(((rssi + 100) / 50) * 100);
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

function buildLocalAccessIdentitySummary(hostName: string, bluetoothDeviceName: string) {
  return `Hostname: ${hostName} | Bluetooth: ${bluetoothDeviceName}`;
}

function buildLocalAccessEnabledDescription(hostName: string, bluetoothDeviceName: string) {
  return `If Wi-Fi drops, the hostname will be ${hostName} and the Bluetooth name will be ${bluetoothDeviceName}.`;
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

function getWifiSignalState(percent: number | null, disabled: boolean) {
  if (disabled) {
    return 'disabled' as const;
  }

  if (percent == null || percent <= 0) {
    return 'none' as const;
  }

  if (percent < 34) {
    return 'weak' as const;
  }

  if (percent < 67) {
    return 'fair' as const;
  }

  return 'strong' as const;
}

function getWifiSignalToneClassName(state: 'disabled' | 'none' | 'weak' | 'fair' | 'strong') {
  if (state === 'disabled') {
    return 'text-muted-foreground/45';
  }

  if (state === 'none') {
    return 'text-muted-foreground/55';
  }

  if (state === 'weak') {
    return 'text-muted-foreground/75';
  }

  if (state === 'fair') {
    return 'text-foreground/85';
  }

  return 'text-foreground';
}

function getSignalToneClassName(percent: number | null, disabled: boolean) {
  if (disabled || percent == null) {
    return 'text-muted-foreground/35';
  }

  if (percent >= 75) {
    return 'text-foreground';
  }

  if (percent >= 50) {
    return 'text-foreground/80';
  }

  if (percent >= 25) {
    return 'text-muted-foreground/75';
  }

  return 'text-muted-foreground/45';
}

function isWifiInterfaceInUse(wifiInterface: WifiInterfaceSnapshot | null | undefined) {
  return Boolean(wifiInterface?.connectedSsid) || (wifiInterface?.addresses.length ?? 0) > 0;
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

function formatUsage(usedBytes: number | null, totalBytes: number | null) {
  if (usedBytes == null || totalBytes == null) {
    return noDataLabel;
  }

  return `${formatBytes(usedBytes)} of ${formatBytes(totalBytes)}`;
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatWholeNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return Math.round(value).toLocaleString();
}

function formatFrequency(megahertz: number | null | undefined) {
  if (megahertz == null || !Number.isFinite(megahertz)) {
    return noDataLabel;
  }

  if (megahertz >= 1000) {
    return `${(megahertz / 1000).toFixed(2)} GHz`;
  }

  return `${Math.round(megahertz).toLocaleString()} MHz`;
}

function formatDecimalValue(value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${value.toFixed(Math.abs(value) >= 100 ? 0 : 1)} ${unit}`;
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

function formatRpm(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return noDataLabel;
  }

  return `${Math.round(value).toLocaleString()} RPM`;
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

function formatReleaseChannel(channel: string | null | undefined) {
  if (!channel) {
    return noDataLabel;
  }

  return channel === 'dev' ? 'Dev' : channel === 'main' ? 'Main' : channel;
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

function getUsagePercent(usedBytes: number | null, totalBytes: number | null) {
  if (usedBytes == null || totalBytes == null || totalBytes <= 0) {
    return null;
  }

  return Math.min(Math.max((usedBytes / totalBytes) * 100, 0), 100);
}

function getDerivedUsedBytes(totalBytes: number | null | undefined, availableBytes: number | null | undefined) {
  if (totalBytes == null || availableBytes == null) {
    return null;
  }

  return Math.max(totalBytes - availableBytes, 0);
}
