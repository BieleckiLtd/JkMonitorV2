import { type ReactNode } from 'react';
import { CardDescription, CardHeader, CardTitle } from './ui/card';
import { cn } from '../lib/utils';

export function PanelHeader({
  title,
  description,
  aside,
  className,
  bordered = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  className?: string;
  bordered?: boolean;
}) {
  return (
    <CardHeader className={cn(bordered ? 'border-b border-border/60 pb-4' : 'pb-4', className)}>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between'>
        <div className='min-w-0 space-y-1'>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {aside ? <div className='flex shrink-0 items-start gap-3 sm:pl-3'>{aside}</div> : null}
      </div>
    </CardHeader>
  );
}
