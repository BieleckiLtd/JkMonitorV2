export type AutomationTriggerType = 'expression' | 'date-time' | 'time-of-day' | 'weekly' | 'hourly';

export type AutomationSelectOption = {
  value: number;
  label: string;
};

export type AutomationParameterOption = {
  id: string;
  name: string;
  category: string;
  unit: string;
  isWritable: boolean;
  rawValue?: number | null;
  options: AutomationSelectOption[];
};

export type AutomationDeviceOption = {
  id: string;
  name: string;
  parameters: AutomationParameterOption[];
  writableParameters: AutomationParameterOption[];
};

export type AutomationRuleConfig = {
  id: string;
  name: string;
  enabled: boolean;
  sourceDeviceId: string;
  expression: string;
  triggerType: AutomationTriggerType;
  runAt?: string | null;
  timeOfDay?: string | null;
  daysOfWeek: number[];
  minuteOfHour?: number | null;
  targetDeviceId: string;
  targetParameterKey: string;
  rawValue: number;
  cooldownMinutes: number;
};

export type AutomationConfigResponse = {
  rules: AutomationRuleConfig[];
};

export type AutomationLogEntry = {
  ruleId: string;
  ruleName: string;
  firedAt: string;
  triggerType: AutomationTriggerType;
  sourceDeviceId: string;
  targetDeviceId: string;
  targetParameterKey: string;
  rawValue: number;
  success: boolean;
  message: string;
};
