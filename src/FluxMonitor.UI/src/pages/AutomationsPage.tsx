import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, ChevronDown, ChevronRight, Hash, LoaderCircle, Play, Plus, RefreshCcw, Save, Search, Trash2, XCircle } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';
import { useAutomationConfig, useAutomationLog, useAutomationMetadata } from '../hooks/useAutomations';
import type { AutomationActionConfig, AutomationDeviceOption, AutomationParameterOption, AutomationRuleConfig, TestAutomationRuleResponse } from '../types/automation';
import type { ReactNode } from 'react';

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

const draftStorageKey = 'fluxmonitor.automations.draft.v1';

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

function getValidationMessage(rule: AutomationRuleConfig, devices: AutomationDeviceOption[], index: number) {
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

type AutomationDraftState = {
  rules: AutomationRuleConfig[];
  tab: Tab;
  ruleMessages: Record<string, string>;
  testResults: Record<string, TestAutomationRuleResponse | string>;
  activeRuleId: string | null;
};

function readDraftState(): AutomationDraftState | null {
  if (typeof window === 'undefined') return null;

  try {
    const stored = window.sessionStorage.getItem(draftStorageKey);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<AutomationDraftState>;
    if (!Array.isArray(parsed.rules)) return null;
    return {
      rules: parsed.rules.map((rule) => ({ ...rule, actions: rule.actions ?? [] })),
      tab: parsed.tab === 'history' ? 'history' : 'rules',
      ruleMessages: parsed.ruleMessages ?? {},
      testResults: parsed.testResults ?? {},
      activeRuleId: parsed.activeRuleId ?? null,
    };
  } catch {
    return null;
  }
}

function writeDraftState(state: AutomationDraftState) {
  if (typeof window === 'undefined') return;

  try {
    window.sessionStorage.setItem(draftStorageKey, JSON.stringify(state));
  } catch {
    // Ignore storage failures; drafts are a convenience, not critical data.
  }
}

function clearDraftState() {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(draftStorageKey);
}

function TabButton({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: React.ElementType; onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors sm:px-4',
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
  const initialDraft = useMemo(readDraftState, []);
  const [tab, setTab] = useState<Tab>(initialDraft?.tab ?? 'rules');
  const [rules, setRules] = useState<AutomationRuleConfig[]>(initialDraft?.rules ?? []);
  const [savedRules, setSavedRules] = useState<AutomationRuleConfig[]>([]);
  const [initialized, setInitialized] = useState(Boolean(initialDraft));
  const [savingRuleId, setSavingRuleId] = useState<string | null>(null);
  const [ruleMessages, setRuleMessages] = useState<Record<string, string>>(initialDraft?.ruleMessages ?? {});
  const [testResults, setTestResults] = useState<Record<string, TestAutomationRuleResponse | string>>(initialDraft?.testResults ?? {});
  const [testingRuleId, setTestingRuleId] = useState<string | null>(null);
  const [activeRuleId, setActiveRuleId] = useState<string | null>(initialDraft?.activeRuleId ?? null);

  useEffect(() => {
    if (config && !initialized) {
      const normalizedRules = config.rules.map((rule) => ({ ...rule, actions: rule.actions ?? [] }));
      setSavedRules(normalizedRules);
      setRules(normalizedRules);
      setActiveRuleId((current) => current ?? normalizedRules[0]?.id ?? null);
      setInitialized(true);
    }
  }, [config, initialized]);

  useEffect(() => {
    if (!initialized) return;
    writeDraftState({ rules, tab, ruleMessages, testResults, activeRuleId });
  }, [activeRuleId, initialized, ruleMessages, rules, tab, testResults]);

  const updateRule = <K extends keyof AutomationRuleConfig>(index: number, key: K, value: AutomationRuleConfig[K]) => {
    setRules((current) => current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [key]: value } : rule)));
    setRuleMessages((current) => {
      const next = { ...current };
      delete next[rules[index]?.id ?? ''];
      return next;
    });
  };

  const updateAction = <K extends keyof AutomationActionConfig>(ruleIndex: number, actionIndex: number, key: K, value: AutomationActionConfig[K]) => {
    setRules((current) => current.map((rule, index) => {
      if (index !== ruleIndex) return rule;
      return {
        ...rule,
        actions: rule.actions.map((action, candidateIndex) => candidateIndex === actionIndex ? { ...action, [key]: value } : action),
      };
    }));
    setRuleMessages((current) => {
      const next = { ...current };
      delete next[rules[ruleIndex]?.id ?? ''];
      return next;
    });
  };

  const addRule = () => {
    const nextRule = defaultRule(devices);
    setRules((current) => [...current, nextRule]);
    setActiveRuleId(nextRule.id);
  };

  const removeRule = async (index: number) => {
    const rule = rules[index];
    if (!rule) return;

    setRules((current) => current.filter((_, ruleIndex) => ruleIndex !== index));
    setRuleMessages((current) => {
      const next = { ...current };
      delete next[rule.id];
      return next;
    });
    setActiveRuleId((current) => current === rule.id ? rules.find((_, ruleIndex) => ruleIndex !== index)?.id ?? null : current);

    if (!savedRules.some((savedRule) => savedRule.id === rule.id)) return;

    setSavingRuleId(rule.id);
    try {
      const data = await saveRules(savedRules.filter((savedRule) => savedRule.id !== rule.id));
      setSavedRules(data.rules.map((savedRule) => ({ ...savedRule, actions: savedRule.actions ?? [] })));
    } catch (err) {
      setRules((current) => {
        const next = [...current];
        next.splice(index, 0, rule);
        return next;
      });
      setRuleMessages((current) => ({ ...current, [rule.id]: err instanceof Error ? err.message : 'Failed to delete automation.' }));
    } finally {
      setSavingRuleId(null);
    }
  };

  const handleSaveRule = async (index: number) => {
    const rule = rules[index];
    if (!rule) return;

    const validationMessage = getValidationMessage(rule, devices, index);
    if (validationMessage) {
      setRuleMessages((current) => ({ ...current, [rule.id]: validationMessage }));
      return;
    }

    const nextSavedRules = savedRules.some((savedRule) => savedRule.id === rule.id)
      ? savedRules.map((savedRule) => savedRule.id === rule.id ? rule : savedRule)
      : [...savedRules, rule];

    setSavingRuleId(rule.id);
    setRuleMessages((current) => {
      const next = { ...current };
      delete next[rule.id];
      return next;
    });
    try {
      const data = await saveRules(nextSavedRules);
      setSavedRules(data.rules.map((savedRule) => ({ ...savedRule, actions: savedRule.actions ?? [] })));
      clearDraftState();
      setRuleMessages((current) => ({ ...current, [rule.id]: 'Automation saved and active.' }));
    } catch (err) {
      setRuleMessages((current) => ({ ...current, [rule.id]: err instanceof Error ? err.message : 'Failed to save automation.' }));
    } finally {
      setSavingRuleId(null);
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

  const insertTokenIntoActiveRule = (token: string) => {
    const activeIndex = rules.findIndex((rule) => rule.id === activeRuleId);
    if (activeIndex < 0) return;
    const activeRule = rules[activeIndex];
    const prefix = activeRule.expression.trim() ? `${activeRule.expression.trim()} ` : '';
    updateRule(activeIndex, 'expression', `${prefix}${token}`);
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
    <div className='mx-auto max-w-7xl space-y-4 pb-12 sm:space-y-6'>
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
        <Button variant='outline' size='sm' className='w-full sm:ml-auto sm:w-auto' onClick={() => void reloadDevices()}>
          <RefreshCcw className='h-4 w-4' /> Refresh values
        </Button>
      </div>

      {tab === 'rules' ? (
        <div className='space-y-4'>
          <div className='grid gap-2 sm:flex sm:flex-wrap sm:gap-3'>
            <Button variant='outline' className='w-full sm:w-auto' onClick={addRule}>
              <Plus className='h-4 w-4' /> Add automation
            </Button>
          </div>

          <TokenPanel
            devices={devices}
            activeRule={rules.find((rule) => rule.id === activeRuleId)}
            onInsert={insertTokenIntoActiveRule}
          />

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
              message={ruleMessages[rule.id]}
              isTesting={testingRuleId === rule.id}
              isSaving={savingRuleId === rule.id}
              onUpdate={updateRule}
              onUpdateAction={updateAction}
              onRemove={removeRule}
              onTest={handleTestRule}
              onSave={handleSaveRule}
              onActivate={setActiveRuleId}
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
  message,
  isTesting,
  isSaving,
  onUpdate,
  onUpdateAction,
  onRemove,
  onTest,
  onSave,
  onActivate,
}: {
  devices: AutomationDeviceOption[];
  rule: AutomationRuleConfig;
  index: number;
  testResult?: TestAutomationRuleResponse | string;
  message?: string;
  isTesting: boolean;
  isSaving: boolean;
  onUpdate: <K extends keyof AutomationRuleConfig>(index: number, key: K, value: AutomationRuleConfig[K]) => void;
  onUpdateAction: <K extends keyof AutomationActionConfig>(ruleIndex: number, actionIndex: number, key: K, value: AutomationActionConfig[K]) => void;
  onRemove: (index: number) => void | Promise<void>;
  onTest: (rule: AutomationRuleConfig) => void;
  onSave: (index: number) => void | Promise<void>;
  onActivate: (ruleId: string) => void;
}) {
  const addAction = () => {
    onUpdate(index, 'actions', [...rule.actions, defaultAction(devices)]);
  };

  const removeAction = (actionIndex: number) => {
    onUpdate(index, 'actions', rule.actions.filter((_, indexCandidate) => indexCandidate !== actionIndex));
  };

  return (
    <section className='rounded-xl border border-border bg-card/70 p-3 shadow-sm sm:rounded-2xl sm:p-5'>
      <div className='mb-4 grid gap-3 border-b border-border pb-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between'>
        <div className='flex min-w-0 items-center gap-3'>
          <Bot className='h-5 w-5 shrink-0 text-primary' />
          <span className='min-w-0 truncate text-sm font-semibold text-foreground'>{rule.name || 'Unnamed automation'}</span>
        </div>
        <div className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:flex'>
          <Switch checked={rule.enabled} onCheckedChange={(checked) => onUpdate(index, 'enabled', checked)} />
          <Button className='w-full sm:w-auto' variant='outline' size='sm' onClick={() => void onTest(rule)} disabled={isTesting}>
            {isTesting ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : <Play className='h-3.5 w-3.5' />}
            Test now
          </Button>
          <Button className='w-full sm:w-auto' size='sm' onClick={() => void onSave(index)} disabled={isSaving}>
            {isSaving ? <LoaderCircle className='h-3.5 w-3.5 animate-spin' /> : <Save className='h-3.5 w-3.5' />}
            Save
          </Button>
          <Button variant='destructive' size='sm' onClick={() => void onRemove(index)} disabled={isSaving}>
            <Trash2 className='h-3 w-3' />
          </Button>
        </div>
      </div>

      <div className='grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1fr)_22rem]'>
        <div className='space-y-4'>
          <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_10rem]'>
            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Name</span>
              <Input value={rule.name} onChange={(event) => onUpdate(index, 'name', event.target.value)} />
            </label>
            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Cooldown</span>
              <Input type='number' min={0} value={rule.cooldownMinutes} onChange={(event) => onUpdate(index, 'cooldownMinutes', Number(event.target.value))} />
            </label>
          </div>

          <label className='space-y-1.5'>
            <span className='block text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Condition expression</span>
            <Input
              className='h-10 font-mono text-sm'
              value={rule.expression}
              onChange={(event) => onUpdate(index, 'expression', event.target.value)}
              onFocus={() => onActivate(rule.id)}
              placeholder='device-1.state_of_charge == 22 && time.day_of_week == 7'
            />
          </label>

          <div className='space-y-3'>
            <div className='grid gap-2 sm:flex sm:items-center sm:justify-between sm:gap-3'>
              <span className='text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Actions</span>
              <Button type='button' className='w-full sm:w-auto' variant='outline' size='sm' onClick={addAction}>
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
          {message ? <div className='rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground'>{message}</div> : null}
        </div>
      </div>
    </section>
  );
}

function TokenPanel({
  devices,
  activeRule,
  onInsert,
}: {
  devices: AutomationDeviceOption[];
  activeRule: AutomationRuleConfig | undefined;
  onInsert: (token: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set(['time']));
  const normalizedQuery = query.trim().toLowerCase();
  const visibleDevices = devices.map((device) => ({
    device,
    parameters: normalizedQuery
      ? device.parameters.filter((parameter) => [
        device.id,
        device.name,
        parameter.id,
        parameter.name,
        parameter.category,
        formatValue(parameter),
      ].some((value) => value.toLowerCase().includes(normalizedQuery)))
      : device.parameters,
  })).filter((item) => item.parameters.length > 0);
  const visibleTimeTokens = normalizedQuery
    ? timeTokens.filter((item) => [item.token, item.label, String(item.value())].some((value) => value.toLowerCase().includes(normalizedQuery)))
    : timeTokens;

  const toggleSection = (sectionId: string) => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  return (
    <div className='rounded-xl border border-border bg-background/55 p-3'>
      <div className='mb-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(12rem,18rem)] lg:items-center'>
        <div>
          <div className='text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Available values</div>
          <div className='mt-1 truncate text-xs text-muted-foreground'>
            Insert into: <span className='text-foreground'>{activeRule?.name || 'select an automation expression'}</span>
          </div>
        </div>
        <label className='relative block'>
          <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground' />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder='Find value...' className='pl-8' />
        </label>
      </div>
      <div className='space-y-3'>
        <ExpandableValueSection
          id='time'
          title='time'
          count={visibleTimeTokens.length}
          expanded={expandedSections.has('time')}
          onToggle={toggleSection}
        >
          {visibleTimeTokens.map((item) => (
            <ValueTokenButton
              key={item.token}
              token={item.token}
              value={String(item.value())}
              disabled={!activeRule}
              onInsert={onInsert}
            />
          ))}
        </ExpandableValueSection>

        {visibleDevices.map(({ device, parameters }) => (
          <ExpandableValueSection
            key={device.id}
            id={device.id}
            title={device.id}
            subtitle={device.name}
            count={parameters.length}
            expanded={expandedSections.has(device.id) || Boolean(normalizedQuery)}
            onToggle={toggleSection}
          >
            {parameters.map((parameter) => {
              const token = `${device.id}.${parameter.id}`;
              return (
                <ValueTokenButton
                  key={token}
                  token={token}
                  label={parameter.id}
                  value={formatValue(parameter)}
                  disabled={!activeRule}
                  onInsert={onInsert}
                />
              );
            })}
          </ExpandableValueSection>
        ))}
      </div>
    </div>
  );
}

function ExpandableValueSection({
  id,
  title,
  subtitle,
  count,
  expanded,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  count: number;
  expanded: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className='rounded-xl border border-border bg-card/60'>
      <button type='button' className='flex w-full items-center gap-3 px-3 py-2 text-left' onClick={() => onToggle(id)} aria-expanded={expanded}>
        {expanded ? <ChevronDown className='h-4 w-4 shrink-0 text-muted-foreground' /> : <ChevronRight className='h-4 w-4 shrink-0 text-muted-foreground' />}
        <div className='min-w-0 flex-1'>
          <div className='truncate font-mono text-xs text-foreground'>{title}</div>
          {subtitle ? <div className='truncate text-xs text-muted-foreground'>{subtitle}</div> : null}
        </div>
        <Badge variant='outline'>{count}</Badge>
      </button>
      {expanded ? <div className='max-h-80 space-y-1.5 overflow-auto border-t border-border p-2'>{children}</div> : null}
    </div>
  );
}

function ValueTokenButton({
  token,
  label,
  value,
  disabled,
  onInsert,
}: {
  token: string;
  label?: string;
  value: string;
  disabled: boolean;
  onInsert: (token: string) => void;
}) {
  return (
    <button
      type='button'
      disabled={disabled}
      onClick={() => onInsert(token)}
      className='grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-border bg-background/80 px-2.5 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50'
    >
      <span className='truncate font-mono text-foreground'>{label ?? token}</span>
      <span className='max-w-32 truncate text-muted-foreground'>{value}</span>
    </button>
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
      <div className='grid min-w-0 gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(8rem,12rem)_auto]'>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Device</span>
          <select aria-label={`Automation ${ruleIndex + 1} action ${actionIndex + 1} device`} className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm' value={action.targetDeviceId} onChange={(event) => setTargetDevice(event.target.value)}>
            <option value=''>Select device...</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>{device.name}</option>
            ))}
          </select>
        </label>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Writable parameter</span>
          <select aria-label={`Automation ${ruleIndex + 1} action ${actionIndex + 1} parameter`} className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm' value={action.targetParameterKey} onChange={(event) => setTargetParameter(event.target.value)}>
            <option value=''>Select parameter...</option>
            {targetDevice?.writableParameters.map((parameter) => (
              <option key={parameter.id} value={parameter.id}>{parameter.name}</option>
            ))}
          </select>
        </label>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-wide text-muted-foreground sm:tracking-widest'>Set to</span>
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
        <div className='flex items-end 2xl:justify-end'>
          <Button className='w-full 2xl:w-auto' variant='destructive' size='sm' onClick={() => onRemove(actionIndex)}>
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

  const success = result.actionResults.length > 0
    ? result.actionResults.every((action) => action.success)
    : result.conditionMatched;

  return (
    <div className={cn(
      'rounded-xl border px-4 py-3 text-sm',
      success ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-border bg-muted/40 text-muted-foreground',
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
