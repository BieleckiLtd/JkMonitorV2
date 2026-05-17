import { useState } from 'react';
import { LoaderCircle, Mail, MailCheck, Megaphone, MessageCircle, Play, Plus, Save, Send, Trash2, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';
import { cn } from '../lib/utils';
import { useNotificationConfig } from '../hooks/useNotifications';
import type {
  NotificationChannelConfig,
  NtfySettings,
  EmailSettings,
  BrevoSettings,
  TelegramSettings,
} from '../types/notification';

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
    fromName: 'Flux Monitor',
    toAddresses: [],
  } satisfies EmailSettings as unknown as Record<string, unknown>,
});

const defaultBrevoChannel = (): NotificationChannelConfig => ({
  id: generateId(),
  type: 'brevo',
  name: 'New Brevo channel',
  enabled: true,
  settings: {
    apiKey: '',
    fromAddress: '',
    fromName: 'Flux Monitor',
    toAddresses: [],
  } satisfies BrevoSettings as unknown as Record<string, unknown>,
});

const defaultTelegramChannel = (): NotificationChannelConfig => ({
  id: generateId(),
  type: 'telegram',
  name: 'New Telegram channel',
  enabled: true,
  settings: {
    botToken: '',
    chatId: '',
  } satisfies TelegramSettings as unknown as Record<string, unknown>,
});

function getChannelValidationMessage(channels: NotificationChannelConfig[]) {
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    const label = channel.name.trim() ? `Channel "${channel.name.trim()}"` : `Channel ${index + 1}`;

    if (!channel.name.trim()) {
      return `${label}: enter a name.`;
    }

    if (channel.type === 'ntfy') {
      const settings = channel.settings as unknown as NtfySettings;
      if (!settings.baseUrl?.trim()) {
        return `${label}: enter an ntfy base URL.`;
      }

      if (!settings.topic?.trim()) {
        return `${label}: enter an ntfy topic.`;
      }
    }
  }

  return null;
}

function getChannelAppearance(type: NotificationChannelConfig['type']) {
  switch (type) {
    case 'ntfy':
      return { icon: Send, accentClass: 'bg-blue-500/10 text-blue-500' };
    case 'email':
      return { icon: Mail, accentClass: 'bg-sky-500/10 text-sky-600' };
    case 'brevo':
      return { icon: MailCheck, accentClass: 'bg-violet-500/10 text-violet-600' };
    case 'telegram':
      return { icon: MessageCircle, accentClass: 'bg-cyan-500/10 text-cyan-600' };
  }
}

// ── main page ──

export function NotificationsPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const { config, isLoading, error, saveChannels, testChannel } = useNotificationConfig();

  const [channels, setChannels] = useState<NotificationChannelConfig[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [initialized, setInitialized] = useState(false);

  // sync config -> local state once
  if (config && !initialized) {
    setChannels(config.channels);
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
      type === 'ntfy'
        ? defaultNtfyChannel()
        : type === 'email'
          ? defaultEmailChannel()
          : type === 'brevo'
            ? defaultBrevoChannel()
            : defaultTelegramChannel(),
    ]);
    setSaveMsg(null);
  };

  const removeChannel = (index: number) => {
    setChannels((prev) => prev.filter((_, i) => i !== index));
    setSaveMsg(null);
  };

  const handleSaveChannels = async () => {
    const validationMessage = getChannelValidationMessage(channels);
    if (validationMessage) {
      setSaveMsg(validationMessage);
      return;
    }

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
    } catch {
      setTestResults((prev) => ({ ...prev, [channelId]: 'error' }));
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
      {!hideHeader ? (
        <div className='flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between'>
          <div>
            <h2 className='text-3xl font-bold tracking-tight text-foreground'>Notifications</h2>
            <p className='mt-2 text-sm text-muted-foreground'>
              Configure notification delivery channels.
            </p>
          </div>
        </div>
      ) : null}

      {saveMsg ? (
        <div className='rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-foreground'>{saveMsg}</div>
      ) : null}

      {/* ══════ CHANNELS TAB ══════ */}
      <div className='space-y-4'>
          <div className='flex flex-wrap gap-3'>
            <Button variant='outline' onClick={() => addChannel('ntfy')}>
              <Plus className='h-4 w-4' /> Add ntfy channel
            </Button>
            <Button variant='outline' onClick={() => addChannel('email')}>
              <Plus className='h-4 w-4' /> Add email channel
            </Button>
            <Button variant='outline' onClick={() => addChannel('brevo')}>
              <Plus className='h-4 w-4' /> Add Brevo channel
            </Button>
            <Button variant='outline' onClick={() => addChannel('telegram')}>
              <Plus className='h-4 w-4' /> Add Telegram channel
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
              <p className='mt-2 text-sm text-muted-foreground'>Add an ntfy, email, Brevo, or Telegram channel to start sending notifications.</p>
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
                ) : channel.type === 'brevo' ? (
                  <BrevoChannelFields channel={channel} index={index} onUpdate={updateChannelSetting} />
                ) : (
                  <TelegramChannelFields channel={channel} index={index} onUpdate={updateChannelSetting} />
                )}
              </div>
            </section>
            );
          })}
      </div>
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
        <span className='block text-[11px] text-muted-foreground'>Use the ntfy server root URL only, for example <code>https://ntfy.sh</code>, not a topic URL.</span>
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Topic</span>
        <Input value={s.topic ?? ''} onChange={(e) => onUpdate(index, 'topic', e.target.value)} placeholder='FluxMonitor-alerts' />
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
        <Input value={s.fromAddress ?? ''} onChange={(e) => onUpdate(index, 'fromAddress', e.target.value)} placeholder='alerts@FluxMonitor.local' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>From Name</span>
        <Input value={s.fromName ?? 'Flux Monitor'} onChange={(e) => onUpdate(index, 'fromName', e.target.value)} />
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

