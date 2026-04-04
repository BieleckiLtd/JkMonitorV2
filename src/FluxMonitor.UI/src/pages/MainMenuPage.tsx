import { Activity, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StackPageHeader } from '../components/StackPageHeader';
import { primaryNavigationItems, type PrimaryNavigationItem } from '../lib/navigation';
import { cn } from '../lib/utils';
import { runWithViewTransition } from '../lib/viewTransitions';

export function MainMenuPage() {
  return (
    <div className='space-y-6 pb-8'>
      <StackPageHeader
        title='Main menu'
        description='Choose an area to open'
        icon={Activity}
      />

      <div className='grid gap-6 xl:grid-cols-[18rem_minmax(0,1fr)] xl:gap-8 2xl:grid-cols-[19rem_minmax(0,1fr)]'>
        <div className='bg-card border border-white/5 p-4'>
          <div className='mb-4 flex items-center justify-between'>
            <span className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>NAVIGATION</span>
            <span className='border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>{primaryNavigationItems.length}_LIVE</span>
          </div>
          <div>
            {primaryNavigationItems.map((item, index) => (
              <MainMenuLink key={item.path} item={item} isLast={index === primaryNavigationItems.length - 1} />
            ))}
          </div>
        </div>

        <div className='hidden border border-white/5 bg-card/75 p-5 xl:flex'>
          <div className='flex min-h-64 flex-col justify-center space-y-3'>
            <div className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>
              SYSTEM_NAV
            </div>
            <div className='font-mono text-lg font-bold tracking-tight text-foreground'>
              Pick a page
            </div>
            <p className='max-w-lg font-mono text-xs leading-5 text-muted-foreground'>
              The menu stays as a single focused step. Open a page, work there, then use Back to return here.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MainMenuLink({ item, isLast }: { item: PrimaryNavigationItem; isLast: boolean }) {
  const navigate = useNavigate();
  const Icon = item.icon;

  return (
    <button
      type='button'
      onClick={() => {
        runWithViewTransition(() => {
          navigate(item.path);
        }, { direction: 'forward' });
      }}
      className={cn(
        'flex w-full items-center justify-between py-3 text-left transition-all duration-100 hover:bg-white/5',
        !isLast && 'border-b border-white/5'
      )}
    >
      <div className='flex items-center gap-3'>
        <div className='flex h-8 w-8 shrink-0 items-center justify-center bg-white/5'>
          <Icon className='h-4 w-4 opacity-50' />
        </div>
        <div>
          <div className='font-mono text-xs text-foreground'>{item.name.toLowerCase()}</div>
          <div className='font-mono text-[9px] uppercase tracking-tighter text-muted-foreground'>{item.description}</div>
        </div>
      </div>
      <ChevronRight className='h-4 w-4 shrink-0 opacity-50' />
    </button>
  );
}
