import { ChevronLeft, type LucideIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { cn } from '../lib/utils';
import { runWithViewTransition, type ViewTransitionDirection } from '../lib/viewTransitions';

type StackPageHeaderProps = {
  title: string;
  description: string;
  backTo?: string;
  backLabel?: string;
  navigationDirection?: ViewTransitionDirection;
  icon?: LucideIcon;
  className?: string;
};

export function StackPageHeader({
  title,
  description,
  backTo,
  backLabel = 'Back',
  navigationDirection = 'back',
  icon: Icon,
  className,
}: StackPageHeaderProps) {
  const navigate = useNavigate();

  return (
    <div
      data-slot='stack-page-header'
      className={cn('flex items-center gap-3 border-b border-white/5 px-1 py-3', className)}
    >
      {backTo ? (
        <button
          data-slot='stack-page-header-back'
          type='button'
          onClick={() => {
            runWithViewTransition(() => {
              navigate(backTo);
            }, { direction: navigationDirection });
          }}
          className='inline-flex items-center gap-1 px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground'
        >
          <ChevronLeft className='h-4 w-4' />
          {backLabel}
        </button>
      ) : Icon ? (
        <div className='flex h-8 w-8 shrink-0 items-center justify-center bg-white/5 text-primary'>
          <Icon className='h-4 w-4' />
        </div>
      ) : null}

      <div className='min-w-0'>
        <div data-slot='stack-page-header-title' className='truncate font-mono text-xs font-bold uppercase tracking-wider text-foreground'>{title}</div>
        <div data-slot='stack-page-header-description' className='truncate font-mono text-[9px] uppercase tracking-tighter text-muted-foreground'>{description}</div>
      </div>
    </div>
  );
}
