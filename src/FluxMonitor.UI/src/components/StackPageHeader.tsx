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
    <div className={cn('flex items-center gap-3 rounded-2xl border border-border/70 bg-background/40 px-3 py-2.5', className)}>
      {backTo ? (
        <button
          type='button'
          onClick={() => {
            runWithViewTransition(() => {
              navigate(backTo);
            }, { direction: navigationDirection });
          }}
          className='inline-flex items-center gap-1 rounded-xl px-2 py-1 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
        >
          <ChevronLeft className='h-4 w-4' />
          {backLabel}
        </button>
      ) : Icon ? (
        <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary'>
          <Icon className='h-4 w-4' />
        </div>
      ) : null}

      <div className='min-w-0'>
        <div className='truncate text-sm font-semibold text-foreground'>{title}</div>
        <div className='truncate text-xs text-muted-foreground'>{description}</div>
      </div>
    </div>
  );
}