function BrevoChannelFields({
  channel,
  index,
  onUpdate,
}: {
  channel: NotificationChannelConfig;
  index: number;
  onUpdate: (index: number, key: string, value: unknown) => void;
}) {
  const s = channel.settings as unknown as BrevoSettings;
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
      <div className='rounded-xl border border-border bg-muted/40 px-4 py-3 md:col-span-2 xl:col-span-3'>
        <div className='text-xs font-medium uppercase tracking-widest text-muted-foreground'>Brevo Transactional Email API</div>
        <div className='mt-2 text-sm text-muted-foreground'>Use your Brevo API key to send transactional emails. Find your key in Brevo → SMTP &amp; API.</div>
      </div>
      <label className='space-y-1.5 md:col-span-2 xl:col-span-3'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>API Key</span>
        <Input type='password' value={s.apiKey ?? ''} onChange={(e) => onUpdate(index, 'apiKey', e.target.value)} />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>From Address</span>
        <Input value={s.fromAddress ?? ''} onChange={(e) => onUpdate(index, 'fromAddress', e.target.value)} placeholder='alerts@example.com' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>From Name</span>
        <Input value={s.fromName ?? 'Flux Monitor'} onChange={(e) => onUpdate(index, 'fromName', e.target.value)} />
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

function TelegramChannelFields({
  channel,
  index,
  onUpdate,
}: {
  channel: NotificationChannelConfig;
  index: number;
  onUpdate: (index: number, key: string, value: unknown) => void;
}) {
  const s = channel.settings as unknown as TelegramSettings;

  return (
    <>
      <div className='rounded-xl border border-border bg-muted/40 px-4 py-3 md:col-span-2 xl:col-span-3'>
        <div className='text-xs font-medium uppercase tracking-widest text-muted-foreground'>Telegram Bot API</div>
        <div className='mt-2 text-sm text-muted-foreground'>Create a bot via @BotFather to get a token, then start a chat with the bot and get the chat ID.</div>
      </div>
      <label className='space-y-1.5 md:col-span-2'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Bot Token</span>
        <Input type='password' value={s.botToken ?? ''} onChange={(e) => onUpdate(index, 'botToken', e.target.value)} placeholder='123456:ABC-DEF...' />
      </label>
      <label className='space-y-1.5'>
        <span className='block text-xs font-medium uppercase tracking-widest text-muted-foreground'>Chat ID</span>
        <Input value={s.chatId ?? ''} onChange={(e) => onUpdate(index, 'chatId', e.target.value)} placeholder='-1001234567890' />
        <span className='block text-[11px] text-muted-foreground'>Use a user, group, or channel chat ID. Send a message to the bot first, then call /getUpdates to find the ID.</span>
      </label>
    </>
  );
}
