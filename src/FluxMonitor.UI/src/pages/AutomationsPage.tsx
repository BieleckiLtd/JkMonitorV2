import { useState } from 'react';
import { Bot, CheckCircle2, Hash, LoaderCircle, Play, Plus, RefreshCcw, Save, Trash2, XCircle } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';
import { useAutomationConfig, useAutomationLog, useAutomationMetadata } from '../hooks/useAutomations';
import type { AutomationActionConfig, AutomationDeviceOption, AutomationParameterOption, AutomationRuleConfig, TestAutomationRuleResponse } from '../types/automation';

const timeTokens = [
  { token: 'time.hour', label: 'Hour', value: () => new Date().getHours() },
  { token: 'time.minute', label: 'Minute', value: () => new Date().getMinutes() },
  { token: 'time.day', label: 'Day', value: () => new Date().getDate() },
  { token: 'time.month', label: 'Month', value: () => new Date().getMonth() + 1 },
  { token: 'time.day_of_week', label: 'Day of week', value: () => {
    const day = new Date().getDay();
    return day === 0 ? 7 : day;
  } },
];

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function getDevice(devices: AutomationDeviceOption[], deviceId: string) {
  return devices.find((device) => device.id === deviceId);
}

function getParameter(device: AutomationDeviceOption | undefined, parameterId: string) {
  return device?.writableParameters.find((parameter) => parameter.id === parameterId);
}

function getDefaultRawValue(parameter: AutomationParameterOption | undefined) {
  return Number(parameter?.rawValue ?? parameter?.options[0]?.value ?? 0);
}

function defaultAction(devices: AutomationDeviceOption[]): AutomationActionConfig {
  const targetDevice = devices.find((device) => device.writableParameters.length > 0);
  const targetParameter = targetDevice?.writableParameters[0];
  return {
    targetDeviceId: targetDevice?.id ?? '',
    targetParameterKey: targetParameter?.id ?? '',
    rawValue: getDefaultRawValue(targetParameter),
  };
}

function defaultRule(devices: AutomationDeviceOption[]): AutomationRuleConfig {
  return {
    id: generateId(),
    name: 'New automation',
    enabled: true,
    expression: '',
    actions: [defaultAction(devices)],
    cooldownMinutes: 15,
  };
}

function getValidationMessage(rules: AutomationRuleConfig[], devices: AutomationDeviceOption[]) {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const label = rule.name.trim() ? `Automation "${rule.name.trim()}"` : `Automation ${index + 1}`;
    if (!rule.name.trim()) return `${label}: enter a name.`;
    if (!rule.expression.trim()) return `${label}: enter an expression.`;
    if (rule.actions.length === 0) return `${label}: add at least one action.`;

    for (let actionIndex = 0; actionIndex < rule.actions.length; actionIndex += 1) {
      const action = rule.actions[actionIndex];
      const targetDevice = getDevice(devices, action.targetDeviceId);
      if (!targetDevice) return `${label} action ${actionIndex + 1}: select a target device.`;
      if (!action.targetParameterKey.trim()) return `${label} action ${actionIndex + 1}: select a writable parameter.`;
      if (!targetDevice.writableParameters.some((parameter) => parameter.id === action.targetParameterKey)) {
        return `${label} action ${actionIndex + 1}: select a writable parameter exposed by the target device.`;
      }
      if (!Number.isFinite(action.rawValue) || action.rawValue < 0) return `${label} action ${actionIndex + 1}: raw value must be zero or greater.`;
    }
  }

  return null;
}

function formatValue(parameter: AutomationParameterOption) {
  if (parameter.stringValue) return parameter.stringValue;
  if (parameter.booleanValue != null) return parameter.booleanValue ? 'true' : 'false';
  if (parameter.numericValue != null) return `${parameter.numericValue}${parameter.unit ? ` ${parameter.unit}` : ''}`;
  if (parameter.rawValue != null) return `raw ${parameter.rawValue}`;
  return 'N/D';
}

