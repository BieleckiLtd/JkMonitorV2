import { ChevronRight } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { cn } from '../lib/utils';
import { runWithViewTransition } from '../lib/viewTransitions';
import { systemMenuItems } from '../lib/systemNavigation';

export function SystemNavigationPanel({ className }: { className?: string }) {
  const location = useLocation();
  const navigate = useNavigate();

  const match = location.pathname.match(/^\/system\/([^/]+)/);
  const activeSectionId = match?.[1] ?? null;

  return (
    <nav
      aria-label='System navigation'
      className={cn('border border-border/70 bg-card/85 shadow-sm backdrop-blur-sm', className)}
    >
      <div className='flex items-center justify-between px-4 pt-4 pb-3'>
        <span className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>SYSTEM_SECTIONS</span>
        <span className='border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>
          {systemMenuItems.length}_ITEMS
        </span>
      </div>
      <div>
        {systemMenuItems.map((item, index) => {
          const Icon = item.icon;
          const itemId = 'sectionId' in item ? item.sectionId : item.id;
          const active = itemId === activeSectionId;

          return (
            <div key={item.path}>
              <button
                type='button'
                onClick={() => {
                  if (active) return;
                  runWithViewTransition(() => {
                    navigate(item.path);
                  }, { direction: 'forward' });
                }}
                className={cn(
                  'flex w-full items-center justify-between px-4 py-3.5 text-left transition-all duration-100',
                  active ? 'bg-primary/5' : 'hover:bg-white/5',
                )}
              >
                <div className='flex items-center gap-3.5'>
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center',
                      active ? 'bg-primary/10' : 'bg-white/5',
                    )}
                  >
                    <Icon className={cn('h-5 w-5', active ? 'text-primary opacity-80' : 'opacity-50')} />
                  </div>
                  <div>
                    <div className={cn('font-mono text-sm', active ? 'text-primary' : 'text-foreground')}>
                      {item.label.toLowerCase()}
                    </div>
                    <div className='font-mono text-[10px] uppercase tracking-tight text-muted-foreground'>
                      {item.description}
                    </div>
                  </div>
                </div>
                <ChevronRight className={cn('h-5 w-5 shrink-0', active ? 'text-primary opacity-80' : 'opacity-50')} />
              </button>
              {index < systemMenuItems.length - 1 ? (
                <div aria-hidden='true' className='px-4'>
                  <div className='h-px bg-white/5' />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </nav>
  );
}
