import { useAppStore } from '../store/useAppStore';

export function SettingsPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const themes = useAppStore((state) => state.themes);
  const activeThemeId = useAppStore((state) => state.activeThemeId);
  const setActiveThemeId = useAppStore((state) => state.setActiveThemeId);

  return (
    <div className='space-y-6 max-w-4xl mx-auto pb-12'>
      {!hideHeader ? (
        <div className='flex flex-col gap-1 border-b border-border pb-4'>
          <h2 className='mb-2 text-3xl font-bold tracking-tight text-foreground'>Theme</h2>
          <p className='text-sm text-muted-foreground'>
            Choose the visual theme used across the app.
          </p>
        </div>
      ) : null}

      <div className='grid gap-6 mt-6'>
        <section className='bg-card/50 border border-border rounded-xl p-6 shadow-sm'>
          <h3 className='text-lg font-semibold text-foreground mb-4'>Theme Browser</h3>
          <p className='text-sm text-muted-foreground mb-6'>
            Select a visual aesthetic. These are kept in app memory for fast switching.
          </p>
          
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 md:grid-cols-3 gap-4'>
            {themes.map((t) => {
              const bg = t.colors['--background'] || '#000';
              const fg = t.colors['--foreground'] || '#fff';
              const pr = t.colors['--primary'] || '#888';
              const isActive = activeThemeId === t.id;
              
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveThemeId(t.id)}
                  className={'flex flex-col gap-3 p-4 rounded-xl border-2 text-left transition-all ' + (isActive ? 'border-primary bg-primary/5 shadow-lg' : 'border-border hover:border-primary/50 hover:bg-muted/50')}
                >
                  <div className='flex items-center justify-between w-full'>
                    <span className='font-medium text-foreground truncate'>{t.themeName}</span>
                    {isActive && (
                      <span className='h-2 w-2 rounded-full bg-primary animate-pulse shrink-0 shadow-[0_0_8px_var(--primary)]' />
                    )}
                  </div>
                  
                  <div className='flex gap-2 w-full'>
                    <div 
                      className='h-8 flex-1 rounded border border-border/50 shadow-inner flex items-center justify-center' 
                      style={{ backgroundColor: bg }}
                    >
                      <span className='text-[10px] font-mono opacity-80' style={{ color: fg }}>Bg</span>
                    </div>
                    <div 
                      className='h-8 w-8 rounded border border-border/50 shadow-inner' 
                      style={{ backgroundColor: pr }} 
                    />
                  </div>

                  <span className='text-[10px] text-muted-foreground text-xs uppercase tracking-wider font-semibold'>
                    {t.mode}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
