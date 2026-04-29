export type DeviceParameter = {
  key: string;
  displayName: string;
  category: string;
  numericValue?: number | null;
  stringValue?: string | null;
  booleanValue?: boolean | null;
  unit?: string | null;
  sortOrder: number;
  isWritable?: boolean;
  rawValue?: number | null;
  options?: { value: number; label: string }[] | null;
  displayFormatter?: string | null;
  displayPrecision?: number | null;
};

export type ParameterWriteResult = {
  success: boolean;
  message: string;
};

export type BatchWriteResponse = {
  success?: boolean;
  results?: {
    parameterKey?: string;
    success?: boolean;
    writtenValue?: number;
    readBackValue?: number;
    error?: string | null;
  }[];
  message?: string;
};

export type CellVoltageSnapshot = {
  index: number;
  voltageVolts: number;
};

export type DeviceTelemetrySnapshot = {
  collectedAt: string;
  cellCount?: number | null;
  totalVoltageVolts?: number | null;
  currentAmps?: number | null;
  powerWatts?: number | null;
  stateOfChargePercent?: number | null;
  minCellVoltageVolts?: number | null;
  maxCellVoltageVolts?: number | null;
  averageCellVoltageVolts?: number | null;
  deltaCellVoltageVolts?: number | null;
  mosTemperatureCelsius?: number | null;
  ambientTemperatureCelsius?: number | null;
  batteryTemperatureCelsius?: number | null;
  cycleCount?: number | null;
  warningFlags?: number | null;
  statusFlags?: number | null;
  protocolVersion?: number | null;
  softwareVersion?: string | null;
  manufacturerId?: string | null;
  chargingEnabled?: boolean | null;
  dischargingEnabled?: boolean | null;
  balancingEnabled?: boolean | null;
  batteryOnline?: boolean | null;
  cells: CellVoltageSnapshot[];
  activeWarnings: string[];
  parameters: DeviceParameter[];
  numericValues?: Record<string, number | null>;
};

export type DisplayPrecision = {
  voltage: number;
  cellVoltage: number;
  current: number;
  power: number;
  temperature: number;
  soc: number;
  deltaVoltage: number;
};

export type DeviceRuntimeState = {
  deviceId: string;
  displayName: string;
  sortOrder?: number;
  definitionId: string;
  protocolHandler?: string | null;
  address?: number | null;
  enabled: boolean;
  isMaster: boolean;
  pollIntervalMilliseconds: number;
  lastPollStartedAt?: string | null;
  lastPollCompletedAt?: string | null;
  lastOutcome: string;
  lastError?: string | null;
  lastPersistedAt?: string | null;
  displayPrecision?: DisplayPrecision | null;
  temperatureUnit?: string | null;
  latestTelemetry?: DeviceTelemetrySnapshot | null;
};

export type DeviceRuntimeStateStreamEnvelope = {
  devices: DeviceRuntimeState[];
};
