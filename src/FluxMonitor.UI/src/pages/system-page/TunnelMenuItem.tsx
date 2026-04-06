import { Cloud, ExternalLink, LoaderCircle } from 'lucide-react';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import type { CloudflareTunnelStatusSnapshot, InlineFeedback } from './types';

type TunnelMenuItemProps = {
  tunnelSectionOpen: boolean;
  cloudflareTunnelLoading: boolean;
  cloudflareTunnelStatus: CloudflareTunnelStatusSnapshot | null;
  cloudflareTunnelError: string | null;
  cloudflareTunnelFeedback: InlineFeedback | null;
  cloudflareTunnelEnabled: boolean;
  cloudflareTunnelSaving: boolean;
  cloudflareTunnelSupported: boolean;
  cloudflareTunnelMaskedToken: string | null;
  cloudflareTunnelTokenOrCommand: string;
  onToggleExpanded: () => void;
  onEnabledChange: (checked: boolean) => void;
  onTokenChange: (value: string) => void;
  onSave: () => void | Promise<void>;
};

export function TunnelMenuItem({
  tunnelSectionOpen,
  cloudflareTunnelLoading,
  cloudflareTunnelStatus,
  cloudflareTunnelError,
  cloudflareTunnelFeedback,
  cloudflareTunnelEnabled,
  cloudflareTunnelSaving,
  cloudflareTunnelSupported,
  cloudflareTunnelMaskedToken,
  cloudflareTunnelTokenOrCommand,
  onToggleExpanded,
  onEnabledChange,
  onTokenChange,
  onSave,
}: TunnelMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='Tunnel'
      summary='Access over the internet'
      icon={Cloud}
      expanded={tunnelSectionOpen}
      onToggleExpanded={onToggleExpanded}
      expandButtonLabel={{
        collapsed: 'Expand tunnel details',
        expanded: 'Collapse tunnel details',
      }}
      toggleControl={(
        <Switch
          checked={cloudflareTunnelEnabled}
          disabled={cloudflareTunnelSaving || !cloudflareTunnelSupported}
          onCheckedChange={onEnabledChange}
          aria-label='Toggle Tunnel'
        />
      )}
    >
      {cloudflareTunnelLoading && !cloudflareTunnelStatus ? (
        <div className='flex items-center justify-center py-6'>
          <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
        </div>
      ) : (
        <>
          {cloudflareTunnelError ? (
            <div className='system-feedback system-feedback-error'>
              {cloudflareTunnelError}
            </div>
          ) : null}

          {cloudflareTunnelFeedback ? (
            <div className={cn(
              'system-feedback',
              cloudflareTunnelFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
            )}>
              {cloudflareTunnelFeedback.message}
            </div>
          ) : null}

          {!cloudflareTunnelSupported ? (
            <div className='system-empty-state'>
              {cloudflareTunnelStatus?.statusMessage ?? 'Cloudflare Tunnel is unavailable on this host.'}
            </div>
          ) : (
            <>
              <div className='system-panel-surface bg-background/35'>
                <div className='text-sm font-semibold text-foreground'>How it works</div>
                <div className='mt-3 space-y-1 font-mono text-sm text-muted-foreground'>
                  <div>Your browser eg. on the phone</div>
                  <div>↓</div>
                  <div>Cloudflare (login + protection)</div>
                  <div>↓</div>
                  <div>Tunnel (secure pipe)</div>
                  <div>↓</div>
                  <div>Flux Monitor app on Raspberry Pi</div>
                </div>
                <div className='mt-3 text-xs text-muted-foreground'>
                  This exposes Flux Monitor to the internet on your own hostname or on a Cloudflare URL such as{' '}
                  <span className='font-mono text-foreground'>random-name.trycloudflare.com</span>. Because it is reachable from outside your home network, add a Cloudflare login wall first.
                </div>
              </div>

              <div className='system-panel-surface bg-background/35'>
                <div className='text-sm font-semibold text-foreground'>Cloudflare setup</div>
                <div className='mt-3 space-y-2 text-sm text-muted-foreground'>
                  <div>1. In Cloudflare Tunnel, create a tunnel and copy the command or token shown on the connector page.</div>
                  <div>2. In Published applications, choose your hostname. Use your own domain if you have one. If you use a temporary Cloudflare URL, that is configured on the Cloudflare side, not here in Flux Monitor.</div>
                  <div>3. Leave Path empty unless you only want to expose part of the app.</div>
                  <div>4. Set Service Type to <span className='font-mono text-foreground'>HTTP</span>.</div>
                  <div>5. Set URL to <span className='font-mono text-foreground'>127.0.0.1:5074</span> or <span className='font-mono text-foreground'>localhost:5074</span>.</div>
                </div>
                <div className='mt-3 flex flex-wrap gap-3 text-sm'>
                  <a
                    href='https://developers.cloudflare.com/tunnel/setup/'
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center gap-2 text-primary hover:underline'
                  >
                    <ExternalLink className='h-4 w-4' />
                    Open Tunnel hostname docs
                  </a>
                  <a
                    href='https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/'
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center gap-2 text-primary hover:underline'
                  >
                    <ExternalLink className='h-4 w-4' />
                    Open connector setup docs
                  </a>
                </div>
              </div>

              <div className='rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-4'>
                <div className='text-sm font-semibold text-foreground'>Protect it with Cloudflare Access</div>
                <div className='mt-3 space-y-2 text-sm text-amber-50/90'>
                  <div>Access → Applications</div>
                  <div>Add application</div>
                  <div>Enter your hostname</div>
                  <div>Add policy: Allow → Emails → your@email.com</div>
                  <div>Choose login method: OTP or Google</div>
                </div>
                <div className='mt-3 text-xs text-amber-100/80'>
                  OTP is the simplest option if you already use one-time email codes. This puts a login wall in front of the app before traffic reaches your Raspberry Pi.
                </div>
                <div className='mt-3'>
                  <a
                    href='https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/'
                    target='_blank'
                    rel='noreferrer'
                    className='inline-flex items-center gap-2 text-sm text-amber-100 hover:underline'
                  >
                    <ExternalLink className='h-4 w-4' />
                    Open Access application docs
                  </a>
                </div>
              </div>

              <div className='space-y-2'>
                <label className='system-input-label' htmlFor='cloudflare-token'>
                  Tunnel token or Cloudflare command
                </label>
                <textarea
                  id='cloudflare-token'
                  value={cloudflareTunnelTokenOrCommand}
                  onChange={(event) => onTokenChange(event.target.value)}
                  placeholder={cloudflareTunnelMaskedToken
                    ? `Leave blank to keep the saved token (${cloudflareTunnelMaskedToken}).`
                    : 'Paste the cloudflared install command, run command, or the raw tunnel token.'}
                  disabled={cloudflareTunnelSaving || !cloudflareTunnelSupported}
                  className='min-h-24 w-full rounded-xl border border-input bg-background/70 px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
                />
                <div className='text-xs text-muted-foreground'>
                  Flux Monitor extracts the token automatically if you paste a command copied from the Cloudflare page.
                </div>
              </div>

              <div className='flex justify-end'>
                <button
                  type='button'
                  disabled={cloudflareTunnelSaving || !cloudflareTunnelSupported}
                  onClick={() => void onSave()}
                  className='system-button-primary'
                >
                  {cloudflareTunnelSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Cloud className='h-4 w-4' />}
                  Save tunnel settings
                </button>
              </div>
            </>
          )}
        </>
      )}
    </ConnectivityMenuItem>
  );
}
