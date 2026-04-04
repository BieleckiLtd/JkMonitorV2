import { PanelHeader } from '../components/PanelHeader';
import { Card, CardContent } from '../components/ui/card';
import { useAppStore } from '../store/useAppStore';

export function SettingsPage({ hideHeader = false }: { hideHeader?: boolean }) {
  const themes = useAppStore((state) => state.themes);
  const activeThemeId = useAppStore((state) => state.activeThemeId);
  const setActiveThemeId = useAppStore((state) => state.setActiveThemeId);

  return (
    <div className='mx-auto max-w-4xl space-y-6 pb-12'>
      {!hideHeader ? (
        <div className='flex flex-col gap-1 border-b border-border pb-4'>
          <h2 className='mb-2 text-3xl font-bold tracking-tight text-foreground'>Theme</h2>
          <p className='text-sm text-muted-foreground'>
            Choose the visual theme used across the app.
          </p>
        </div>
      ) : null}

      <div className='grid gap-6'>
        <Card className='border border-border/80 bg-card/85 shadow-sm'>
          <PanelHeader
            title='Theme browser'
            description='Select a visual aesthetic. Themes stay in app memory for fast switching.'
          />
          <CardContent className='pt-5'>
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
                    className={
                      'flex h-full flex-col gap-4 rounded-2xl border px-4 py-4 text-left transition-colors ' +
                      (isActive
                        ? 'border-primary/35 bg-primary/5 shadow-sm'
                        : 'border-border/70 bg-background/50 hover:border-primary/30 hover:bg-background/80')
                    }
                  >
                    <div className='flex w-full items-start justify-between gap-3'>
                      <div className='min-w-0'>
                        <div className='truncate text-sm font-semibold text-foreground'>{t.themeName}</div>
                        {t.description ? (
                          <div className='mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground'>
                            {t.description}
                          </div>
                        ) : null}
                      </div>
                      {isActive ? (
                        <span className='mt-1 h-2 w-2 shrink-0 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]' />
                      ) : null}
                    </div>

                    <div className='grid w-full grid-cols-3 gap-2'>
                      <div
                        className='flex h-10 items-center justify-center rounded-xl border border-border/50 bg-background/50 shadow-inner'
                        style={{ backgroundColor: bg }}
                      >
                        <span className='text-[10px] font-mono opacity-80' style={{ color: fg }}>Bg</span>
                      </div>
                      <div
                        className='flex h-10 items-center justify-center rounded-xl border border-border/50 bg-background/50 shadow-inner'
                        style={{ backgroundColor: card }}
                      >
                        <span className='text-[10px] font-mono opacity-80' style={{ color: fg }}>Card</span>
                      </div>
                      <div
                        className='flex h-10 items-center justify-center rounded-xl border border-border/50 shadow-inner'
                        style={{ backgroundColor: pr }}
                      >
                        <span className='text-[10px] font-mono opacity-80' style={{ color: t.colors['--primary-foreground'] || fg }}>Pri</span>
                      </div>
                    </div>

                    <div className='flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>
                      <span>{t.mode}</span>
                      <span>Radius {t.radius}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
