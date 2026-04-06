import { LoaderCircle } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { Card, CardContent } from '../../components/ui/card';
import type { SystemInterfacesResponse } from './types';

type HardwareInterfacesSectionProps = {
  interfaces: SystemInterfacesResponse | null;
};

export function HardwareInterfacesSection({ interfaces }: HardwareInterfacesSectionProps) {
  return (
    <Card className='system-section-card'>
      <PanelHeader
        title='Hardware interfaces'
        description='Serial ports and block devices detected on this host.'
      />
      <CardContent className='space-y-4 pt-5'>
        {interfaces ? (
          <>
            {interfaces.serialPorts.length > 0 ? (
              <div className='space-y-2'>
                <div className='system-label'>Serial ports</div>
                {interfaces.serialPorts.map((port) => (
                  <div key={port.name} className='system-detail-tile'>
                    <div className='font-mono text-sm font-semibold text-foreground'>{port.name}</div>
                    {port.description ? <div className='mt-1 text-xs text-muted-foreground'>{port.description}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className='system-empty-state text-center'>
                No serial ports detected.
              </div>
            )}

            {interfaces.blockDevices.length > 0 ? (
              <div className='space-y-2'>
                <div className='system-label'>Block devices</div>
                {interfaces.blockDevices.map((device) => (
                  <div key={device.name} className='system-detail-tile'>
                    <div className='flex flex-wrap items-center justify-between gap-2'>
                      <div className='min-w-0 break-all font-mono text-sm font-semibold text-foreground'>{device.name}</div>
                      <div className='text-xs text-muted-foreground'>{device.sizeFormatted}</div>
                    </div>
                    {device.model ? <div className='mt-1 text-xs text-muted-foreground'>{device.model}</div> : null}
                    {device.readOnly ? <div className='mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-400'>Read-only</div> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <div className='flex items-center justify-center py-6'>
            <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
