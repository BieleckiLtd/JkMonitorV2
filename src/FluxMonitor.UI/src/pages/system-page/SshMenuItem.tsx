import { Terminal } from 'lucide-react';
import { Switch } from '../../components/ui/switch';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import type { SshServiceSnapshot } from './types';

type SshMenuItemProps = {
  sshAccess: SshServiceSnapshot | null;
  sshToggleChecked: boolean;
  sshToggleLoading: boolean;
  onToggle: () => void | Promise<void>;
};

export function SshMenuItem({
  sshAccess,
  sshToggleChecked,
  sshToggleLoading,
  onToggle,
}: SshMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='SSH'
      summary='Remote terminal access.'
      icon={Terminal}
      toggleControl={(
        <Switch
          checked={sshToggleChecked}
          disabled={sshToggleLoading || !(sshAccess?.supported ?? false)}
          onCheckedChange={() => void onToggle()}
          aria-label='Toggle SSH access'
        />
      )}
    />
  );
}
