import { ChevronRight } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { primaryNavigationItems, isPrimaryNavigationItemActive, type PrimaryNavigationItem } from '../lib/navigation';
import { cn } from '../lib/utils';
import { runWithViewTransition } from '../lib/viewTransitions';

export function PrimaryNavigationPanel({ className }: { className?: string }) {
  const location = useLocation();

  return (
    <nav
      aria-label='Primary navigation'
      className={cn('border border-border/70 bg-card/85 shadow-sm backdrop-blur-sm', className)}
    >
      <div className='flex items-center justify-between px-4 pt-4 pb-3'>
        <span className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>NAVIGATION</span>
        <span className='border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>
          {primaryNavigationItems.length}_LIVE
        </span>
      </div>

      <div>
        {primaryNavigationItems.map((item, index) => (
          <PrimaryNavigationLink
            key={item.path}
            item={item}
            isActive={isPrimaryNavigationItemActive(item.path, location.pathname)}
            isExactMatch={location.pathname === item.path}
            isLast={index === primaryNavigationItems.length - 1}
          />
        ))}
      </div>
    </nav>
  );
}

export function PrimaryNavigationEmptyState({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex min-h-[22rem] flex-col justify-center space-y-3 rounded-[inherit] p-6 md:min-h-[28rem] md:p-8',
        className,
      )}
    >
      <div className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>
        Workspace
      </div>
      <div className='font-mono text-2xl font-bold tracking-tight text-foreground md:text-[2rem]'>
        Open a section
      </div>
      <p className='max-w-2xl font-mono text-xs leading-6 text-muted-foreground'>
        At tablet width and above, the selected route opens in this right-side workspace so the main menu stays visible.
      </p>
    </div>
  );
}

function PrimaryNavigationLink({
  item,
  isActive,
  isExactMatch,
  isLast,
}: {
  item: PrimaryNavigationItem;
  isActive: boolean;
  isExactMatch: boolean;
  isLast: boolean;
}) {
  const navigate = useNavigate();
  const Icon = item.icon;

  return (
    <div>
      <button
        type='button'
        data-active={isActive ? 'true' : undefined}
        onClick={() => {
          if (isExactMatch) {
            return;
          }

          runWithViewTransition(() => {
            navigate(item.path);
          }, { direction: 'forward' });
        }}
        className={cn(
          'flex w-full items-center justify-between px-4 py-3.5 text-left transition-all duration-100',
          isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/25',
        )}
      >
        <div className='flex items-center gap-3.5'>
          <div
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center transition-colors',
              isActive ? 'bg-primary/14 text-primary' : 'bg-white/5 text-muted-foreground',
            )}
          >
            <Icon className={cn('h-5 w-5', isActive ? 'opacity-100' : 'opacity-60')} />
          </div>
          <div>
            <div className={cn('font-mono text-sm', isActive ? 'text-primary' : 'text-foreground')}>
              {item.name.toLowerCase()}
            </div>
            <div className='font-mono text-[10px] uppercase tracking-tight text-muted-foreground'>
              {item.description}
            </div>
          </div>
        </div>
        <ChevronRight className={cn('h-5 w-5 shrink-0', isActive ? 'opacity-80' : 'opacity-50')} />
      </button>

      {!isLast ? (
        <div aria-hidden='true' className='px-4'>
          <div className='h-px bg-white/5' />
        </div>
      ) : null}
    </div>
  );
}
