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
          
          <div className='grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3'>
            {themes.map((t) => {
              const bg = t.colors['--background'] || '#000';
              const card = t.colors['--card'] || bg;
              const fg = t.colors['--foreground'] || '#fff';
              const pr = t.colors['--primary'] || '#888';
              const isActive = activeThemeId === t.id;
              
              return (
                <button
                  data-slot='theme-option'
                  data-active={isActive}
                  key={t.id}
                  onClick={() => setActiveThemeId(t.id)}
                  className={'flex flex-col gap-4 rounded-xl border-2 p-4 text-left transition-all ' + (isActive ? 'border-primary bg-primary/5 shadow-lg' : 'border-border hover:border-primary/50 hover:bg-muted/50')}
                >
                  <div className='flex items-start justify-between gap-3 w-full'>
                    <div className='min-w-0'>
                      <div className='font-medium text-foreground truncate'>{t.themeName}</div>
                      {t.description ? (
                        <div className='mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground'>
                          {t.description}
                        </div>
                      ) : null}
                    </div>
                    {isActive && (
                      <span className='h-2 w-2 rounded-full bg-primary animate-pulse shrink-0 shadow-[0_0_8px_var(--primary)]' />
                    )}
                  </div>
                  
                  <div className='grid grid-cols-3 gap-2 w-full'>
                    <div 
                      className='h-10 rounded border border-border/50 shadow-inner flex items-center justify-center' 
                      style={{ backgroundColor: bg }}
                    >
                      <span className='text-[10px] font-mono opacity-80' style={{ color: fg }}>Bg</span>
                    </div>
                    <div 
                      className='h-10 rounded border border-border/50 shadow-inner flex items-center justify-center'
                      style={{ backgroundColor: card }}
                    >
                      <span className='text-[10px] font-mono opacity-80' style={{ color: fg }}>Card</span>
                    </div>
                    <div 
                      className='h-10 rounded border border-border/50 shadow-inner flex items-center justify-center' 
                      style={{ backgroundColor: pr }} 
                    >
                      <span className='text-[10px] font-mono opacity-80' style={{ color: t.colors['--primary-foreground'] || fg }}>Pri</span>
                    </div>
                  </div>

                  <div className='flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.22em] text-muted-foreground font-semibold'>
                    <span>{t.mode}</span>
                    <span>Radius {t.radius}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
