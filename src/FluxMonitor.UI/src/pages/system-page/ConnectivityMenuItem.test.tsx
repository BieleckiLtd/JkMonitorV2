import { render } from '@testing-library/react';
import { Bluetooth } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Switch } from '../../components/ui/switch';
import { ConnectivityMenuItem } from './ConnectivityMenuItem';

describe('ConnectivityMenuItem', () => {
  it('keeps a chevron spacer when a row has a toggle but no expand action', () => {
    const { container } = render(
      <ConnectivityMenuItem
        title='SSH'
        summary='Remote terminal access.'
        icon={Bluetooth}
        toggleControl={<Switch aria-label='Toggle SSH access' checked={false} onCheckedChange={() => undefined} />}
      />
    );

    const spacer = container.querySelector('.system-menu-card-chevron[aria-hidden="true"]');

    expect(spacer).not.toBeNull();
    expect(container.querySelector('.system-menu-card-chevron[aria-expanded]')).toBeNull();
  });

  it('uses a visible border for the unchecked switch track', () => {
    const { container } = render(
      <Switch aria-label='Demo switch' checked={false} onCheckedChange={() => undefined} />
    );

    const switchRoot = container.querySelector('[data-slot="switch"]');
    if (!switchRoot) {
      throw new Error('Expected switch root to render.');
    }

    expect(switchRoot.className).toContain('data-unchecked:border-foreground/35');
  });
});