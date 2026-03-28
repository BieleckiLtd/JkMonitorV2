/** TypeScript types mirroring the backend DeviceDefinition JSON schema. */

export type DeviceDefinition = {
  version: string;
  device: DeviceMetadata;
  connection: ConnectionDefinition;
  dataSources: DataSourceDefinition[];
  pollGroups: Record<string, PollGroupDefinition>;
  entities: EntityDefinition[];
  computedEntities?: ComputedEntityDefinition[];
  alarms?: AlarmDefinition;
  storage?: StorageDefinition;
  ui?: UiDefinition;
  notifications?: NotificationDefinition;
};

export type DeviceMetadata = {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  category: string;
  description?: string;
  icon?: string;
  documentationUrl?: string;
};

export type ConnectionDefinition = {
  transport: TransportDefinition;
  protocol: ProtocolDefinition;
};

export type TransportDefinition = {
  type: string;
  defaults: TransportDefaults;
};

export type TransportDefaults = {
  // Serial transport
  baudRate?: number;
  dataBits?: number;
  parity?: string;
  stopBits?: number;
  readTimeoutMs?: number;
  writeTimeoutMs?: number;
  // BLE transport
  serviceUuid?: string;
  notifyCharacteristicUuid?: string;
  writeCharacteristicUuid?: string;
  connectionTimeoutMs?: number;
  reconnectDelayMs?: number;
};

export type ProtocolDefinition = {
  type: string;
  settings: ProtocolSettings;
};

export type ProtocolSettings = {
  // Modbus
  defaultSlaveAddress?: number;
  interFrameDelayMs?: number;
  retries?: number;
  // Universal
  byteOrder?: 'big-endian' | 'little-endian';
  responseFrameSize?: number;
  checksumType?: string;
};

export type DataSourceDefinition = {
  id: string;
  name: string;
  pollGroup: string;
  // Modbus
  address?: number;
  count?: number;
  functionCode?: number;
  write?: DataSourceWriteDefinition;
  // BLE frame protocol
  command?: number;
  responseFrameType?: number;
  headerSize?: number;
};

export type DataSourceWriteDefinition = {
  type?: string;
  functionCode?: number;
  registersPerWrite?: number;
  addressBase?: number;
  addressStepBytes?: number;
  valueLength?: number;
};

export type PollGroupDefinition = {
  intervalMs: number;
  description?: string;
};

export type EntityDefinition = {
  id: string;
  type: string;
  name: string;
  category: string;
  source: EntitySourceDefinition;
  write?: EntityWriteDefinition;
  display?: EntityDisplayDefinition;
  roles?: string[];
};

export type EntityWriteDefinition = {
  address?: number;
  valueLength?: number;
};

export type EntitySourceDefinition = {
  bank: string;
  byteOffset: number;
  dataType?: string;
  unit?: string;
  scale?: number;
  offset?: number;
  elementDataType?: string;
  elementByteSize?: number;
  maxElements?: number;
  skipZero?: boolean;
  encoding?: string;
  byteLength?: number;
  bitIndex?: number;
  onValue?: number;
};

export type EntityDisplayDefinition = {
  precision?: number;
  format?: string;
};

export type ComputedEntityDefinition = {
  id: string;
  name: string;
  category: string;
  expression: string;
  unit?: string;
  display?: EntityDisplayDefinition;
  roles?: string[];
};

export type AlarmDefinition = {
  entity: string;
  bits: AlarmBitDefinition[];
};

export type AlarmBitDefinition = {
  bit: number;
  name: string;
  severity: string;
};

export type StorageDefinition = {
  timeSeries: TimeSeriesMapping[];
  retention?: RetentionWindow[];
};

export type TimeSeriesMapping = {
  entity: string;
  column: string;
};

export type RetentionWindow = {
  resolution: string;
  duration: string;
};

// --- UI model types ---

export type UiDefinition = {
  pages: Record<string, UiPageDefinition>;
};

export type UiPageDefinition = {
  sections?: UiSectionDefinition[];
  resolutions?: UiResolutionDefinition[];
  charts?: UiChartDefinition[];
  card?: UiDashboardCard;
};

export type UiSectionDefinition = {
  type: string;
  metrics?: UiMetricDefinition[];
  entities?: string[];
  entity?: string;
  title?: string;
  filter?: UiFilterDefinition;
  groupBy?: string;
  showStats?: boolean;
  showDelta?: boolean;
  stats?: string[];
};

export type UiMetricDefinition = {
  entity: string;
  icon: string;
  color: string;
};

export type UiFilterDefinition = {
  writable?: boolean;
  categories?: string[];
};

export type UiResolutionDefinition = {
  id: string;
  label: string;
  defaultWindow: string;
};

export type UiChartDefinition = {
  title: string;
  type: string;
  traces?: UiChartTrace[];
  entity?: string;
  selectable?: boolean;
  yAxis?: UiAxisDefinition;
  showEnergyTotals?: boolean;
};

export type UiChartTrace = {
  entity: string;
  label?: string;
  color: string;
  dashed?: boolean;
  secondaryAxis?: boolean;
  positiveLabel?: string;
  negativeLabel?: string;
};

export type UiAxisDefinition = {
  unit: string;
  label: string;
  domain?: [number, number];
};

export type UiDashboardCard = {
  primaryMetric: string;
  secondaryMetrics: string[];
  statusEntities: string[];
};

export type NotificationDefinition = {
  rules: NotificationRule[];
};

export type NotificationRule = {
  id: string;
  name: string;
  condition: NotificationCondition;
  severity: string;
  message: string;
  cooldownMinutes: number;
};

export type NotificationCondition = {
  entity: string;
  operator: string;
  value: number;
};

/** Summary returned by GET /api/definitions */
export type DeviceDefinitionSummary = {
  id: string;
  name: string;
  manufacturer: string;
  model: string;
  category: string;
  description?: string;
  icon?: string;
  protocolType: string;
  transportType: string;
  isTransportSupported: boolean;
  unsupportedTransportMessage?: string | null;
  entityCount: number;
  dataSourceCount: number;
};
