import { SquareTerminal } from 'lucide-react';
import { Switch } from '../../components/ui/switch';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';
import type { WebTerminalSnapshot } from './types';

type WebTerminalMenuItemProps = {
  terminalAccess: WebTerminalSnapshot | null;
  terminalToggleLoading: boolean;
  onToggle: () => void | Promise<void>;
};

export function WebTerminalMenuItem({
  terminalAccess,
  terminalToggleLoading,
  onToggle,
}: WebTerminalMenuItemProps) {
  return (
    <ConnectivityMenuItem
      title='Web terminal'
      summary='Browser shell access.'
      icon={SquareTerminal}
      toggleControl={(
        <Switch
          checked={terminalAccess?.enabled ?? false}
          disabled={terminalToggleLoading || !(terminalAccess?.supported ?? false)}
          onCheckedChange={() => void onToggle()}
          aria-label='Toggle web terminal access'
        />
      )}
    />
  );
}
