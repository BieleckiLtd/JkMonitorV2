export type NotificationChannelType = 'ntfy' | 'email' | 'whatsapp';

export type NotificationChannelConfig = {
  id: string;
  type: NotificationChannelType;
  name: string;
  enabled: boolean;
  settings: Record<string, unknown>;
};

export type NtfySettings = {
  baseUrl: string;
  topic: string;
  accessToken?: string | null;
  priority?: number;
};

export type EmailSettings = {
  host: string;
  port: number;
  useSsl: boolean;
  username?: string | null;
  password?: string | null;
  fromAddress: string;
  fromName?: string;
  toAddresses: string[];
};

export type WhatsAppSettings = {
  apiVersion: string;
  phoneNumberId: string;
  recipientNumber: string;
  accessToken: string;
  previewUrl: boolean;
};

export type NotificationRuleConfig = {
  id: string;
  name: string;
  enabled: boolean;
  deviceId: string;
  entityId: string;
  expression: string;
  channelIds: string[];
  messageTemplate: string;
  severity: 'info' | 'warning' | 'critical';
  cooldownMinutes: number;
};

export type NotificationConfigResponse = {
  channels: NotificationChannelConfig[];
  rules: NotificationRuleConfig[];
};

export type TestChannelResponse = {
  success: boolean;
  error?: string | null;
};

export type NotificationLogEntry = {
  ruleId: string;
  ruleName: string;
  deviceId: string;
  entityId: string;
  firedAt: string;
  message: string;
  severity: string;
  channelResults: string[];
};

export type EntityOption = {
  id: string;
  name: string;
  unit: string;
};

export type DeviceOption = {
  id: string;
  name: string;
};
