import { startTransition, useEffect, useMemo, useState } from "react"
import {
  Activity,
  Cable,
  CircleAlert,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  LoaderCircle,
  PlugZap,
  RefreshCw,
  Save,
  Server,
  Thermometer,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type StartupMode = "Simulator" | "Hardware"

type SetupStateResponse = {
  currentStartupMode: StartupMode
  environmentName: string
  useDatabase: boolean
  connectionString?: string | null
  serialPort?: string | null
  serialPorts: string[]
  canAutoRestart: boolean
  applyMessage: string
}

type ApplySetupResponse = {
  startupMode: StartupMode
  restartScheduled: boolean
  message: string
}

type DeviceTelemetrySnapshot = {
  collectedAt: string
  cellCount?: number | null
  totalVoltageVolts?: number | null
  currentAmps?: number | null
  powerWatts?: number | null
  stateOfChargePercent?: number | null
  minCellVoltageVolts?: number | null
  maxCellVoltageVolts?: number | null
  averageCellVoltageVolts?: number | null
  deltaCellVoltageVolts?: number | null
  mosTemperatureCelsius?: number | null
  ambientTemperatureCelsius?: number | null
  batteryTemperatureCelsius?: number | null
  cycleCount?: number | null
  warningFlags?: number | null
  statusFlags?: number | null
  protocolVersion?: number | null
  softwareVersion?: string | null
  manufacturerId?: string | null
  chargingEnabled?: boolean | null
  dischargingEnabled?: boolean | null
  balancingEnabled?: boolean | null
  batteryOnline?: boolean | null
  activeWarnings: string[]
}

type DeviceRuntimeState = {
  deviceId: string
  displayName: string
  protocol: string
  enabled: boolean
  isMaster: boolean
  pollIntervalMilliseconds: number
  lastPollStartedAt?: string | null
  lastPollCompletedAt?: string | null
  lastOutcome: string
  lastError?: string | null
  lastPersistedAt?: string | null
  latestTelemetry?: DeviceTelemetrySnapshot | null
}

type MonitorRuntimeStatus = {
  serviceName: string
  environmentName: string
  startupMode: StartupMode
  startedAt: string
  reportedAt: string
  configuredDeviceCount: number
  enabledDeviceCount: number
  systemMetrics?: {
    cpuUtilizationPercent?: number | null
    memoryAvailableBytes?: number | null
    memoryTotalBytes?: number | null
    systemTemperatureCelsius?: number | null
  } | null
  devices: DeviceRuntimeState[]
}

type SetupFormState = {
  startupMode: StartupMode
  useDatabase: boolean
  connectionString: string
  serialPort: string
}

const dashboardRefreshIntervalMilliseconds = 5000
const healthRefreshIntervalMilliseconds = 1000

function getPortRefreshStatus(portCount: number) {
  return portCount === 1 ? "Detected 1 serial port" : `Detected ${portCount} serial ports`
}

const modeCards: Array<{
  mode: StartupMode
  title: string
  description: string
}> = [
  {
    mode: "Simulator",
    title: "Simulator",
    description: "Boot the UI immediately with sample telemetry while you finish wiring and storage setup.",
  },
  {
    mode: "Hardware",
    title: "Hardware",
    description: "Use the live RS485 link, detect ports on the machine running JK Monitor, and talk to the real rack.",
  },
]

function App() {
  const [health, setHealth] = useState<MonitorRuntimeStatus | null>(null)
  const [devices, setDevices] = useState<DeviceRuntimeState[]>([])
  const [setupState, setSetupState] = useState<SetupStateResponse | null>(null)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [setupStatus, setSetupStatus] = useState("Loading current configuration")
  const [setupFeedback, setSetupFeedback] = useState("Preparing setup guidance.")
  const [isDashboardLoading, setIsDashboardLoading] = useState(true)
  const [isSetupLoading, setIsSetupLoading] = useState(true)
  const [isApplying, setIsApplying] = useState(false)
  const [isRefreshingPorts, setIsRefreshingPorts] = useState(false)
  const [form, setForm] = useState<SetupFormState>({
    startupMode: "Simulator",
    useDatabase: false,
    connectionString: "",
    serialPort: "",
  })

  useEffect(() => {
    void refreshDashboard()
    void loadSetupState()

    const healthTimer = window.setInterval(() => {
      void refreshHealth()
    }, healthRefreshIntervalMilliseconds)

    const dashboardTimer = window.setInterval(() => {
      void refreshDashboard({ silent: true })
    }, dashboardRefreshIntervalMilliseconds)

    return () => {
      window.clearInterval(healthTimer)
      window.clearInterval(dashboardTimer)
    }
  }, [])

  const detectedPorts = setupState?.serialPorts ?? []
  const warningCount = useMemo(
    () => devices.reduce((count, device) => count + (device.latestTelemetry?.activeWarnings.length ?? 0), 0),
    [devices],
  )
  const onlineCount = useMemo(
    () => devices.filter((device) => device.lastOutcome.toLowerCase() !== "failed").length,
    [devices],
  )
  const persistedCount = useMemo(
    () => devices.filter((device) => !!device.lastPersistedAt).length,
    [devices],
  )

  async function refreshDashboard(options?: { silent?: boolean }) {
    if (!options?.silent) {
      setIsDashboardLoading(true)
    }

    try {
      const [nextHealth, nextDevices] = await Promise.all([fetchHealth(), fetchDevices()])

      startTransition(() => {
        setHealth(nextHealth)
        setDevices(nextDevices)
        setDashboardError(null)
      })
    } catch (error) {
      setDashboardError(toMessage(error))
    } finally {
      setIsDashboardLoading(false)
    }
  }

  async function refreshHealth() {
    try {
      const nextHealth = await fetchHealth()

      startTransition(() => {
        setHealth(nextHealth)
      })
    } catch {
    }
  }

  async function fetchHealth() {
    const response = await fetch("/api/health", { cache: "no-store" })

    if (!response.ok) {
      throw new Error(`Health request failed (${response.status}).`)
    }

    return (await response.json()) as MonitorRuntimeStatus
  }

  async function fetchDevices() {
    const response = await fetch("/api/devices/current", { cache: "no-store" })

    if (!response.ok) {
      throw new Error(`Device request failed (${response.status}).`)
    }

    return (await response.json()) as DeviceRuntimeState[]
  }

  async function loadSetupState(options?: { isPortRefresh?: boolean }) {
    setSetupStatus(options?.isPortRefresh ? "Refreshing serial ports" : "Loading current configuration")
    setSetupError(null)

    if (!setupState) {
      setIsSetupLoading(true)
    }

    if (options?.isPortRefresh) {
      setIsRefreshingPorts(true)
    }

    try {
      const response = await fetch("/api/setup", { cache: "no-store" })

      if (!response.ok) {
        throw new Error(`Setup request failed (${response.status}).`)
      }

      const payload = (await response.json()) as SetupStateResponse

      startTransition(() => {
        setSetupState(payload)
        setSetupFeedback(payload.applyMessage)

        if (options?.isPortRefresh) {
          setSetupStatus(getPortRefreshStatus(payload.serialPorts.length))
          return
        }

        setSetupStatus(`Current mode: ${payload.currentStartupMode}`)
        setForm({
          startupMode: payload.currentStartupMode,
          useDatabase: payload.useDatabase,
          connectionString: payload.connectionString ?? "",
          serialPort: payload.serialPort ?? "",
        })
      })
    } catch (error) {
      setSetupError(toMessage(error))
      setSetupStatus("Setup unavailable")
    } finally {
      setIsSetupLoading(false)
      setIsRefreshingPorts(false)
    }
  }

  async function handleApply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const serialPort = form.serialPort.trim()
    const connectionString = form.connectionString.trim()

    if (form.startupMode === "Hardware" && !serialPort) {
      setSetupError("Choose or type a serial port before switching to hardware mode.")
      return
    }

    if (form.useDatabase && !connectionString) {
      setSetupError("Enter a PostgreSQL connection string before enabling database storage.")
      return
    }

    setIsApplying(true)
    setSetupError(null)
    setSetupStatus("Saving configuration")
    setSetupFeedback("Applying your settings on the machine running JK Monitor.")

    try {
      const response = await fetch("/api/setup/apply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startupMode: form.startupMode,
          useDatabase: form.useDatabase,
          connectionString,
          serialPort,
          restartApplication: true,
        }),
      })

      const payload = (await response.json()) as ApplySetupResponse | { message?: string }

      if (!response.ok) {
        throw new Error(("message" in payload ? payload.message : undefined) ?? `Setup apply failed (${response.status}).`)
      }

      const successPayload = payload as ApplySetupResponse

      setSetupStatus(successPayload.restartScheduled ? "Restarting JK Monitor" : "Configuration saved")
      setSetupFeedback(successPayload.message)

      if (successPayload.restartScheduled) {
        await waitForRestart()
        await Promise.all([refreshDashboard(), loadSetupState()])
        setSetupFeedback(`${successPayload.message} The app is back online.`)
      } else {
        await loadSetupState()
      }
    } catch (error) {
      setSetupError(toMessage(error))
      setSetupStatus("Setup update failed")
    } finally {
      setIsApplying(false)
    }
  }

  const serviceLabel = health
    ? `${health.serviceName} · ${health.environmentName}`
    : "Connecting to backend"

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,184,77,0.24),_transparent_28%),radial-gradient(circle_at_80%_18%,_rgba(228,101,37,0.18),_transparent_24%),linear-gradient(160deg,_rgba(255,246,231,0.96),_rgba(247,238,225,0.98)_45%,_rgba(240,228,214,1))]" />
      <div className="pointer-events-none absolute inset-0 opacity-45 [background-image:linear-gradient(rgba(70,49,24,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(70,49,24,0.05)_1px,transparent_1px)] [background-size:36px_36px]" />

      <main className="relative mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <header className="grid gap-5 overflow-hidden rounded-[2rem] border border-amber-900/10 bg-[linear-gradient(135deg,rgba(44,31,16,0.96),rgba(96,52,22,0.94)_58%,rgba(160,84,36,0.9))] p-6 text-stone-50 shadow-[0_32px_90px_rgba(89,49,22,0.22)] animate-in fade-in duration-500 md:grid-cols-[1.6fr_1fr] md:p-8">
          <div className="space-y-4">
            <Badge className="bg-white/14 text-white ring-1 ring-white/18" variant="secondary">
              Local JK BMS control room
            </Badge>
            <div className="space-y-3">
              <h1 className="font-heading text-4xl leading-none tracking-[-0.04em] sm:text-5xl lg:text-6xl">
                Setup, port discovery, and live rack health in one screen.
              </h1>
              <p className="max-w-3xl text-base leading-7 text-stone-200 sm:text-lg">
                Pick the startup mode, confirm which serial ports the backend can actually see, and watch device telemetry without guessing what state the service is in.
              </p>
            </div>
          </div>

          <div className="grid gap-3 self-end rounded-[1.5rem] border border-white/12 bg-white/8 p-4 backdrop-blur md:justify-self-end">
            <StatusRow
              icon={<Server className="size-4" />}
              label="Service"
              value={serviceLabel}
            />
            <StatusRow
              icon={<PlugZap className="size-4" />}
              label="Mode"
              value={health?.startupMode ?? form.startupMode}
            />
            <StatusRow
              icon={<RefreshCw className="size-4" />}
              label="Last refresh"
              value={health ? formatDateTime(health.reportedAt) : "Waiting for first refresh"}
            />
          </div>
        </header>

        {dashboardError ? (
          <Alert className="border-amber-800/20 bg-amber-50/90 shadow-sm">
            <CircleAlert className="size-4" />
            <AlertTitle>Live API unavailable</AlertTitle>
            <AlertDescription>{dashboardError}</AlertDescription>
          </Alert>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[1.45fr_1fr]">
          <Card className="border-stone-900/8 bg-white/80 shadow-[0_24px_60px_rgba(84,54,25,0.12)] backdrop-blur">
            <CardHeader className="gap-4 border-b border-stone-900/8 pb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-xl text-stone-950">Setup</CardTitle>
                  <CardDescription className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
                    Configure how JK Monitor starts, which machine-side serial port it should use, and whether database persistence is enabled.
                  </CardDescription>
                </div>
                <Badge variant="outline" className="border-stone-900/10 bg-stone-100/80 text-stone-700">
                  {setupStatus}
                </Badge>
              </div>
            </CardHeader>

            <form onSubmit={handleApply}>
              <CardContent className="grid gap-6 py-6">
                <div className="grid gap-3 md:grid-cols-2">
                  {modeCards.map((item) => {
                    const active = form.startupMode === item.mode

                    return (
                      <button
                        key={item.mode}
                        type="button"
                        onClick={() => setForm((current) => ({ ...current, startupMode: item.mode }))}
                        className={cn(
                          "rounded-[1.5rem] border p-4 text-left transition-all duration-200",
                          active
                            ? "border-orange-500/40 bg-[linear-gradient(135deg,rgba(255,243,227,1),rgba(255,228,194,0.88))] shadow-[0_14px_30px_rgba(229,118,38,0.12)]"
                            : "border-stone-900/8 bg-stone-50/80 hover:border-orange-500/25 hover:bg-white",
                        )}
                      >
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <Badge variant={active ? "default" : "outline"}>{item.title}</Badge>
                          <span
                            className={cn(
                              "size-4 rounded-full border transition-all",
                              active ? "border-orange-600 bg-orange-600 ring-4 ring-orange-200" : "border-stone-300 bg-white",
                            )}
                          />
                        </div>
                        <p className="text-sm leading-6 text-stone-700">{item.description}</p>
                      </button>
                    )
                  })}
                </div>

                {form.startupMode === "Hardware" ? (
                  <div className="grid gap-4 rounded-[1.75rem] border border-stone-900/8 bg-[linear-gradient(180deg,rgba(255,252,247,0.98),rgba(247,239,228,0.96))] p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="font-heading text-lg text-stone-950">Serial port selection</h2>
                        <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
                          These ports are detected on the machine running JK Monitor. In local development that means your PC; on a deployed box it means the device itself.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void loadSetupState({ isPortRefresh: true })}
                        disabled={isRefreshingPorts || isApplying}
                        className="h-10 rounded-full border-stone-900/10 bg-white/70 px-4 text-stone-800"
                      >
                        {isRefreshingPorts ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                        Refresh ports
                      </Button>
                    </div>

                    {detectedPorts.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {detectedPorts.map((port) => {
                          const active = form.serialPort.trim() === port

                          return (
                            <Button
                              key={port}
                              type="button"
                              variant={active ? "default" : "outline"}
                              onClick={() => setForm((current) => ({ ...current, serialPort: port }))}
                              className={cn(
                                "h-10 rounded-full px-4",
                                active
                                  ? "bg-stone-950 text-white hover:bg-stone-800"
                                  : "border-stone-900/10 bg-white/75 text-stone-800 hover:bg-white",
                              )}
                            >
                              <Cable className="size-4" />
                              {port}
                            </Button>
                          )
                        })}
                      </div>
                    ) : (
                      <Alert className="border-amber-900/10 bg-amber-50/85">
                        <HardDrive className="size-4" />
                        <AlertTitle>No ports detected yet</AlertTitle>
                        <AlertDescription>
                          Refresh after plugging the adapter in. If the port still does not appear, you can type it manually below using a value like COM3 or /dev/ttyUSB0.
                        </AlertDescription>
                      </Alert>
                    )}

                    <div className="grid gap-2">
                      <label className="text-sm font-medium text-stone-800" htmlFor="serial-port-input">
                        Manual serial port
                      </label>
                      <Input
                        id="serial-port-input"
                        value={form.serialPort}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            serialPort: event.currentTarget.value,
                          }))
                        }
                        placeholder="COM3 or /dev/ttyUSB0"
                        className="h-11 rounded-2xl border-stone-900/10 bg-white/90 px-4 text-stone-900 placeholder:text-stone-400"
                      />
                      <p className="text-sm text-stone-500">
                        Current detected count: {detectedPorts.length}. {form.serialPort.trim() ? `Selected port: ${form.serialPort.trim()}.` : "No port selected yet."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <Alert className="border-emerald-900/10 bg-emerald-50/80">
                    <Activity className="size-4" />
                    <AlertTitle>Simulator mode starts immediately</AlertTitle>
                    <AlertDescription>
                      JK Monitor will boot with simulated telemetry so you can validate the dashboard and storage settings before connecting RS485 hardware.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid gap-4 rounded-[1.75rem] border border-stone-900/8 bg-stone-50/80 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="font-heading text-lg text-stone-950">Storage</h2>
                      <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-600">
                        Enable PostgreSQL and TimescaleDB when you want retention beyond the live view.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          useDatabase: !current.useDatabase,
                        }))
                      }
                      className={cn(
                        "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-sm font-medium transition-colors",
                        form.useDatabase
                          ? "border-emerald-700/20 bg-emerald-600 text-white"
                          : "border-stone-900/10 bg-white text-stone-700",
                      )}
                    >
                      <Database className="size-4" />
                      {form.useDatabase ? "Persistence enabled" : "Persistence disabled"}
                    </button>
                  </div>

                  <div className="grid gap-2">
                    <label className="text-sm font-medium text-stone-800" htmlFor="connection-string-input">
                      PostgreSQL connection string
                    </label>
                    <Input
                      id="connection-string-input"
                      value={form.connectionString}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          connectionString: event.currentTarget.value,
                        }))
                      }
                      disabled={!form.useDatabase}
                      placeholder="Host=localhost;Port=5432;Database=jkmonitor;Username=jkmonitor;Password=change-me"
                      className="h-11 rounded-2xl border-stone-900/10 bg-white/90 px-4 text-stone-900 placeholder:text-stone-400 disabled:opacity-60"
                    />
                    <p className="text-sm text-stone-500">
                      Leave persistence off for a preview-only install. Turn it on when TimescaleDB is ready.
                    </p>
                  </div>
                </div>

                {setupError ? (
                  <Alert variant="destructive" className="border-red-900/10 bg-red-50/90 text-red-700">
                    <CircleAlert className="size-4" />
                    <AlertTitle>Setup action failed</AlertTitle>
                    <AlertDescription>{setupError}</AlertDescription>
                  </Alert>
                ) : null}

                <Alert className="border-stone-900/8 bg-white/75">
                  <Server className="size-4" />
                  <AlertTitle>Current backend guidance</AlertTitle>
                  <AlertDescription>{setupFeedback}</AlertDescription>
                </Alert>
              </CardContent>

              <CardFooter className="flex flex-col items-start justify-between gap-3 border-t border-stone-900/8 bg-stone-100/70 sm:flex-row sm:items-center">
                <p className="text-sm leading-6 text-stone-600">
                  {setupState?.canAutoRestart
                    ? "Applying the setup restarts JK Monitor automatically when needed."
                    : "Applying the setup saves the configuration, but you will need to restart the app manually."}
                </p>
                <Button
                  type="submit"
                  disabled={isApplying || isSetupLoading}
                  className="h-11 rounded-full bg-stone-950 px-5 text-white hover:bg-stone-800"
                >
                  {isApplying ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
                  Apply configuration
                </Button>
              </CardFooter>
            </form>
          </Card>

          <div className="grid gap-6">
            <Card className="border-stone-900/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.9),rgba(247,241,235,0.96))] shadow-[0_20px_48px_rgba(84,54,25,0.12)]">
              <CardHeader>
                <CardTitle className="text-xl text-stone-950">Overview</CardTitle>
                <CardDescription className="text-sm leading-6 text-stone-600">
                  Live service state from the current backend endpoints.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <StatTile icon={<PlugZap className="size-4" />} label="Startup mode" value={health?.startupMode ?? form.startupMode} />
                <StatTile icon={<Cpu className="size-4" />} label="Configured devices" value={String(health?.configuredDeviceCount ?? devices.length)} />
                <StatTile icon={<Activity className="size-4" />} label="Polling ok" value={String(onlineCount)} />
                <StatTile icon={<Database className="size-4" />} label="Persisted" value={String(persistedCount)} />
                <StatTile icon={<CircleAlert className="size-4" />} label="Warnings" value={String(warningCount)} />
                <StatTile icon={<Gauge className="size-4" />} label="Environment" value={health?.environmentName ?? setupState?.environmentName ?? "Unknown"} />
              </CardContent>
            </Card>

            <Card className="border-stone-900/8 bg-[linear-gradient(180deg,rgba(255,252,247,0.98),rgba(247,239,228,0.96))] shadow-[0_20px_48px_rgba(84,54,25,0.12)]">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-xl text-stone-950">System Monitoring</CardTitle>
                    <CardDescription className="text-sm leading-6 text-stone-600">
                      Host CPU, memory, and thermal data from the machine running JK Monitor.
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="border-stone-900/10 bg-stone-100/80 text-stone-700">
                    1s refresh
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <StatTile
                  icon={<Cpu className="size-4" />}
                  label="CPU utilization"
                  value={formatPercentValue(health?.systemMetrics?.cpuUtilizationPercent)}
                />
                <StatTile
                  icon={<HardDrive className="size-4" />}
                  label="Memory available"
                  value={formatBytesValue(health?.systemMetrics?.memoryAvailableBytes)}
                />
                <StatTile
                  icon={<Database className="size-4" />}
                  label="Memory total"
                  value={formatBytesValue(health?.systemMetrics?.memoryTotalBytes)}
                />
                <StatTile
                  icon={<Thermometer className="size-4" />}
                  label="System temp"
                  value={formatCelsiusValue(health?.systemMetrics?.systemTemperatureCelsius)}
                />
              </CardContent>
            </Card>

            <Card className="border-stone-900/8 bg-white/80 shadow-[0_20px_48px_rgba(84,54,25,0.12)]">
              <CardHeader>
                <CardTitle className="text-xl text-stone-950">Port discovery</CardTitle>
                <CardDescription className="text-sm leading-6 text-stone-600">
                  What the backend can see right now, independent of what is typed into the form.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {detectedPorts.length > 0 ? (
                    detectedPorts.map((port) => (
                      <Badge key={port} variant="outline" className="h-8 rounded-full border-stone-900/10 bg-stone-50 px-3 text-sm text-stone-700">
                        {port}
                      </Badge>
                    ))
                  ) : (
                    <p className="text-sm leading-6 text-stone-500">
                      No port names were returned by the backend yet.
                    </p>
                  )}
                </div>
                <div className="rounded-[1.25rem] border border-dashed border-stone-900/10 bg-stone-50/80 p-4 text-sm leading-6 text-stone-600">
                  Detection is machine-scoped. If you plugged a USB serial adapter into the Windows box running JK Monitor, it should appear here as a COM port after refresh.
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3 px-1">
            <div>
              <h2 className="font-heading text-2xl text-stone-950">Devices</h2>
              <p className="mt-1 text-sm leading-6 text-stone-600">
                Live rack telemetry, poll state, and warning visibility in one pass.
              </p>
            </div>
            <Badge variant="outline" className="h-8 rounded-full border-stone-900/10 bg-white/70 px-3 text-sm text-stone-700">
              {devices.length} device{devices.length === 1 ? "" : "s"}
            </Badge>
          </div>

          {isDashboardLoading && devices.length === 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {Array.from({ length: 2 }).map((_, index) => (
                <Card key={index} className="border-stone-900/8 bg-white/70">
                  <CardHeader>
                    <div className="h-6 w-40 rounded-full bg-stone-200/80" />
                    <div className="h-4 w-56 rounded-full bg-stone-200/60" />
                  </CardHeader>
                  <CardContent className="grid gap-3 sm:grid-cols-2">
                    {Array.from({ length: 4 }).map((__, metricIndex) => (
                      <div key={metricIndex} className="h-20 rounded-[1.25rem] bg-stone-200/60" />
                    ))}
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : devices.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {devices.map((device) => (
                <DeviceCard key={device.deviceId} device={device} />
              ))}
            </div>
          ) : (
            <Alert className="border-stone-900/8 bg-white/75">
              <Cpu className="size-4" />
              <AlertTitle>No devices have reported yet</AlertTitle>
              <AlertDescription>
                The backend is running, but no device telemetry is available yet. Switch to simulator mode for instant sample data or confirm the RS485 port and hardware wiring.
              </AlertDescription>
            </Alert>
          )}
        </section>
      </main>
    </div>
  )
}

function StatusRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-black/10 px-3 py-3">
      <div className="mt-0.5 text-stone-200">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-[0.18em] text-stone-300">{label}</p>
        <p className="truncate text-sm font-medium text-white">{value}</p>
      </div>
    </div>
  )
}

function StatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-[1.4rem] border border-stone-900/8 bg-white/85 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
      <div className="mb-3 flex items-center gap-2 text-stone-500">{icon}</div>
      <p className="text-sm text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-stone-950">{value}</p>
    </div>
  )
}

function DeviceCard({ device }: { device: DeviceRuntimeState }) {
  const telemetry = device.latestTelemetry
  const outcomeVariant = getOutcomeVariant(device.lastOutcome)
  const metricPairs = [
    {
      label: "Pack voltage",
      value: formatMetricValue(telemetry?.totalVoltageVolts, "volts", 2),
      icon: <Gauge className="size-4" />,
    },
    {
      label: "Current",
      value: formatMetricValue(telemetry?.currentAmps, "amps", 2),
      icon: <Activity className="size-4" />,
    },
    {
      label: "Power",
      value: formatMetricValue(telemetry?.powerWatts, "watts", 1),
      icon: <PlugZap className="size-4" />,
    },
    {
      label: "SOC",
      value: formatMetricValue(telemetry?.stateOfChargePercent, "percent", 0),
      icon: <Database className="size-4" />,
    },
    {
      label: "Cell delta",
      value: formatMetricValue(telemetry?.deltaCellVoltageVolts, "millivolts", 0),
      icon: <Cable className="size-4" />,
    },
    {
      label: "MOS temp",
      value: formatMetricValue(telemetry?.mosTemperatureCelsius, "celsius", 0),
      icon: <Thermometer className="size-4" />,
    },
  ]

  return (
    <Card className="border-stone-900/8 bg-white/80 shadow-[0_18px_44px_rgba(84,54,25,0.12)] backdrop-blur animate-in fade-in slide-in-from-bottom-3 duration-500">
      <CardHeader className="border-b border-stone-900/8 pb-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-xl text-stone-950">{device.displayName}</CardTitle>
            <CardDescription className="mt-1 text-sm leading-6 text-stone-600">
              {device.deviceId} · {device.protocol} · {device.pollIntervalMilliseconds} ms
            </CardDescription>
          </div>
          <Badge variant={outcomeVariant}>{device.lastOutcome}</Badge>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Badge variant={device.enabled ? "secondary" : "outline"}>{device.enabled ? "Enabled" : "Disabled"}</Badge>
          {device.isMaster ? <Badge variant="outline">Master</Badge> : null}
          {telemetry?.batteryOnline ? <Badge variant="secondary">Battery online</Badge> : null}
          {telemetry?.chargingEnabled ? <Badge variant="secondary">Charging</Badge> : null}
          {telemetry?.dischargingEnabled ? <Badge variant="secondary">Discharging</Badge> : null}
          {telemetry?.balancingEnabled ? <Badge variant="secondary">Balancing</Badge> : null}
        </div>
      </CardHeader>

      <CardContent className="grid gap-3 py-5 sm:grid-cols-2 xl:grid-cols-3">
        {metricPairs.map((metric) => (
          <div key={metric.label} className="rounded-[1.35rem] border border-stone-900/8 bg-stone-50/85 p-4">
            <div className="mb-3 flex items-center gap-2 text-stone-500">{metric.icon}</div>
            <p className="text-sm text-stone-500">{metric.label}</p>
            <p className="mt-1 text-xl font-semibold tracking-[-0.03em] text-stone-950">{metric.value}</p>
          </div>
        ))}

        <div className="rounded-[1.35rem] border border-stone-900/8 bg-stone-50/85 p-4 sm:col-span-2 xl:col-span-3">
          <div className="flex flex-wrap gap-2">
            {telemetry?.activeWarnings.length ? (
              telemetry.activeWarnings.map((warning) => (
                <Badge key={warning} variant="destructive" className="h-7 rounded-full px-3 text-xs">
                  {warning}
                </Badge>
              ))
            ) : (
              <Badge variant="outline" className="h-7 rounded-full px-3 text-xs text-stone-600">
                No active warnings
              </Badge>
            )}
          </div>

          {device.lastError ? (
            <p className="mt-4 text-sm leading-6 text-red-700">Last error: {device.lastError}</p>
          ) : null}

          <div className="mt-4 grid gap-2 text-sm text-stone-500 sm:grid-cols-2">
            <p>Collected: {telemetry ? formatDateTime(telemetry.collectedAt) : "No telemetry yet"}</p>
            <p>Last persisted: {device.lastPersistedAt ? formatDateTime(device.lastPersistedAt) : "Not persisted yet"}</p>
            <p>Poll started: {device.lastPollStartedAt ? formatDateTime(device.lastPollStartedAt) : "Not started"}</p>
            <p>Poll completed: {device.lastPollCompletedAt ? formatDateTime(device.lastPollCompletedAt) : "Not completed"}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

async function waitForRestart() {
  await delay(1500)

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch("/api/health", { cache: "no-store" })

      if (response.ok) {
        return
      }
    } catch {
    }

    await delay(1000)
  }

  throw new Error("The app did not come back online in time after restarting.")
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds)
  })
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString()
}

