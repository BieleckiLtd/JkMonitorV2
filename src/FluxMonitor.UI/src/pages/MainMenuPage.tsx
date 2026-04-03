import { Activity, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { StackPageHeader } from '../components/StackPageHeader';
import { Card, CardContent } from '../components/ui/card';
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
        <Card className='gap-0 bg-card/85 py-0 shadow-none ring-0'>
          <CardContent className='space-y-2 p-3'>
            {primaryNavigationItems.map((item) => (
              <MainMenuLink key={item.path} item={item} />
            ))}
          </CardContent>
        </Card>

        <Card className='hidden border border-border/70 bg-card/75 shadow-sm xl:flex'>
          <CardContent className='flex min-h-64 flex-col justify-center space-y-3 pt-6'>
            <div className='text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground'>
              Navigation
            </div>
            <div className='text-2xl font-semibold tracking-tight text-foreground'>
              Pick a page
            </div>
            <p className='max-w-lg text-sm leading-6 text-muted-foreground'>
              The menu stays as a single focused step. Open a page, work there, then use Back to return here.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MainMenuLink({ item }: { item: PrimaryNavigationItem }) {
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
        'flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-background/30 px-4 py-3 text-left text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <Icon className='h-4 w-4 shrink-0' />
      <div className='min-w-0 flex-1'>
        <div className='text-sm font-medium'>{item.name}</div>
        <div className='mt-0.5 text-xs opacity-80'>{item.description}</div>
      </div>
      <ChevronRight className='h-4 w-4 shrink-0 opacity-60' />
    </button>
  );
}
