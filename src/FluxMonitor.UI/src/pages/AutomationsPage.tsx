import { useState } from 'react';
import { Bot, CalendarClock, CheckCircle2, Clock3, Hash, LoaderCircle, Plus, Save, Trash2, XCircle } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { cn } from '../lib/utils';
import { useAutomationConfig, useAutomationLog, useAutomationMetadata } from '../hooks/useAutomations';
import type { AutomationDeviceOption, AutomationRuleConfig, AutomationTriggerType } from '../types/automation';

const dayOptions = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultRule(devices: AutomationDeviceOption[]): AutomationRuleConfig {
  const sourceDevice = devices[0];
  const targetDevice = devices.find((device) => device.writableParameters.length > 0) ?? sourceDevice;
  const targetParameter = targetDevice?.writableParameters[0];

  return {
    id: generateId(),
    name: 'New automation',
    enabled: true,
    sourceDeviceId: sourceDevice?.id ?? '',
    expression: '',
    triggerType: 'expression',
    runAt: null,
    timeOfDay: '09:00',
    daysOfWeek: [1, 2, 3, 4, 5],
    minuteOfHour: 0,
    targetDeviceId: targetDevice?.id ?? '',
    targetParameterKey: targetParameter?.id ?? '',
    rawValue: Number(targetParameter?.options[0]?.value ?? targetParameter?.rawValue ?? 0),
    cooldownMinutes: 15,
  };
}

function getDevice(devices: AutomationDeviceOption[], deviceId: string) {
  return devices.find((device) => device.id === deviceId);
}

function getValidationMessage(rules: AutomationRuleConfig[], devices: AutomationDeviceOption[]) {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const label = rule.name.trim() ? `Automation "${rule.name.trim()}"` : `Automation ${index + 1}`;
    const targetDevice = getDevice(devices, rule.targetDeviceId);

    if (!rule.name.trim()) return `${label}: enter a name.`;
    if (rule.triggerType === 'expression' && !rule.sourceDeviceId.trim()) return `${label}: select a source device.`;
    if (rule.triggerType === 'expression' && !rule.expression.trim()) return `${label}: enter an expression.`;
    if (rule.triggerType === 'date-time' && !rule.runAt) return `${label}: choose a date and time.`;
    if ((rule.triggerType === 'time-of-day' || rule.triggerType === 'weekly') && !rule.timeOfDay) return `${label}: choose a time.`;
    if (rule.triggerType === 'weekly' && rule.daysOfWeek.length === 0) return `${label}: select at least one day.`;
    if (rule.triggerType === 'hourly' && (rule.minuteOfHour == null || rule.minuteOfHour < 0 || rule.minuteOfHour > 59)) {
      return `${label}: minute must be 0-59.`;
    }
    if (!targetDevice) return `${label}: select a target device.`;
    if (!rule.targetParameterKey.trim()) return `${label}: select a writable target parameter.`;
    if (!targetDevice.writableParameters.some((parameter) => parameter.id === rule.targetParameterKey)) {
      return `${label}: select a writable parameter exposed by the target device.`;
    }
    if (!Number.isFinite(rule.rawValue) || rule.rawValue < 0) return `${label}: raw value must be zero or greater.`;
  }

  return null;
}