function formatPercentValue(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "Sampling"
  }

  return `${value.toFixed(1)}%`
}

function formatBytesValue(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "Unavailable"
  }

  const gibibytes = value / (1024 ** 3)
  return `${gibibytes.toFixed(2)} GiB`
}

function formatCelsiusValue(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "Unavailable"
  }

  return `${value.toFixed(1)} C`
}

function formatMetricValue(
  value: number | null | undefined,
  unit: "volts" | "amps" | "watts" | "percent" | "millivolts" | "celsius",
  fractionDigits: number,
) {
  if (value === null || value === undefined) {
    return "-"
  }

  switch (unit) {
    case "volts":
      return `${value.toFixed(fractionDigits)} V`
    case "amps":
      return `${value.toFixed(fractionDigits)} A`
    case "watts":
      return `${value.toFixed(fractionDigits)} W`
    case "percent":
      return `${value.toFixed(fractionDigits)}%`
    case "millivolts":
      return `${(value * 1000).toFixed(fractionDigits)} mV`
    case "celsius":
      return `${value.toFixed(fractionDigits)} C`
  }
}

function getOutcomeVariant(outcome: string): "default" | "secondary" | "destructive" | "outline" {
  switch (outcome.toLowerCase()) {
    case "failed":
      return "destructive"
    case "success":
      return "secondary"
    case "running":
      return "default"
    default:
      return "outline"
  }
}

function toMessage(error: unknown) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return "An unexpected error occurred."
}

export default App
