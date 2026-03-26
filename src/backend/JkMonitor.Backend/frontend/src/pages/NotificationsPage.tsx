import { useState } from 'react';
import { Bell, Hash, LoaderCircle, Mail, Megaphone, MessageCircle, Play, Plus, Save, Send, Trash2, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { useNotificationConfig, useNotificationLog, useNotificationMetadata } from '../hooks/useNotifications';
import type { NotificationChannelConfig, NotificationRuleConfig, NtfySettings, EmailSettings, WhatsAppSettings } from '../types/notification';

// ── helpers ──

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

const defaultNtfyChannel = (): NotificationChannelConfig => ({
  id: generateId(),
  type: 'ntfy',
  name: 'New ntfy channel',
  enabled: true,
  settings: { baseUrl: 'https://ntfy.sh', topic: '', accessToken: '', priority: 3 } satisfies NtfySettings as unknown as Record<string, unknown>,
});

const defaultEmailChannel = (): NotificationChannelConfig => ({
  id: generateId(),
  type: 'email',
  name: 'New email channel',
  enabled: true,
  settings: {
    host: 'smtp.gmail.com',
    port: 587,
    useSsl: true,
    username: '',
    password: '',
    fromAddress: '',
    fromName: 'JK Monitor',
    toAddresses: [],
  } satisfies EmailSettings as unknown as Record<string, unknown>,
});

const defaultWhatsAppChannel = (): NotificationChannelConfig => ({
  id: generateId(),
  type: 'whatsapp',
  name: 'New WhatsApp channel',
  enabled: true,
  settings: {
    apiVersion: 'v22.0',
    phoneNumberId: '',
    recipientNumber: '',
    accessToken: '',
    previewUrl: false,
  } satisfies WhatsAppSettings as unknown as Record<string, unknown>,
});

const defaultRule = (): NotificationRuleConfig => ({
  id: generateId(),
  name: 'New rule',
  enabled: true,
  deviceId: '',
  entityId: 'state_of_charge',
  expression: 'value == 100',
  channelIds: [],
  messageTemplate: '{name}: {entity} is {value} on {device}',
  severity: 'info',
  cooldownMinutes: 15,
});

function getChannelAppearance(type: NotificationChannelConfig['type']) {
  switch (type) {
    case 'ntfy':
      return { icon: Send, accentClass: 'bg-blue-500/10 text-blue-500' };
    case 'email':
      return { icon: Mail, accentClass: 'bg-sky-500/10 text-sky-600' };
    case 'whatsapp':
      return { icon: MessageCircle, accentClass: 'bg-emerald-500/10 text-emerald-600' };
  }
}

// ── tab button ──

type Tab = 'channels' | 'rules' | 'log';

function TabButton({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: React.ElementType; onClick: () => void }) {
  return (
    <button
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

// ── main page ──

export function NotificationsPage() {
  const { config, isLoading, error, saveChannels, saveRules, testChannel } = useNotificationConfig();
  const { log } = useNotificationLog();
  const { entities, devices } = useNotificationMetadata();
  const [tab, setTab] = useState<Tab>('channels');

  const [channels, setChannels] = useState<NotificationChannelConfig[]>([]);
  const [rules, setRules] = useState<NotificationRuleConfig[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [initialized, setInitialized] = useState(false);

  // sync config -> local state once
  if (config && !initialized) {
    setChannels(config.channels);
    setRules(config.rules);
    setInitialized(true);
  }

  // ── channel helpers ──

  const updateChannelSetting = (index: number, key: string, value: unknown) => {
    setChannels((prev) =>
      prev.map((ch, i) => (i === index ? { ...ch, settings: { ...ch.settings, [key]: value } } : ch)),
    );
    setSaveMsg(null);
  };

  const updateChannel = <K extends keyof NotificationChannelConfig>(index: number, key: K, value: NotificationChannelConfig[K]) => {
    setChannels((prev) => prev.map((ch, i) => (i === index ? { ...ch, [key]: value } : ch)));
    setSaveMsg(null);
  };

  const addChannel = (type: NotificationChannelConfig['type']) => {
    setChannels((prev) => [
      ...prev,
      type === 'ntfy' ? defaultNtfyChannel() : type === 'email' ? defaultEmailChannel() : defaultWhatsAppChannel(),
    ]);
    setSaveMsg(null);
  };

  const removeChannel = (index: number) => {
    setChannels((prev) => prev.filter((_, i) => i !== index));
    setSaveMsg(null);
  };

  const handleSaveChannels = async () => {
    setIsSaving(true);
    setSaveMsg(null);
    try {
      await saveChannels(channels);
      setSaveMsg('Channels saved.');
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to save channels.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestChannel = async (channelId: string) => {
    setTestResults((prev) => ({ ...prev, [channelId]: 'sending...' }));
    try {
      const result = await testChannel(channelId);
      setTestResults((prev) => ({ ...prev, [channelId]: result.success ? 'sent!' : `failed: ${result.error}` }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [channelId]: 'error' }));
    }
  };

  // ── rule helpers ──

  const updateRule = <K extends keyof NotificationRuleConfig>(index: number, key: K, value: NotificationRuleConfig[K]) => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, [key]: value } : r)));
    setSaveMsg(null);
  };

  const toggleRuleChannel = (ruleIndex: number, channelId: string) => {
    setRules((prev) =>
      prev.map((r, i) => {
        if (i !== ruleIndex) return r;
        const has = r.channelIds.includes(channelId);
        return { ...r, channelIds: has ? r.channelIds.filter((c) => c !== channelId) : [...r.channelIds, channelId] };
      }),
    );
    setSaveMsg(null);
  };

  const addRule = () => {
    setRules((prev) => [...prev, defaultRule()]);
    setSaveMsg(null);
  };

  const removeRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
    setSaveMsg(null);
  };

  const handleSaveRules = async () => {
    setIsSaving(true);
    setSaveMsg(null);
    try {
      await saveRules(rules);
      setSaveMsg('Rules saved and active — no restart required.');
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'Failed to save rules.');
    } finally {
      setIsSaving(false);
    }
  };

  // ── render ──

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
    <div className='space-y-6 max-w-6xl mx-auto pb-12'>
      {/* header */}
      <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
        <div>
          <h2 className='text-3xl font-bold tracking-tight text-foreground'>Notifications</h2>
          <p className='mt-2 text-sm text-muted-foreground'>
            Configure notification channels and rules. Use NCalc expressions for flexible triggers.
          </p>
        </div>
      </div>

      {/* tabs */}
      <div className='flex gap-2 rounded-xl border border-border bg-card/60 p-2'>
        <TabButton active={tab === 'channels'} label='Channels' icon={Megaphone} onClick={() => setTab('channels')} />
        <TabButton active={tab === 'rules'} label='Rules' icon={Bell} onClick={() => setTab('rules')} />
        <TabButton active={tab === 'log'} label='History' icon={Hash} onClick={() => setTab('log')} />
      </div>

      {saveMsg ? (
        <div className='rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-foreground'>{saveMsg}</div>
      ) : null}

      {/* ══════ CHANNELS TAB ══════ */}
      {tab === 'channels' ? (
        <div className='space-y-4'>
          <div className='flex flex-wrap gap-3'>
            <Button variant='outline' onClick={() => addChannel('ntfy')}>
              <Plus className='h-4 w-4' /> Add ntfy channel
            </Button>
            <Button variant='outline' onClick={() => addChannel('email')}>
              <Plus className='h-4 w-4' /> Add email channel
            </Button>
            <Button variant='outline' onClick={() => addChannel('whatsapp')}>
              <Plus className='h-4 w-4' /> Add WhatsApp channel
            </Button>
            <Button onClick={handleSaveChannels} disabled={isSaving}>
              {isSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Save className='h-4 w-4' />}
              Save channels
            </Button>
          </div>

          {channels.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <Megaphone className='mx-auto h-10 w-10 text-muted-foreground/50' />
              <div className='mt-4 text-lg font-semibold text-foreground'>No channels configured</div>
              <p className='mt-2 text-sm text-muted-foreground'>Add an ntfy, email, or WhatsApp channel to start sending notifications.</p>
            </div>
          ) : null}

          {channels.map((channel, index) => {
            const appearance = getChannelAppearance(channel.type);
            const Icon = appearance.icon;

            return (
            <section key={channel.id} className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
              <div className='mb-4 flex items-center justify-between border-b border-border pb-3'>
                <div className='flex items-center gap-3'>
                  <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', appearance.accentClass)}>
                    <Icon className='h-4 w-4' />
                  </div>
                  <div>
                    <div className='text-sm font-semibold text-foreground'>{channel.name || 'Unnamed channel'}</div>
                    <Badge variant='outline' className='mt-0.5 text-[10px]'>
                      {channel.type}
                    </Badge>
                  </div>
                </div>
                <div className='flex items-center gap-2'>
                  <Switch checked={channel.enabled} onCheckedChange={(checked) => updateChannel(index, 'enabled', checked)} />
                  <Button variant='outline' size='sm' onClick={() => void handleTestChannel(channel.id)}>
                    <Play className='h-3 w-3' /> Test
                  </Button>
                  <Button variant='destructive' size='sm' onClick={() => removeChannel(index)}>
                    <Trash2 className='h-3 w-3' />
                  </Button>
                </div>
              </div>

              {testResults[channel.id] ? (
                <div className='mb-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground'>
                  Test: {testResults[channel.id]}
                </div>
              ) : null}

              <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
                <label className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Name</span>
                  <Input value={channel.name} onChange={(e) => updateChannel(index, 'name', e.target.value)} />
                </label>

                {channel.type === 'ntfy' ? (
                  <NtfyChannelFields channel={channel} index={index} onUpdate={updateChannelSetting} />
                ) : channel.type === 'email' ? (
                  <EmailChannelFields channel={channel} index={index} onUpdate={updateChannelSetting} />
                ) : (
                  <WhatsAppChannelFields channel={channel} index={index} onUpdate={updateChannelSetting} />
                )}
              </div>
            </section>
            );
          })}
        </div>
      ) : null}

      {/* ══════ RULES TAB ══════ */}
      {tab === 'rules' ? (
        <div className='space-y-4'>
          <div className='flex flex-wrap gap-3'>
            <Button variant='outline' onClick={addRule}>
              <Plus className='h-4 w-4' /> Add rule
            </Button>
            <Button onClick={handleSaveRules} disabled={isSaving}>
              {isSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Save className='h-4 w-4' />}
              Save rules
            </Button>
          </div>

          {/* expression help */}
          <div className='rounded-xl border border-border bg-muted/30 px-4 py-3'>
            <div className='text-xs font-semibold uppercase tracking-widest text-muted-foreground'>Expression help</div>
            <div className='mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2'>
              <div><code className='text-foreground'>value == 100</code> — SOC reaches 100%</div>
              <div><code className='text-foreground'>value &lt; 10</code> — below threshold</div>
              <div><code className='text-foreground'>prev &gt;= 90 &amp;&amp; value == 100</code> — transition from ≥90 to 100</div>
              <div><code className='text-foreground'>value == 50</code> — equals 50 (any direction)</div>
              <div><code className='text-foreground'>Abs(value - prev) &gt; 5</code> — change &gt; 5</div>
              <div><code className='text-foreground'>soc &lt; 20 &amp;&amp; current &lt; 0</code> — low SOC while discharging</div>
            </div>
            <div className='mt-2 text-[11px] text-muted-foreground'>
              Variables: <code>value</code>, <code>prev</code> (previous value of the observed entity), plus all snapshot fields (
              <code>soc</code>, <code>total_voltage</code>, <code>current</code>, <code>power</code>, <code>mos_temperature</code>, etc.)
            </div>
          </div>

          {rules.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <Bell className='mx-auto h-10 w-10 text-muted-foreground/50' />
              <div className='mt-4 text-lg font-semibold text-foreground'>No rules configured</div>
              <p className='mt-2 text-sm text-muted-foreground'>Create a rule to get notified when entity values match an expression.</p>
            </div>
          ) : null}

          {rules.map((rule, index) => (
            <section key={rule.id} className='rounded-2xl border border-border bg-card/70 p-5 shadow-sm'>
              <div className='mb-4 flex items-center justify-between border-b border-border pb-3'>
                <div className='flex items-center gap-3'>
                  <Bell className='h-5 w-5 text-primary' />
                  <span className='text-sm font-semibold text-foreground'>{rule.name || 'Unnamed rule'}</span>
                </div>
                <div className='flex items-center gap-2'>
                  <Switch checked={rule.enabled} onCheckedChange={(checked) => updateRule(index, 'enabled', checked)} />
                  <Button variant='destructive' size='sm' onClick={() => removeRule(index)}>
                    <Trash2 className='h-3 w-3' />
                  </Button>
                </div>
              </div>

              <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
                <label className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Name</span>
                  <Input value={rule.name} onChange={(e) => updateRule(index, 'name', e.target.value)} />
                </label>

                <label className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Device</span>
                  <select
                    className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                    value={rule.deviceId}
                    onChange={(e) => updateRule(index, 'deviceId', e.target.value)}
                  >
                    <option value=''>Select device...</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Entity</span>
                  <select
                    className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                    value={rule.entityId}
                    onChange={(e) => updateRule(index, 'entityId', e.target.value)}
                  >
                    <option value=''>Select entity...</option>
                    {entities.map((en) => (
                      <option key={en.id} value={en.id}>
                        {en.name} {en.unit ? `(${en.unit})` : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className='space-y-1.5 md:col-span-2 xl:col-span-3'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Expression (NCalc)</span>
                  <Input
                    className='font-mono text-sm'
                    value={rule.expression}
                    onChange={(e) => updateRule(index, 'expression', e.target.value)}
                    placeholder='value == 100 or prev >= 90 && value == 100'
                  />
                </label>

                <label className='space-y-1.5 md:col-span-2 xl:col-span-3'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Message template</span>
                  <Input
                    value={rule.messageTemplate}
                    onChange={(e) => updateRule(index, 'messageTemplate', e.target.value)}
                    placeholder='{name}: {entity} is {value} on {device}'
                  />
                  <span className='block text-[11px] text-muted-foreground'>
                    Placeholders: {'{value}'}, {'{prev}'}, {'{device}'}, {'{deviceId}'}, {'{entity}'}, {'{name}'}, {'{severity}'}
                  </span>
                </label>

                <label className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Severity</span>
                  <select
                    className='flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
                    value={rule.severity}
                    onChange={(e) => updateRule(index, 'severity', e.target.value as NotificationRuleConfig['severity'])}
                  >
                    <option value='info'>Info</option>
                    <option value='warning'>Warning</option>
                    <option value='critical'>Critical</option>
                  </select>
                </label>

                <label className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Cooldown (minutes)</span>
                  <Input
                    type='number'
                    min={0}
                    value={rule.cooldownMinutes}
                    onChange={(e) => updateRule(index, 'cooldownMinutes', Number(e.target.value))}
                  />
                </label>

                <div className='space-y-1.5'>
                  <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Channels</span>
                  <div className='flex flex-wrap gap-2 pt-1'>
                    {channels.length === 0 ? (
                      <span className='text-xs text-muted-foreground'>No channels configured yet.</span>
                    ) : null}
                    {channels.map((ch) => {
                      const selected = rule.channelIds.includes(ch.id);
                      const ChannelIcon = getChannelAppearance(ch.type).icon;
                      return (
                        <button
                          key={ch.id}
                          type='button'
                          onClick={() => toggleRuleChannel(index, ch.id)}
                          className={cn(
                            'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
                            selected
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-border text-muted-foreground hover:bg-muted',
                          )}
                        >
                          <ChannelIcon className='mr-1 inline h-3 w-3' />
                          {ch.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {/* ══════ LOG TAB ══════ */}
      {tab === 'log' ? (
        <div className='space-y-4'>
          {log.length === 0 ? (
            <div className='rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center'>
              <Hash className='mx-auto h-10 w-10 text-muted-foreground/50' />
              <div className='mt-4 text-lg font-semibold text-foreground'>No notifications fired yet</div>
              <p className='mt-2 text-sm text-muted-foreground'>Notifications will appear here once rules trigger.</p>
            </div>
          ) : null}

          {log.map((entry, index) => (
            <div key={index} className='rounded-xl border border-border bg-card/70 p-4 shadow-sm'>
              <div className='flex items-center justify-between'>
                <div className='flex items-center gap-2'>
                  <Badge
                    variant={entry.severity === 'critical' ? 'destructive' : 'default'}
                    className='text-[10px]'
                  >
                    {entry.severity}
                  </Badge>
                  <span className='text-sm font-medium text-foreground'>{entry.ruleName}</span>
                  {entry.ruleId.startsWith('system:') ? (
                    <Badge variant='outline' className='text-[10px]'>system</Badge>
                  ) : null}
                </div>
                <span className='text-xs text-muted-foreground'>
                  {new Date(entry.firedAt).toLocaleString()}
                </span>
              </div>
              <div className='mt-2 text-sm text-muted-foreground'>{entry.message}</div>
              {entry.value != null ? (
                <div className='mt-1 text-xs text-muted-foreground'>
                  value={entry.value}{entry.previousValue != null ? `, prev=${entry.previousValue}` : ''}
                </div>
              ) : null}
              <div className='mt-2 flex flex-wrap gap-1'>
                {entry.channelResults.map((r, ci) => (
                  <span key={ci} className='rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground'>{r}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── ntfy channel fields ──

function NtfyChannelFields({
  channel,
  index,
  onUpdate,
}: {
  channel: NotificationChannelConfig;
  index: number;
  onUpdate: (index: number, key: string, value: unknown) => void;
}) {
  const s = channel.settings as unknown as NtfySettings;
  return (
    <>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Base URL</span>
        <Input value={s.baseUrl ?? ''} onChange={(e) => onUpdate(index, 'baseUrl', e.target.value)} placeholder='https://ntfy.sh' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Topic</span>
        <Input value={s.topic ?? ''} onChange={(e) => onUpdate(index, 'topic', e.target.value)} placeholder='jkmonitor-alerts' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Access Token (optional)</span>
        <Input
          type='password'
          value={s.accessToken ?? ''}
          onChange={(e) => onUpdate(index, 'accessToken', e.target.value || null)}
        />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Priority (1-5)</span>
        <Input type='number' min={1} max={5} value={s.priority ?? 3} onChange={(e) => onUpdate(index, 'priority', Number(e.target.value))} />
      </label>
    </>
  );
}

// ── email channel fields ──

function EmailChannelFields({
  channel,
  index,
  onUpdate,
}: {
  channel: NotificationChannelConfig;
  index: number;
  onUpdate: (index: number, key: string, value: unknown) => void;
}) {
  const s = channel.settings as unknown as EmailSettings;
  const [toInput, setToInput] = useState('');

  const addRecipient = () => {
    const email = toInput.trim();
    if (email && !(s.toAddresses ?? []).includes(email)) {
      onUpdate(index, 'toAddresses', [...(s.toAddresses ?? []), email]);
      setToInput('');
    }
  };

  const removeRecipient = (email: string) => {
    onUpdate(index, 'toAddresses', (s.toAddresses ?? []).filter((a: string) => a !== email));
  };

  return (
    <>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>SMTP Host</span>
        <Input value={s.host ?? ''} onChange={(e) => onUpdate(index, 'host', e.target.value)} placeholder='smtp.gmail.com' />
        <span className='block text-[11px] text-muted-foreground'>Works with Gmail, Brevo, SendGrid, Mailgun, or any SMTP relay.</span>
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Port</span>
        <Input type='number' value={s.port ?? 587} onChange={(e) => onUpdate(index, 'port', Number(e.target.value))} />
      </label>
      <div className='rounded-xl border border-border bg-muted/40 px-4 py-3'>
        <div className='text-xs font-medium uppercase tracking-widest text-muted-foreground'>Use SSL/TLS</div>
        <div className='mt-2 flex items-center justify-between'>
          <span className='text-sm text-foreground'>StartTLS (recommended)</span>
          <Switch checked={s.useSsl ?? true} onCheckedChange={(checked) => onUpdate(index, 'useSsl', checked)} />
        </div>
      </div>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Username</span>
        <Input value={s.username ?? ''} onChange={(e) => onUpdate(index, 'username', e.target.value)} />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Password / App Password</span>
        <Input type='password' value={s.password ?? ''} onChange={(e) => onUpdate(index, 'password', e.target.value)} />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>From Address</span>
        <Input value={s.fromAddress ?? ''} onChange={(e) => onUpdate(index, 'fromAddress', e.target.value)} placeholder='alerts@jkmonitor.local' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>From Name</span>
        <Input value={s.fromName ?? 'JK Monitor'} onChange={(e) => onUpdate(index, 'fromName', e.target.value)} />
      </label>
      <div className='space-y-1.5 md:col-span-2 xl:col-span-3'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Recipients</span>
        <div className='flex gap-2'>
          <Input
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addRecipient();
              }
            }}
            placeholder='recipient@example.com'
          />
          <Button type='button' variant='outline' onClick={addRecipient}>
            <Plus className='h-4 w-4' />
          </Button>
        </div>
        <div className='flex flex-wrap gap-1.5 pt-1'>
          {(s.toAddresses ?? []).map((addr: string) => (
            <span key={addr} className='inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-foreground'>
              {addr}
              <button type='button' onClick={() => removeRecipient(addr)} className='text-muted-foreground hover:text-foreground'>
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function WhatsAppChannelFields({
  channel,
  index,
  onUpdate,
}: {
  channel: NotificationChannelConfig;
  index: number;
  onUpdate: (index: number, key: string, value: unknown) => void;
}) {
  const s = channel.settings as unknown as WhatsAppSettings;

  return (
    <>
      <div className='rounded-xl border border-border bg-muted/40 px-4 py-3 md:col-span-2 xl:col-span-3'>
        <div className='text-xs font-medium uppercase tracking-widest text-muted-foreground'>Meta WhatsApp Cloud API</div>
        <div className='mt-2 text-sm text-muted-foreground'>Use a phone number ID and access token from your Meta app. Create one channel per recipient number.</div>
      </div>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>API Version</span>
        <Input value={s.apiVersion ?? 'v22.0'} onChange={(e) => onUpdate(index, 'apiVersion', e.target.value)} placeholder='v22.0' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Phone Number ID</span>
        <Input value={s.phoneNumberId ?? ''} onChange={(e) => onUpdate(index, 'phoneNumberId', e.target.value)} placeholder='123456789012345' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Recipient Number</span>
        <Input value={s.recipientNumber ?? ''} onChange={(e) => onUpdate(index, 'recipientNumber', e.target.value)} placeholder='+447700900123' />
        <span className='block text-[11px] text-muted-foreground'>Enter the destination number in international format. Spaces and punctuation are ignored on send.</span>
      </label>
      <label className='space-y-1.5 md:col-span-2 xl:col-span-2'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Access Token</span>
        <Input type='password' value={s.accessToken ?? ''} onChange={(e) => onUpdate(index, 'accessToken', e.target.value)} />
      </label>
      <div className='rounded-xl border border-border bg-muted/40 px-4 py-3'>
        <div className='text-xs font-medium uppercase tracking-widest text-muted-foreground'>Preview URL</div>
        <div className='mt-2 flex items-center justify-between'>
          <span className='text-sm text-foreground'>Enable WhatsApp link previews</span>
          <Switch checked={s.previewUrl ?? false} onCheckedChange={(checked) => onUpdate(index, 'previewUrl', checked)} />
        </div>
      </div>
    </>
  );
}
