import { useEffect, useState, useRef, useCallback } from 'react';
import { Bluetooth, Cable, ChevronDown, ChevronRight, CircleAlert, Cpu, Database, Download, HardDrive, Leaf, LoaderCircle, MemoryStick, RefreshCcw, CheckCircle2, Upload, Usb, Wifi, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';
import { LogsPanel } from '../components/LogsPanel';

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

type CommitInfo = {
  sha?: string | null;
  message?: string | null;
  date?: string | null;
};

type UpdateCheckResult = {
  currentReleaseTag?: string | null;
  currentSourceRevision?: string | null;
  currentBuiltAt?: string | null;
  canUpdate: boolean;
  reason?: string | null;
  updateAvailable: boolean;
  remoteReleasePublishedAt?: string | null;
  remoteChecksum?: string | null;
  localChecksum?: string | null;
  checkError?: string | null;
  commits?: CommitInfo[] | null;
};

type UpdateProgress = {
  isRunning: boolean;
  stage: string;
  success?: boolean | null;
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
};

type WifiPowerResult = {
  success: boolean;
  powered: boolean;
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

type SystemConnectivitySnapshot = {
  network: NetworkConnectivitySnapshot;
  bluetooth: BluetoothRuntimeSnapshot;
};

type InlineFeedback = {
  message: string;
  isError: boolean;
};

export function SystemPage() {
  const [status, setStatus] = useState<MonitorRuntimeStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dbSize, setDbSize] = useState<DatabaseSizeInfo | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [interfaces, setInterfaces] = useState<SystemInterfacesResponse | null>(null);
  const [connectivity, setConnectivity] = useState<SystemConnectivitySnapshot | null>(null);
  const [connectivityLoading, setConnectivityLoading] = useState(true);
  const [connectivityError, setConnectivityError] = useState<string | null>(null);
  const [wifiScanLoading, setWifiScanLoading] = useState<string | null>(null);
  const [wifiAccessPoints, setWifiAccessPoints] = useState<Record<string, WifiAccessPointInfo[]>>({});
  const [wifiTargetInterface, setWifiTargetInterface] = useState('');
  const [wifiTargetSsid, setWifiTargetSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const [wifiFeedback, setWifiFeedback] = useState<InlineFeedback | null>(null);
  const [wifiConnectLoading, setWifiConnectLoading] = useState(false);
  const [wifiPowerLoading, setWifiPowerLoading] = useState(false);
  const [bluetoothScanResult, setBluetoothScanResult] = useState<BluetoothScanResult | null>(null);
  const [bluetoothScanLoading, setBluetoothScanLoading] = useState(false);
  const [bluetoothPowerLoading, setBluetoothPowerLoading] = useState(false);
  const [bluetoothFeedback, setBluetoothFeedback] = useState<InlineFeedback | null>(null);
  const [expandedConnectivitySection, setExpandedConnectivitySection] = useState<'wifi' | 'bluetooth' | 'ethernet' | null>('wifi');

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

  useEffect(() => {
    void loadDbSize();
    const id = window.setInterval(() => void loadDbSize(), 30000);
    return () => window.clearInterval(id);
  }, []);

  const checkForUpdate = useCallback(async () => {
    setUpdateChecking(true);
    try {
      const response = await fetch('/api/system/update/check', { cache: 'no-store' });
      if (response.ok) {
        setUpdateCheck(await response.json() as UpdateCheckResult);
      }
    } catch {
      // Silently ignore.
    } finally {
      setUpdateChecking(false);
    }
  }, []);

  useEffect(() => {
    void checkForUpdate();
  }, [checkForUpdate]);

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
    const id = window.setInterval(() => void loadConnectivity(), 15000);
    return () => window.clearInterval(id);
  }, [loadConnectivity]);

  useEffect(() => {
    const firstWifiInterface = connectivity?.network.wifiInterfaces[0];
    if (!firstWifiInterface) {
      setWifiTargetInterface('');
      setWifiTargetSsid('');
      return;
    }

    setWifiTargetInterface((current) => {
      if (current && connectivity?.network.wifiInterfaces.some((wifiInterface) => wifiInterface.name === current)) {
        return current;
      }

      return firstWifiInterface.name;
    });
    setWifiTargetSsid((current) => current || firstWifiInterface.connectedSsid || '');
  }, [connectivity]);

  const installUpdate = async () => {
    setUpdateInstalling(true);
    try {
      const response = await fetch('/api/system/update/install', { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string } | null;
        setUpdateProgress({ isRunning: false, stage: body?.error ?? 'Failed to start update.', success: false });
        return;
      }
      // Poll progress
      const pollProgress = async () => {
        let installerStarted = false;
        for (let i = 0; i < 120; i++) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try {
            const resp = await fetch('/api/system/update/progress', { cache: 'no-store' });
            if (resp.status === 204) {
              // Service restarted — in-memory progress is gone, install succeeded.
              if (installerStarted) {
                setUpdateProgress({ isRunning: false, stage: 'Update installed successfully.', success: true });
                await checkForUpdate();
              }
              return;
            }
            if (resp.ok) {
              const progress = await resp.json() as UpdateProgress;
              setUpdateProgress(progress);
              if (!progress.isRunning) {
                if (progress.success === true) await checkForUpdate();
                return;
              }
              installerStarted = true;
            }
          } catch {
            // Service is restarting — wait for it to come back.
            setUpdateProgress({ isRunning: false, stage: 'Service restarting…', success: true });
            for (let j = 0; j < 30; j++) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              try {
                await fetch('/api/system/update/progress', { cache: 'no-store' });
                setUpdateProgress({ isRunning: false, stage: 'Update installed successfully.', success: true });
                await checkForUpdate();
                return;
              } catch {
                // Still restarting.
              }
            }
            return;
          }
        }
      };
      void pollProgress();
    } catch {
      setUpdateProgress({ isRunning: false, stage: 'Network error starting update.', success: false });
    } finally {
      setUpdateInstalling(false);
    }
  };

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
    const id = window.setInterval(() => void loadInterfaces(), 30000);
    return () => window.clearInterval(id);
  }, []);

  const scanWifi = async (interfaceName: string) => {
    setWifiScanLoading(interfaceName);
    setWifiFeedback(null);
    setWifiTargetInterface(interfaceName);

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
      } else if (data.accessPoints.length > 0) {
        setWifiTargetSsid((current) => current || data.accessPoints[0].ssid);
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

  const connectWifi = async () => {
    if (!wifiTargetSsid.trim()) {
      setWifiFeedback({ message: 'Enter or select an SSID before connecting.', isError: true });
      return;
    }

    if (!wifiTargetInterface.trim()) {
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
          ssid: wifiTargetSsid.trim(),
          password: wifiPassword || null,
          interfaceName: wifiTargetInterface,
        }),
      });

      const data = await response.json() as WifiConnectResult;
      setWifiFeedback({ message: data.message, isError: !response.ok || !data.success });

      if (response.ok && data.success) {
        setWifiPassword('');
        await loadConnectivity();
      }
    } catch (error) {
      setWifiFeedback({
        message: error instanceof Error ? error.message : 'Unable to connect to the selected Wi-Fi network.',
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

  const selectWifiInterface = async (wifiInterface: WifiInterfaceSnapshot) => {
    setWifiTargetInterface(wifiInterface.name);
    setWifiTargetSsid(wifiInterface.connectedSsid || '');
    await scanWifi(wifiInterface.name);
  };

  const toggleConnectivitySection = async (section: 'wifi' | 'bluetooth' | 'ethernet') => {
    const isOpen = expandedConnectivitySection === section;
    const nextSection = isOpen ? null : section;
    setExpandedConnectivitySection(nextSection);

    if (!nextSection) {
      return;
    }

    if (section === 'wifi' && connectivity?.network.supported && wifiPowered !== false && selectedWifiInterface) {
      await selectWifiInterface(selectedWifiInterface);
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

  const handleExport = () => {
    window.location.href = '/api/database/export';
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
  const cpuUsage = metrics?.cpuUtilizationPercent ?? null;
  const cpuBaseClockSpeed = metrics?.cpuMaxClockSpeedMegahertz ?? null;
  const cpuCurrentClockSpeed = metrics?.cpuCurrentClockSpeedMegahertz ?? null;
  const isCpuBelowBaseSpeed =
    cpuBaseClockSpeed != null &&
    cpuCurrentClockSpeed != null &&
    Number.isFinite(cpuBaseClockSpeed) &&
    Number.isFinite(cpuCurrentClockSpeed) &&
    cpuCurrentClockSpeed < cpuBaseClockSpeed;
  const memoryUsed = metrics?.memoryUsedBytes ?? getDerivedUsedBytes(metrics?.memoryTotalBytes, metrics?.memoryAvailableBytes);
  const memoryTotal = metrics?.memoryTotalBytes ?? null;
  const storageUsed = metrics?.storageUsedBytes ?? null;
  const storageTotal = metrics?.storageTotalBytes ?? null;
  const memoryUsagePercent = getUsagePercent(memoryUsed, memoryTotal);
  const storageUsagePercent = getUsagePercent(storageUsed, storageTotal);
  const applicationUptime = status ? formatDuration(status.startedAt, status.reportedAt) : noDataLabel;
  const sourceRevisionId = status?.build?.sourceRevisionId ?? noDataLabel;
  const workflowRun = formatWorkflowRun(status?.build?.workflowRunNumber, status?.build?.workflowRunAttempt);
  const ethernetInterfaces = connectivity?.network.ethernetInterfaces ?? [];
  const wifiInterfaces = connectivity?.network.wifiInterfaces ?? [];
  const wifiPowered = connectivity?.network.wifiPowered ?? null;
  const selectedWifiInterface = wifiInterfaces.find((wifiInterface) => wifiInterface.name === wifiTargetInterface) ?? wifiInterfaces[0] ?? null;
  const selectedWifiAccessPoints = selectedWifiInterface ? wifiAccessPoints[selectedWifiInterface.name] ?? [] : [];
  const bluetoothDevices = connectivity?.bluetooth.devices ?? [];
  const scannedBluetoothDevices = bluetoothScanResult?.devices ?? [];
  const visibleBluetoothDevices = mergeBluetoothDevices(bluetoothDevices, scannedBluetoothDevices);
  const connectedWifiInterface = wifiInterfaces.find((wifiInterface) => wifiInterface.connectedSsid) ?? selectedWifiInterface;
  const activeBluetoothDevice = visibleBluetoothDevices.find((device) => device.isConnected) ?? visibleBluetoothDevices[0] ?? null;
  const activeEthernetInterface = ethernetInterfaces.find((ethernetInterface) =>
    (ethernetInterface.connectionState ?? ethernetInterface.status ?? '').toLowerCase().includes('connected')
    || stringEqualsIgnoreCase(ethernetInterface.status, 'up')) ?? ethernetInterfaces[0] ?? null;
  const wifiSectionOpen = expandedConnectivitySection === 'wifi';
  const bluetoothSectionOpen = expandedConnectivitySection === 'bluetooth';
  const ethernetSectionOpen = expandedConnectivitySection === 'ethernet';
  const wifiSummary = !connectivity?.network.supported
    ? connectivity?.network.statusMessage ?? 'Wi-Fi unavailable'
    : wifiPowered === false
      ? 'Off'
      : connectedWifiInterface?.connectedSsid
        ? `${connectedWifiInterface.connectedSsid} on ${connectedWifiInterface.name}`
        : wifiInterfaces.length > 0
          ? `Not connected${selectedWifiInterface ? ` • ${selectedWifiInterface.name}` : ''}`
          : 'No Wi-Fi interface detected';
  const wifiStatusLabel = !connectivity?.network.supported
    ? 'Unavailable'
    : wifiPowered === false
      ? 'Off'
      : connectedWifiInterface?.signalPercent != null
        ? `${connectedWifiInterface.signalPercent}%`
        : 'On';
  const bluetoothSummary = !connectivity?.bluetooth.supported
    ? connectivity?.bluetooth.statusMessage ?? 'Bluetooth unavailable'
    : connectivity.bluetooth.powered
      ? activeBluetoothDevice
        ? `${activeBluetoothDevice.displayName} • ${activeBluetoothDevice.address}`
        : 'Ready to scan nearby devices'
      : connectivity.bluetooth.statusMessage ?? 'Off';
  const bluetoothStatusLabel = !connectivity?.bluetooth.supported
    ? 'Unavailable'
    : connectivity.bluetooth.powered
      ? 'On'
      : 'Off';
  const ethernetSummary = activeEthernetInterface
    ? activeEthernetInterface.connectionName
      ? `${activeEthernetInterface.name} • ${activeEthernetInterface.connectionName}`
      : activeEthernetInterface.description || activeEthernetInterface.name
    : 'No wired connection';
  const ethernetStatusLabel = activeEthernetInterface?.connectionState ?? activeEthernetInterface?.status ?? 'Unavailable';

  return (
    <div className='space-y-6 pb-8'>
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
        <div className='grid gap-6 xl:grid-cols-[1.35fr_1fr]'>
          <div className='space-y-6'>
            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
                  <div>
                    <CardTitle>Resource usage</CardTitle>
                    <CardDescription>CPU, memory, and storage capacity on the host running the monitor service.</CardDescription>
                  </div>
                  <div className='space-y-1 text-right text-xs text-muted-foreground'>
                    <div>Host uptime {formatElapsedDuration(metrics?.systemUptimeSeconds)}</div>
                    <div>App uptime {applicationUptime}</div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='grid gap-5 pt-5'>
                <UsagePanel
                  icon={isCpuBelowBaseSpeed ? Leaf : Cpu}
                  label='CPU'
                  percent={cpuUsage}
                  summary={`Current ${formatFrequency(metrics?.cpuCurrentClockSpeedMegahertz)}`}
                  secondary={`Base ${formatFrequency(metrics?.cpuMaxClockSpeedMegahertz)} • ${formatWholeNumber(metrics?.cpuCoreCount)} cores`}
                  details={[
                    `${formatWholeNumber(metrics?.processCount)} processes`,
                    `System temperature ${formatDecimalValue(metrics?.systemTemperatureCelsius, '°C')}`,
                    `Fan speed ${formatRpm(metrics?.mainFanSpeedRpm)}`,
                  ]}
                  iconClassName={isCpuBelowBaseSpeed ? 'text-emerald-400' : 'text-muted-foreground'}
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

            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex items-center gap-2'>
                  <RefreshCcw className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Software update</CardTitle>
                    <CardDescription>Check for new releases and install updates from GitHub.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='space-y-4 pt-5'>
                <DetailTile label='Current commit' value={formatCommit(sourceRevisionId)} />
                <DetailTile label='Workflow' value={workflowRun} />
                {updateChecking && !updateCheck ? (
                  <div className='flex items-center justify-center py-6'>
                    <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
                  </div>
                ) : updateCheck ? (
                  <>
                    <DetailTile label='Installed release' value={updateCheck.currentReleaseTag ?? noDataLabel} />
                    <DetailTile label='Installed commit' value={formatCommit(updateCheck.currentSourceRevision)} />
                    {updateCheck.currentBuiltAt ? <DetailTile label='Built at' value={formatTimestamp(updateCheck.currentBuiltAt)} /> : null}
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
                        {updateCheck.remoteReleasePublishedAt ? (
                          <div className='mt-1 text-xs text-primary/80'>Built {formatTimestamp(updateCheck.remoteReleasePublishedAt)}</div>
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
                    ) : updateCheck.localChecksum && updateCheck.remoteChecksum ? (
                      <div className='rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center gap-2'>
                        <CheckCircle2 className='h-4 w-4' />
                        You are running the latest version.
                      </div>
                    ) : null}

                    {!updateCheck.canUpdate ? (
                      <div className='rounded-xl border border-border bg-muted/70 px-3 py-2 text-xs text-muted-foreground'>
                        {updateCheck.reason}
                      </div>
                    ) : null}

                    {updateProgress ? (
                      <div className={cn(
                        'rounded-xl border px-3 py-2 text-xs',
                        updateProgress.success === true ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                          : updateProgress.success === false ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                          : 'border-primary/20 bg-primary/10 text-primary'
                      )}>
                        <div className='flex items-center gap-2'>
                          {updateProgress.isRunning ? <LoaderCircle className='h-3.5 w-3.5 animate-spin shrink-0' /> : updateProgress.success ? <CheckCircle2 className='h-3.5 w-3.5 shrink-0' /> : <XCircle className='h-3.5 w-3.5 shrink-0' />}
                          {updateProgress.stage}
                        </div>
                        {updateProgress.isRunning && (
                          <div className='mt-1.5 text-primary/70'>
                            Do not turn off the device while the update is in progress.
                          </div>
                        )}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className='text-sm text-muted-foreground'>Unable to check for updates.</div>
                )}

                <div className='flex gap-2 pt-2'>
                  <button
                    type='button'
                    disabled={updateChecking}
                    onClick={() => void checkForUpdate()}
                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                  >
                    {updateChecking ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
                    Check for updates
                  </button>

                  {updateCheck?.canUpdate && updateCheck?.updateAvailable ? (
                    <button
                      type='button'
                      disabled={updateInstalling || (updateProgress?.isRunning ?? false)}
                      onClick={() => void installUpdate()}
                      className='inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
                    >
                      {updateInstalling || updateProgress?.isRunning ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Download className='h-4 w-4' />}
                      Install update
                    </button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className='space-y-6'>
            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex items-center gap-2'>
                  <Wifi className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Connectivity</CardTitle>
                    <CardDescription>Wi-Fi, Bluetooth, and Ethernet state on this device.</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className='space-y-4 pt-5'>
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
                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <div className='flex items-center gap-3 px-4 py-4'>
                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('wifi')}
                            className='flex min-w-0 flex-1 items-center gap-3 text-left'
                          >
                            <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                              <Wifi className='h-4 w-4 text-muted-foreground' />
                            </div>
                            <div className='min-w-0 flex-1'>
                              <div className='text-sm font-semibold text-foreground'>Wi-Fi</div>
                              <div className='mt-0.5 truncate text-xs text-muted-foreground'>{wifiSummary}</div>
                            </div>
                            <div className='flex items-center gap-2 pl-3 text-xs text-muted-foreground'>
                              <span>{wifiStatusLabel}</span>
                              {wifiSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
                            </div>
                          </button>

                          <div className='flex items-center gap-2'>
                            {wifiPowerLoading ? <LoaderCircle className='h-4 w-4 animate-spin text-primary' /> : null}
                            <Switch
                              checked={Boolean(connectivity?.network.supported) && wifiPowered !== false}
                              disabled={wifiPowerLoading || !(connectivity?.network.supported ?? false)}
                              onCheckedChange={() => void toggleWifiPower()}
                              aria-label='Toggle Wi-Fi power'
                            />
                          </div>
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

                                <div className='flex flex-col gap-3 rounded-2xl border border-border/70 bg-background/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between'>
                                  <div className='min-w-0'>
                                    <div className='text-sm font-semibold text-foreground font-mono'>{selectedWifiInterface.name}</div>
                                    <div className='mt-1 text-xs text-muted-foreground'>
                                      {selectedWifiInterface.connectedSsid
                                        ? `${selectedWifiInterface.connectedSsid} • ${formatWifiSignal(selectedWifiInterface.signalPercent, selectedWifiInterface.signalBars)}`
                                        : 'Not connected'}
                                    </div>
                                    {selectedWifiInterface.addresses.length > 0 ? (
                                      <div className='mt-1 break-all text-[11px] font-mono text-muted-foreground'>
                                        {selectedWifiInterface.addresses.join(' • ')}
                                      </div>
                                    ) : null}
                                  </div>

                                  <button
                                    type='button'
                                    disabled={wifiScanLoading === selectedWifiInterface.name}
                                    onClick={() => void scanWifi(selectedWifiInterface.name)}
                                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                                  >
                                    {wifiScanLoading === selectedWifiInterface.name ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
                                    Scan networks
                                  </button>
                                </div>

                                <div className='space-y-2'>
                                  <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Nearby networks</div>
                                  {selectedWifiAccessPoints.length > 0 ? (
                                    <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
                                      {selectedWifiAccessPoints.map((accessPoint, index) => (
                                        <button
                                          key={`${accessPoint.bssid ?? accessPoint.ssid}-${accessPoint.interfaceName}`}
                                          type='button'
                                          onClick={() => setWifiTargetSsid(accessPoint.ssid)}
                                          className={cn(
                                            'flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-background/70',
                                            index > 0 ? 'border-t border-border/60' : '',
                                            wifiTargetSsid === accessPoint.ssid ? 'bg-primary/8' : ''
                                          )}
                                        >
                                          <div className='min-w-0'>
                                            <div className='truncate text-sm font-medium text-foreground'>{accessPoint.ssid}</div>
                                            <div className='mt-1 text-xs text-muted-foreground'>
                                              {accessPoint.security ?? 'Open'}{accessPoint.isActive ? ' • Current network' : ''}
                                            </div>
                                          </div>
                                          <div className='shrink-0 text-xs text-muted-foreground'>
                                            {formatWifiSignal(accessPoint.signalPercent, accessPoint.signalBars)}
                                          </div>
                                        </button>
                                      ))}
                                    </div>
                                  ) : wifiScanLoading !== selectedWifiInterface.name ? (
                                    <div className='rounded-2xl border border-dashed border-border bg-background/30 px-4 py-3 text-xs text-muted-foreground'>
                                      No scan results yet. Click scan to refresh nearby networks.
                                    </div>
                                  ) : null}
                                </div>

                                <div className='space-y-2'>
                                  <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>Join network</div>
                                  <div className='grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]'>
                                    <Input
                                      value={wifiTargetSsid}
                                      onChange={(event) => setWifiTargetSsid(event.target.value)}
                                      placeholder='Network name'
                                    />
                                    <Input
                                      type='password'
                                      value={wifiPassword}
                                      onChange={(event) => setWifiPassword(event.target.value)}
                                      placeholder='Password (optional)'
                                    />
                                    <button
                                      type='button'
                                      disabled={wifiConnectLoading || !selectedWifiInterface}
                                      onClick={() => void connectWifi()}
                                      className='inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50'
                                    >
                                      {wifiConnectLoading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Wifi className='h-4 w-4' />}
                                      Connect
                                    </button>
                                  </div>
                                  <div className='text-xs text-muted-foreground'>
                                    Interface: <span className='font-mono text-foreground'>{selectedWifiInterface.name}</span>
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        ) : wifiFeedback ? (
                          <div className={cn(
                            'border-t border-border/60 px-4 py-3 text-xs',
                            wifiFeedback.isError ? 'text-rose-200' : 'text-emerald-200'
                          )}>
                            {wifiFeedback.message}
                          </div>
                        ) : null}
                      </div>

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <div className='flex items-center gap-3 px-4 py-4'>
                          <button
                            type='button'
                            onClick={() => void toggleConnectivitySection('bluetooth')}
                            className='flex min-w-0 flex-1 items-center gap-3 text-left'
                          >
                            <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                              <Bluetooth className='h-4 w-4 text-muted-foreground' />
                            </div>
                            <div className='min-w-0 flex-1'>
                              <div className='text-sm font-semibold text-foreground'>Bluetooth</div>
                              <div className='mt-0.5 truncate text-xs text-muted-foreground'>{bluetoothSummary}</div>
                            </div>
                            <div className='flex items-center gap-2 pl-3 text-xs text-muted-foreground'>
                              <span>{bluetoothStatusLabel}</span>
                              {connectivity?.bluetooth.powered ? (
                                bluetoothSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />
                              ) : null}
                            </div>
                          </button>

                          <div className='flex items-center gap-2'>
                            {bluetoothPowerLoading ? <LoaderCircle className='h-4 w-4 animate-spin text-primary' /> : null}
                            <Switch
                              checked={Boolean(connectivity?.bluetooth.supported) && Boolean(connectivity?.bluetooth.powered)}
                              disabled={bluetoothPowerLoading || !(connectivity?.bluetooth.supported ?? false)}
                              onCheckedChange={() => void toggleBluetoothPower()}
                              aria-label='Toggle Bluetooth power'
                            />
                          </div>
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
                                <div className='flex justify-end'>
                                  <button
                                    type='button'
                                    disabled={bluetoothScanLoading}
                                    onClick={() => void scanBluetooth()}
                                    className='inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-background/70 px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50'
                                  >
                                    {bluetoothScanLoading ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <RefreshCcw className='h-4 w-4' />}
                                    Scan
                                  </button>
                                </div>

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
                              </>
                            )}
                          </div>
                        ) : bluetoothFeedback ? (
                          <div className={cn(
                            'border-t border-border/60 px-4 py-3 text-xs',
                            bluetoothFeedback.isError ? 'text-rose-200' : 'text-emerald-200'
                          )}>
                            {bluetoothFeedback.message}
                          </div>
                        ) : null}
                      </div>

                      <div className='overflow-hidden rounded-[28px] border border-border/70 bg-background/35'>
                        <button
                          type='button'
                          onClick={() => void toggleConnectivitySection('ethernet')}
                          className='flex w-full items-center gap-3 px-4 py-4 text-left'
                        >
                          <div className='flex size-10 shrink-0 items-center justify-center rounded-2xl bg-muted/60'>
                            <Cable className='h-4 w-4 text-muted-foreground' />
                          </div>
                          <div className='min-w-0 flex-1'>
                            <div className='text-sm font-semibold text-foreground'>Ethernet</div>
                            <div className='mt-0.5 truncate text-xs text-muted-foreground'>{ethernetSummary}</div>
                          </div>
                          <div className='flex items-center gap-2 pl-3 text-xs text-muted-foreground'>
                            <span>{ethernetStatusLabel}</span>
                            {ethernetSectionOpen ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
                          </div>
                        </button>

                        {ethernetSectionOpen ? (
                          <div className='border-t border-border/60 px-4 py-4'>
                            {ethernetInterfaces.length > 0 ? (
                              <div className='overflow-hidden rounded-2xl border border-border/70 bg-background/20'>
                                {ethernetInterfaces.map((ethernetInterface, index) => (
                                  <div
                                    key={ethernetInterface.name}
                                    className={cn(
                                      'flex items-start justify-between gap-3 px-4 py-3',
                                      index > 0 ? 'border-t border-border/60' : ''
                                    )}
                                  >
                                    <div className='min-w-0'>
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
                                    <div className='shrink-0 text-xs text-muted-foreground'>
                                      {ethernetInterface.connectionState ?? ethernetInterface.status ?? 'Unknown'}
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
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex items-center gap-2'>
                  <Usb className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Hardware interfaces</CardTitle>
                    <CardDescription>Serial ports and block devices detected on this host.</CardDescription>
                  </div>
                </div>
              </CardHeader>
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
                            <div className='flex items-center justify-between'>
                              <div className='text-sm font-semibold text-foreground font-mono'>{dev.name}</div>
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

            <Card className='border border-border/80 bg-card/85 shadow-sm'>
              <CardHeader className='border-b border-border/60 pb-4'>
                <div className='flex items-center gap-2'>
                  <Database className='h-4 w-4 text-muted-foreground' />
                  <div>
                    <CardTitle>Database</CardTitle>
                    <CardDescription>TimescaleDB storage size, backup, and restore.</CardDescription>
                  </div>
                </div>
              </CardHeader>
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
                          <div className='flex items-center justify-between'>
                            <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground font-mono'>{t.tableName}</div>
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
        </div>
      ) : null}

      {/* Application Logs */}
      <LogsPanel />
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
  iconClassName,
}: {
  icon: typeof Cpu;
  label: string;
  percent: number | null;
  summary: string;
  secondary: string;
  details?: string[];
  iconClassName?: string;
}) {
  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <div className='flex items-center gap-2'>
            <Icon className={cn('h-4 w-4 shrink-0 text-muted-foreground', iconClassName)} />
            <div className='text-sm font-semibold text-foreground'>{label}</div>
          </div>
          <div className='text-sm text-muted-foreground'>{summary}</div>
        </div>
        <div className='shrink-0 text-sm font-semibold text-foreground'>{formatPercent(percent)}</div>
      </div>
      <div className='h-2 overflow-hidden rounded-full bg-muted'>
        <div className='h-full rounded-full bg-primary transition-[width] duration-500 ease-out' style={{ width: `${Math.max(percent ?? 0, 4)}%` }} />
      </div>
      <div className='space-y-1'>
        <div className='text-xs text-muted-foreground'>{secondary}</div>
        {details?.length ? (
          <div className='text-xs text-muted-foreground'>{details.join(' • ')}</div>
        ) : null}
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

function BluetoothDeviceCard({ device }: { device: BluetoothDeviceSnapshot }) {
  return (
    <div className='flex items-center justify-between gap-3 px-4 py-3'>
      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold text-foreground'>{device.displayName}</div>
        <div className='mt-1 text-[11px] font-mono text-muted-foreground'>{device.address}</div>
      </div>
      <div className='shrink-0 text-xs text-muted-foreground'>{formatBluetoothSignal(device.rssi)}</div>
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

function formatWifiSignal(signalPercent: number | null | undefined, signalBars: string | null | undefined) {
  if (signalPercent == null && !signalBars) {
    return noDataLabel;
  }

  if (signalPercent != null && signalBars) {
    return `${signalPercent}% • ${signalBars}`;
  }

  if (signalPercent != null) {
    return `${signalPercent}%`;
  }

  return signalBars ?? noDataLabel;
}

function formatBluetoothSignal(rssi: number | null | undefined) {
  if (rssi == null || !Number.isFinite(rssi)) {
    return 'Signal unavailable';
  }

  return `${Math.round(rssi)} dBm`;
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
