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
  numericValue?: number | null;
  stringValue?: string | null;
  booleanValue?: boolean | null;
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
  expression: string;
  actions: AutomationActionConfig[];
  cooldownMinutes: number;
};

export type AutomationActionConfig = {
  targetDeviceId: string;
  targetParameterKey: string;
  rawValue: number;
};

export type AutomationConfigResponse = {
  rules: AutomationRuleConfig[];
};

export type AutomationActionLogEntry = AutomationActionConfig & {
  success: boolean;
  message: string;
};

export type AutomationLogEntry = {
  ruleId: string;
  ruleName: string;
  firedAt: string;
  conditionMatched: boolean;
  success: boolean;
  message: string;
  actionResults: AutomationActionLogEntry[];
};

export type TestAutomationRuleResponse = {
  conditionMatched: boolean;
  message: string;
  actionResults: AutomationActionLogEntry[];
};

export type AutomationExpressionValidationResponse = {
  isValid: boolean;
  message?: string | null;
};