function formatRawValue(parameter: AutomationParameterOption | undefined, rawValue: number) {
  const selectedOption = parameter?.options.find((option) => option.value === rawValue);
  return selectedOption ? `${selectedOption.label} (${rawValue})` : String(rawValue);
}

type Tab = 'rules' | 'history';

function TabButton({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: React.ElementType; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
        active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className='h-4 w-4' />
      {label}
    </button>
  );
}

export function AutomationsPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const { config, isLoading, error, saveRules, testRule } = useAutomationConfig();
  const { log } = useAutomationLog();
  const { devices, reload: reloadDevices } = useAutomationMetadata();
  const [tab, setTab] = useState<Tab>('rules');
  const [rules, setRules] = useState<AutomationRuleConfig[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestAutomationRuleResponse | string>>({});
  const [testingRuleId, setTestingRuleId] = useState<string | null>(null);

  if (config && !initialized) {
    setRules(config.rules.map((rule) => ({ ...rule, actions: rule.actions ?? [] })));
    setInitialized(true);
  }

  const updateRule = <K extends keyof AutomationRuleConfig>(index: number, key: K, value: AutomationRuleConfig[K]) => {
    setRules((current) => current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [key]: value } : rule)));
    setSaveMsg(null);
  };

  const updateAction = <K extends keyof AutomationActionConfig>(ruleIndex: number, actionIndex: number, key: K, value: AutomationActionConfig[K]) => {
    setRules((current) => current.map((rule, index) => {
      if (index !== ruleIndex) return rule;
      return {
        ...rule,
        actions: rule.actions.map((action, candidateIndex) => candidateIndex === actionIndex ? { ...action, [key]: value } : action),
      };
    }));
    setSaveMsg(null);
  };

  const addRule = () => {
    setRules((current) => [...current, defaultRule(devices)]);
    setSaveMsg(null);
  };

  const removeRule = (index: number) => {
    setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index));
    setSaveMsg(null);
  };

  const handleSaveRules = async () => {
    const validationMessage = getValidationMessage(rules, devices);
    if (validationMessage) {
      setSaveMsg(validationMessage);
      return;
    }

    setIsSaving(true);
    setSaveMsg(null);
    try {
      await saveRules(rules);
      setSaveMsg('Automations saved and active.');
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to save automations.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestRule = async (rule: AutomationRuleConfig) => {
    setTestingRuleId(rule.id);
    setTestResults((current) => ({ ...current, [rule.id]: 'Testing...' }));
    try {
      const result = await testRule(rule);
      setTestResults((current) => ({ ...current, [rule.id]: result }));
      await reloadDevices();
    } catch (err) {
      setTestResults((current) => ({ ...current, [rule.id]: err instanceof Error ? err.message : 'Test failed.' }));
    } finally {
      setTestingRuleId(null);
    }
  };

  if (isLoading) {
    return (
      <div className='flex min-h-64 items-center justify-center'>
        <LoaderCircle className='h-6 w-6 animate-spin text-primary' />
      </div>
    );
  }

  if (error) {
    return <div className='rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive'>{error}</div>;
  }

  return (
    <div className='mx-auto max-w-7xl space-y-6 pb-12'>
      {!hideHeader ? (
        <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
          <div>
            <h2 className='text-3xl font-bold tracking-tight text-foreground'>Automations</h2>
            <p className='mt-2 text-sm text-muted-foreground'>Build expression conditions from live device and time values, then write one or more device parameters.</p>
          </div>
        </div>
      ) : null}

      <div className='flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 p-2'>
        <TabButton active={tab === 'rules'} label='Rules' icon={Bot} onClick={() => setTab('rules')} />
        <TabButton active={tab === 'history'} label='History' icon={Hash} onClick={() => setTab('history')} />
        <Button variant='outline' size='sm' className='ml-auto' onClick={() => void reloadDevices()}>
          <RefreshCcw className='h-4 w-4' /> Refresh values
        </Button>
      </div>

      {saveMsg ? (
        <div className='rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-foreground'>{saveMsg}</div>
      ) : null}

      {tab === 'rules' ? (
        <div className='space-y-4'>
          <div className='flex flex-wrap gap-3'>
            <Button variant='outline' onClick={addRule}>
              <Plus className='h-4 w-4' /> Add automation
            </Button>
            <Button onClick={handleSaveRules} disabled={isSaving}>
              {isSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Save className='h-4 w-4' />}
              Save automations
            </Button>
          </div>

          {rules.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <Bot className='mx-auto h-10 w-10 text-muted-foreground/50' />
              <div className='mt-4 text-lg font-semibold text-foreground'>No automations configured</div>
              <p className='mt-2 text-sm text-muted-foreground'>Add a rule to write device parameters when an expression is true.</p>
            </div>
          ) : null}

          {rules.map((rule, index) => (
            <AutomationRuleEditor
              key={rule.id}
              devices={devices}
              rule={rule}
              index={index}
              testResult={testResults[rule.id]}
              isTesting={testingRuleId === rule.id}
              onUpdate={updateRule}
              onUpdateAction={updateAction}
              onRemove={removeRule}
              onTest={handleTestRule}
            />
          ))}
        </div>
      ) : null}

      {tab === 'history' ? (
        <div className='space-y-4'>
          {log.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <Hash className='mx-auto h-10 w-10 text-muted-foreground/50' />
              <div className='mt-4 text-lg font-semibold text-foreground'>No automation runs yet</div>
              <p className='mt-2 text-sm text-muted-foreground'>Runs will appear here when a rule writes target parameters.</p>
            </div>
          ) : null}

          {log.map((entry, index) => (
            <div key={`${entry.ruleId}-${entry.firedAt}-${index}`} className='rounded-xl border border-border bg-card/70 p-4 shadow-sm'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div className='flex items-center gap-2'>
                  {entry.success ? <CheckCircle2 className='h-4 w-4 text-emerald-500' /> : <XCircle className='h-4 w-4 text-destructive' />}
                  <span className='text-sm font-medium text-foreground'>{entry.ruleName}</span>
                </div>
                <span className='text-xs text-muted-foreground'>{new Date(entry.firedAt).toLocaleString()}</span>
              </div>
              <div className='mt-2 text-sm text-muted-foreground'>{entry.message}</div>
              <div className='mt-3 flex flex-wrap gap-2'>
                {entry.actionResults.map((result, resultIndex) => (
                  <Badge key={`${result.targetDeviceId}-${result.targetParameterKey}-${resultIndex}`} variant={result.success ? 'secondary' : 'destructive'}>
                    {result.targetDeviceId}.{result.targetParameterKey} = {result.rawValue}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AutomationRuleEditor({
  devices,
  rule,
  index,
  testResult,
  isTesting,
  onUpdate,
  onUpdateAction,
  onRemove,
  onTest,
}: {
  devices: AutomationDeviceOption[];
  rule: AutomationRuleConfig;
  index: number;
  testResult?: TestAutomationRuleResponse | string;
  isTesting: boolean;
  onUpdate: <K extends keyof AutomationRuleConfig>(index: number, key: K, value: AutomationRuleConfig[K]) => void;
  onUpdateAction: <K extends keyof AutomationActionConfig>(ruleIndex: number, actionIndex: number, key: K, value: AutomationActionConfig[K]) => void;
  onRemove: (index: number) => void;
  onTest: (rule: AutomationRuleConfig) => void;
}) {
  const insertToken = (token: string) => {
    const prefix = rule.expression.trim() ? `${rule.expression.trim()} ` : '';
    onUpdate(index, 'expression', `${prefix}${token}`);
  };

  const addAction = () => {
    onUpdate(index, 'actions', [...rule.actions, defaultAction(devices)]);
  };

  const removeAction = (actionIndex: number) => {
    onUpdate(index, 'actions', rule.actions.filter((_, indexCandidate) => indexCandidate !== actionIndex));
  };

  return (
    <section className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
      <div className='mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3'>
        <div className='flex items-center gap-3'>
          <Bot className='h-5 w-5 text-primary' />
          <span className='text-sm font-semibold text-foreground'>{rule.name || 'Unnamed automation'}</span>
        </div>
        <div className='flex items-center gap-2'>
          <Switch checked={rule.enabled} onCheckedChange={(checked) => onUpdate(index, 'enabled', checked)} />
          <Button variant='outline' size='sm' onClick={() => void onTest(rule)} disabled={isTesting}>
            {isTesting ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : <Play className='h-3.5 w-3.5' />}
            Test now
          </Button>
          <Button variant='destructive' size='sm' onClick={() => onRemove(index)}>
            <Trash2 className='h-3 w-3' />
          </Button>
        </div>
      </div>

      <div className='grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]'>
        <div className='space-y-4'>
          <div className='grid gap-4 md:grid-cols-[minmax(0,1fr)_10rem]'>
            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Name</span>
              <Input value={rule.name} onChange={(event) => onUpdate(index, 'name', event.target.value)} />
            </label>
            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Cooldown</span>
              <Input type='number' min={0} value={rule.cooldownMinutes} onChange={(event) => onUpdate(index, 'cooldownMinutes', Number(event.target.value))} />
            </label>
          </div>

          <label className='space-y-1.5'>
            <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Condition expression</span>
            <Input
              className='h-10 font-mono text-sm'
              value={rule.expression}
              onChange={(event) => onUpdate(index, 'expression', event.target.value)}
              placeholder='device-1.state_of_charge == 22 && time.day_of_week == 7'
            />
          </label>

          <div className='space-y-3'>
            <div className='flex items-center justify-between gap-3'>
              <span className='text-xs font-medium uppercase tracking-widest text-muted-foreground'>Actions</span>
              <Button type='button' variant='outline' size='sm' onClick={addAction}>
                <Plus className='h-4 w-4' /> Add action
              </Button>
            </div>
            {rule.actions.map((action, actionIndex) => (
              <AutomationActionEditor
                key={`${action.targetDeviceId}-${action.targetParameterKey}-${actionIndex}`}
                devices={devices}
                action={action}
                ruleIndex={index}
                actionIndex={actionIndex}
                onUpdate={onUpdateAction}
                onRemove={removeAction}
              />
            ))}
          </div>

          {testResult ? <TestResultPanel result={testResult} /> : null}
        </div>

        <div className='space-y-3'>
          <TokenPanel devices={devices} onInsert={insertToken} />
        </div>
      </div>
    </section>
  );
}

function TokenPanel({ devices, onInsert }: { devices: AutomationDeviceOption[]; onInsert: (token: string) => void }) {
  return (
    <div className='rounded-xl border border-border bg-background/55 p-3'>
      <div className='mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground'>Available values</div>
      <div className='space-y-3'>
        <div className='space-y-2'>
          <div className='font-mono text-[11px] uppercase tracking-widest text-muted-foreground'>time</div>
          <div className='space-y-1.5'>
            {timeTokens.map((item) => (
              <button key={item.token} type='button' onClick={() => onInsert(item.token)} className='flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-left text-xs hover:bg-muted'>
                <span className='font-mono text-foreground'>{item.token}</span>
                <span className='text-muted-foreground'>{item.value()}</span>
              </button>
            ))}
          </div>
        </div>

        <div className='max-h-[30rem] space-y-3 overflow-auto pr-1'>
          {devices.map((device) => (
            <div key={device.id} className='space-y-2'>
              <div className='truncate font-mono text-[11px] uppercase tracking-widest text-muted-foreground'>{device.id}</div>
              <div className='space-y-1.5'>
                {device.parameters.map((parameter) => {
                  const token = `${device.id}.${parameter.id}`;
                  return (
                    <button key={token} type='button' onClick={() => onInsert(token)} className='grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-left text-xs hover:bg-muted'>
                      <span className='truncate font-mono text-foreground'>{parameter.id}</span>
                      <span className='max-w-28 truncate text-muted-foreground'>{formatValue(parameter)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AutomationActionEditor({
  devices,
  action,
  ruleIndex,
  actionIndex,
  onUpdate,
  onRemove,
}: {
  devices: AutomationDeviceOption[];
  action: AutomationActionConfig;
  ruleIndex: number;
  actionIndex: number;
  onUpdate: <K extends keyof AutomationActionConfig>(ruleIndex: number, actionIndex: number, key: K, value: AutomationActionConfig[K]) => void;
  onRemove: (actionIndex: number) => void;
}) {
  const targetDevice = getDevice(devices, action.targetDeviceId);
  const targetParameter = getParameter(targetDevice, action.targetParameterKey);

  const setTargetDevice = (deviceId: string) => {
    const nextDevice = getDevice(devices, deviceId);
    const nextParameter = nextDevice?.writableParameters[0];
    onUpdate(ruleIndex, actionIndex, 'targetDeviceId', deviceId);
    onUpdate(ruleIndex, actionIndex, 'targetParameterKey', nextParameter?.id ?? '');
    onUpdate(ruleIndex, actionIndex, 'rawValue', getDefaultRawValue(nextParameter));
  };

  const setTargetParameter = (parameterKey: string) => {
    const nextParameter = targetDevice?.writableParameters.find((parameter) => parameter.id === parameterKey);
    onUpdate(ruleIndex, actionIndex, 'targetParameterKey', parameterKey);
    onUpdate(ruleIndex, actionIndex, 'rawValue', nextParameter ? getDefaultRawValue(nextParameter) : action.rawValue);
  };

  return (
    <div className='rounded-xl border border-border bg-background/55 p-3'>
      <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(8rem,12rem)_auto]'>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Device</span>
          <select aria-label={`Automation ${ruleIndex + 1} action ${actionIndex + 1} device`} className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm' value={action.targetDeviceId} onChange={(event) => setTargetDevice(event.target.value)}>
            <option value=''>Select device...</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>{device.name}</option>
            ))}
          </select>
        </label>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Writable parameter</span>
          <select aria-label={`Automation ${ruleIndex + 1} action ${actionIndex + 1} parameter`} className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm' value={action.targetParameterKey} onChange={(event) => setTargetParameter(event.target.value)}>
            <option value=''>Select parameter...</option>
            {targetDevice?.writableParameters.map((parameter) => (
              <option key={parameter.id} value={parameter.id}>{parameter.name}</option>
            ))}
          </select>
        </label>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Set to</span>
          {targetParameter && targetParameter.options.length > 0 ? (
            <select aria-label={`Automation ${ruleIndex + 1} action ${actionIndex + 1} value`} className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm' value={action.rawValue} onChange={(event) => onUpdate(ruleIndex, actionIndex, 'rawValue', Number(event.target.value))}>
              {targetParameter.options.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : (
            <Input type='number' min={0} value={action.rawValue} onChange={(event) => onUpdate(ruleIndex, actionIndex, 'rawValue', Number(event.target.value))} />
          )}
        </label>
        <div className='flex items-end'>
          <Button variant='destructive' size='sm' onClick={() => onRemove(actionIndex)}>
            <Trash2 className='h-3.5 w-3.5' />
          </Button>
        </div>
      </div>

      {targetParameter ? (
        <div className='mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground'>
          <Badge variant='outline'>current: {formatValue(targetParameter)}</Badge>
          <Badge variant='outline'>write: {formatRawValue(targetParameter, action.rawValue)}</Badge>
          <Badge variant='outline' className='font-mono'>{action.targetDeviceId}.{action.targetParameterKey}</Badge>
        </div>
      ) : null}
    </div>
  );
}

function TestResultPanel({ result }: { result: TestAutomationRuleResponse | string }) {
  if (typeof result === 'string') {
    return <div className='rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground'>{result}</div>;
  }

  return (
    <div className={cn(
      'rounded-xl border px-4 py-3 text-sm',
      result.conditionMatched ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted/40 text-muted-foreground',
    )}>
      <div>{result.message}</div>
      {result.actionResults.length > 0 ? (
        <div className='mt-2 flex flex-wrap gap-2'>
          {result.actionResults.map((action, index) => (
            <Badge key={`${action.targetDeviceId}-${action.targetParameterKey}-${index}`} variant={action.success ? 'secondary' : 'destructive'}>
              {action.targetDeviceId}.{action.targetParameterKey} = {action.rawValue}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}