function toDateTimeInputValue(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function fromDateTimeInputValue(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  const { config, isLoading, error, saveRules } = useAutomationConfig();
  const { log } = useAutomationLog();
  const { devices } = useAutomationMetadata();
  const [tab, setTab] = useState<Tab>('rules');
  const [rules, setRules] = useState<AutomationRuleConfig[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  if (config && !initialized) {
    setRules(config.rules);
    setInitialized(true);
  }

  const updateRule = <K extends keyof AutomationRuleConfig>(index: number, key: K, value: AutomationRuleConfig[K]) => {
    setRules((current) => current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [key]: value } : rule)));
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
    <div className='mx-auto max-w-6xl space-y-6 pb-12'>
      {!hideHeader ? (
        <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
          <div>
            <h2 className='text-3xl font-bold tracking-tight text-foreground'>Automations</h2>
            <p className='mt-2 text-sm text-muted-foreground'>Trigger device writes from parameter expressions and schedules.</p>
          </div>
        </div>
      ) : null}

      <div className='flex gap-2 rounded-xl border border-border bg-card/60 p-2'>
        <TabButton active={tab === 'rules'} label='Rules' icon={Bot} onClick={() => setTab('rules')} />
        <TabButton active={tab === 'history'} label='History' icon={Hash} onClick={() => setTab('history')} />
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
              <p className='mt-2 text-sm text-muted-foreground'>Add a rule to write a device parameter when a condition or schedule matches.</p>
            </div>
          ) : null}

          {rules.map((rule, index) => (
            <AutomationRuleEditor
              key={rule.id}
              devices={devices}
              rule={rule}
              index={index}
              onUpdate={updateRule}
              onRemove={removeRule}
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
              <p className='mt-2 text-sm text-muted-foreground'>Runs will appear here when a rule writes a target parameter.</p>
            </div>
          ) : null}

          {log.map((entry, index) => (
            <div key={`${entry.ruleId}-${entry.firedAt}-${index}`} className='rounded-xl border border-border bg-card/70 p-4 shadow-sm'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div className='flex items-center gap-2'>
                  {entry.success ? <CheckCircle2 className='h-4 w-4 text-emerald-500' /> : <XCircle className='h-4 w-4 text-destructive' />}
                  <span className='text-sm font-medium text-foreground'>{entry.ruleName}</span>
                  <Badge variant='outline' className='text-[10px]'>{entry.triggerType}</Badge>
                </div>
                <span className='text-xs text-muted-foreground'>{new Date(entry.firedAt).toLocaleString()}</span>
              </div>
              <div className='mt-2 text-sm text-muted-foreground'>{entry.message}</div>
              <div className='mt-2 text-xs text-muted-foreground'>
                {entry.targetDeviceId} / {entry.targetParameterKey} = {entry.rawValue}
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
  onUpdate,
  onRemove,
}: {
  devices: AutomationDeviceOption[];
  rule: AutomationRuleConfig;
  index: number;
  onUpdate: <K extends keyof AutomationRuleConfig>(index: number, key: K, value: AutomationRuleConfig[K]) => void;
  onRemove: (index: number) => void;
}) {
  const sourceDevice = getDevice(devices, rule.sourceDeviceId);
  const targetDevice = getDevice(devices, rule.targetDeviceId);
  const targetParameter = targetDevice?.writableParameters.find((parameter) => parameter.id === rule.targetParameterKey);

  const setTargetDevice = (deviceId: string) => {
    const nextDevice = getDevice(devices, deviceId);
    const nextParameter = nextDevice?.writableParameters[0];
    onUpdate(index, 'targetDeviceId', deviceId);
    onUpdate(index, 'targetParameterKey', nextParameter?.id ?? '');
    onUpdate(index, 'rawValue', Number(nextParameter?.options[0]?.value ?? nextParameter?.rawValue ?? 0));
  };

  const setTargetParameter = (parameterKey: string) => {
    const nextParameter = targetDevice?.writableParameters.find((parameter) => parameter.id === parameterKey);
    onUpdate(index, 'targetParameterKey', parameterKey);
    onUpdate(index, 'rawValue', Number(nextParameter?.options[0]?.value ?? nextParameter?.rawValue ?? rule.rawValue));
  };

  const insertParameter = (parameterId: string) => {
    const prefix = rule.expression.trim() ? `${rule.expression.trim()} ` : '';
    onUpdate(index, 'expression', `${prefix}${parameterId}`);
  };

  return (
    <section className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
      <div className='mb-4 flex items-center justify-between border-b border-border pb-3'>
        <div className='flex items-center gap-3'>
          <Bot className='h-5 w-5 text-primary' />
          <span className='text-sm font-semibold text-foreground'>{rule.name || 'Unnamed automation'}</span>
        </div>
        <div className='flex items-center gap-2'>
          <Switch checked={rule.enabled} onCheckedChange={(checked) => onUpdate(index, 'enabled', checked)} />
          <Button variant='destructive' size='sm' onClick={() => onRemove(index)}>
            <Trash2 className='h-3 w-3' />
          </Button>
        </div>
      </div>

      <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Name</span>
          <Input value={rule.name} onChange={(event) => onUpdate(index, 'name', event.target.value)} />
        </label>

        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Trigger</span>
          <select
            aria-label={`Automation ${index + 1} trigger`}
            className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
            value={rule.triggerType}
            onChange={(event) => onUpdate(index, 'triggerType', event.target.value as AutomationTriggerType)}
          >
            <option value='expression'>Expression</option>
            <option value='date-time'>Date/time</option>
            <option value='time-of-day'>Time of day</option>
            <option value='weekly'>Day of week</option>
            <option value='hourly'>Hourly</option>
          </select>
        </label>

        <label className='space-y-1.5'>
          <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Cooldown (minutes)</span>
          <Input type='number' min={0} value={rule.cooldownMinutes} onChange={(event) => onUpdate(index, 'cooldownMinutes', Number(event.target.value))} />
        </label>

        {rule.triggerType === 'expression' ? (
          <>
            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Source device</span>
              <select
                aria-label={`Automation ${index + 1} source device`}
                className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                value={rule.sourceDeviceId}
                onChange={(event) => onUpdate(index, 'sourceDeviceId', event.target.value)}
              >
                <option value=''>Select device...</option>
                {devices.map((device) => (
                  <option key={device.id} value={device.id}>{device.name}</option>
                ))}
              </select>
            </label>

            <label className='space-y-1.5 md:col-span-2 xl:col-span-3'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Expression</span>
              <Input
                className='font-mono text-sm'
                value={rule.expression}
                onChange={(event) => onUpdate(index, 'expression', event.target.value)}
                placeholder='state_of_charge < 20 && charging_enabled == 0'
              />
            </label>

            {sourceDevice ? (
              <div className='space-y-2 md:col-span-2 xl:col-span-3'>
                <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Source parameters</span>
                <div className='max-h-40 overflow-auto rounded-xl border border-border bg-background/55 p-2'>
                  <div className='flex flex-wrap gap-2'>
                    {sourceDevice.parameters.map((parameter) => (
                      <button
                        key={parameter.id}
                        type='button'
                        onClick={() => insertParameter(parameter.id)}
                        className='rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-muted'
                      >
                        <span className='font-mono'>{parameter.id}</span>
                        <span className='ml-1 text-muted-foreground'>{parameter.unit}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {rule.triggerType === 'date-time' ? (
          <label className='space-y-1.5'>
            <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Date/time</span>
            <div className='relative'>
              <CalendarClock className='pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
              <Input
                type='datetime-local'
                className='pl-8'
                value={toDateTimeInputValue(rule.runAt)}
                onChange={(event) => onUpdate(index, 'runAt', fromDateTimeInputValue(event.target.value))}
              />
            </div>
          </label>
        ) : null}

        {(rule.triggerType === 'time-of-day' || rule.triggerType === 'weekly') ? (
          <label className='space-y-1.5'>
            <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Time</span>
            <div className='relative'>
              <Clock3 className='pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
              <Input
                type='time'
                className='pl-8'
                value={rule.timeOfDay ?? ''}
                onChange={(event) => onUpdate(index, 'timeOfDay', event.target.value)}
              />
            </div>
          </label>
        ) : null}

        {rule.triggerType === 'weekly' ? (
          <div className='space-y-1.5 md:col-span-2'>
            <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Days</span>
            <div className='flex flex-wrap gap-2'>
              {dayOptions.map((day) => {
                const selected = rule.daysOfWeek.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type='button'
                    onClick={() => {
                      const nextDays = selected
                        ? rule.daysOfWeek.filter((value) => value !== day.value)
                        : [...rule.daysOfWeek, day.value].sort();
                      onUpdate(index, 'daysOfWeek', nextDays);
                    }}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                      selected ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {rule.triggerType === 'hourly' ? (
          <label className='space-y-1.5'>
            <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Minute</span>
            <Input
              type='number'
              min={0}
              max={59}
              value={rule.minuteOfHour ?? 0}
              onChange={(event) => onUpdate(index, 'minuteOfHour', Number(event.target.value))}
            />
          </label>
        ) : null}

        <div className='md:col-span-2 xl:col-span-3'>
          <div className='mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground'>Action</div>
          <div className='grid gap-4 md:grid-cols-3'>
            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Target device</span>
              <select
                aria-label={`Automation ${index + 1} target device`}
                className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                value={rule.targetDeviceId}
                onChange={(event) => setTargetDevice(event.target.value)}
              >
                <option value=''>Select device...</option>
                {devices.map((device) => (
                  <option key={device.id} value={device.id}>{device.name}</option>
                ))}
              </select>
            </label>

            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Writable parameter</span>
              <select
                aria-label={`Automation ${index + 1} target parameter`}
                className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                value={rule.targetParameterKey}
                onChange={(event) => setTargetParameter(event.target.value)}
              >
                <option value=''>Select parameter...</option>
                {targetDevice?.writableParameters.map((parameter) => (
                  <option key={parameter.id} value={parameter.id}>
                    {parameter.name} {parameter.unit ? `(${parameter.unit})` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className='space-y-1.5'>
              <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Raw value</span>
              {targetParameter && targetParameter.options.length > 0 ? (
                <select
                  aria-label={`Automation ${index + 1} raw value`}
                  className='flex h-7 w-full rounded-lg border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                  value={rule.rawValue}
                  onChange={(event) => onUpdate(index, 'rawValue', Number(event.target.value))}
                >
                  {targetParameter.options.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <Input
                  type='number'
                  min={0}
                  value={rule.rawValue}
                  onChange={(event) => onUpdate(index, 'rawValue', Number(event.target.value))}
                />
              )}
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}
