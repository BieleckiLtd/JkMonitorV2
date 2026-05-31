import { Bot, ChevronRight, LoaderCircle, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Switch } from './ui/switch';
import type { AutomationConfigResponse, AutomationRuleConfig } from '../types/automation';
import { cn } from '../lib/utils';
import { runWithViewTransition } from '../lib/viewTransitions';

type AutomationActionState = {
  loading: boolean;
  error?: string;
};

function getAutomationPath(ruleId: string) {
  return `/automations/${encodeURIComponent(ruleId)}`;
}

async function readErrorMessage(response: Response, fallbackMessage: string) {
  try {
    const payload = await response.json() as {
      detail?: string;
      error?: string;
      title?: string;
      errors?: Record<string, string[]>;
    };

    const validationMessages = Object.values(payload.errors ?? {}).flat().filter(Boolean);
    return validationMessages[0] ?? payload.detail ?? payload.error ?? payload.title ?? fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

function notifyAutomationsChanged() {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new Event('automations:config-changed'));
}

export function AutomationsNavigationPanel({ className }: { className?: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [rules, setRules] = useState<AutomationRuleConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, AutomationActionState>>({});

  const loadRules = useCallback(async () => {
    try {
      const response = await fetch('/api/automations', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('Unable to load saved automations.');
      }

      const data = (await response.json()) as AutomationConfigResponse;
      setRules(data.rules ?? []);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load saved automations.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  useEffect(() => {
    const handleAutomationsChanged = () => {
      void loadRules();
    };

    window.addEventListener('automations:config-changed', handleAutomationsChanged);
    return () => {
      window.removeEventListener('automations:config-changed', handleAutomationsChanged);
    };
  }, [loadRules]);

  const toggleRule = useCallback(async (rule: AutomationRuleConfig, enabled: boolean) => {
    const previousRules = rules;
    const nextRules = rules.map((candidate) => (
      candidate.id === rule.id
        ? { ...candidate, enabled }
        : candidate
    ));

    setRules(nextRules);
    setActions((current) => ({
      ...current,
      [rule.id]: { loading: true },
    }));

    try {
      const response = await fetch('/api/automations/rules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: nextRules }),
      });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `Unable to ${enabled ? 'enable' : 'disable'} automation.`));
      }

      const data = (await response.json()) as AutomationConfigResponse;
      setRules(data.rules ?? nextRules);
      setActions((current) => ({
        ...current,
        [rule.id]: { loading: false },
      }));
      notifyAutomationsChanged();
    } catch (error) {
      setRules(previousRules);
      setActions((current) => ({
        ...current,
        [rule.id]: {
          loading: false,
          error: error instanceof Error ? error.message : `Unable to ${enabled ? 'enable' : 'disable'} automation.`,
        },
      }));
    }
  }, [rules]);

  const activePath = location.pathname;

  return (
    <nav
      aria-label='Automations navigation'
      className={cn('border border-border/70 bg-card/85 shadow-sm backdrop-blur-sm', className)}
    >
      <div className='flex items-center justify-between px-4 pt-4 pb-3'>
        <span className='font-mono text-[10px] uppercase tracking-widest text-muted-foreground'>AUTOMATIONS</span>
        <span className='border border-primary/20 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary'>
          {rules.length + 1}_ITEMS
        </span>
      </div>

      {isLoading ? (
        <div className='flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground'>
          <LoaderCircle className='h-4 w-4 animate-spin' />
          Loading automations...
        </div>
      ) : null}

      {loadError ? (
        <div className='px-4 pb-3 text-xs text-rose-400'>
          {loadError}
        </div>
      ) : null}

      <div>
        {rules.map((rule, index) => {
          const isActive = activePath === getAutomationPath(rule.id);
          const isLastSavedRule = index === rules.length - 1;
          const action = actions[rule.id];

          return (
            <div key={rule.id}>
              <div
                data-active={isActive ? 'true' : undefined}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2 text-left transition-all duration-100',
                  isActive ? 'bg-primary/10 text-primary' : 'hover:bg-accent/25',
                )}
              >
                <button
                  type='button'
                  onClick={() => {
                    if (isActive) {
                      return;
                    }

                    runWithViewTransition(() => {
                      navigate(getAutomationPath(rule.id));
                    }, { direction: 'forward' });
                  }}
                  className='flex min-w-0 flex-1 items-center gap-2.5 text-left'
                >
                  <div
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center',
                      isActive ? 'bg-primary/14 text-primary' : 'bg-white/5 text-muted-foreground',
                    )}
                  >
                    <Bot className={cn('h-4 w-4', isActive ? 'opacity-100' : 'opacity-60')} />
                  </div>
                  <div className='min-w-0'>
                    <div className={cn('truncate font-mono text-sm', isActive ? 'text-primary' : 'text-foreground')}>
                      {rule.name || 'untitled automation'}
                    </div>
                    {rule.expression.trim() ? (
                      <div className='truncate font-mono text-[10px] uppercase tracking-tight text-muted-foreground'>
                        {rule.expression}
                      </div>
                    ) : null}
                  </div>
                </button>

                <div className='flex shrink-0 items-center gap-1.5'>
                  {action?.loading ? <LoaderCircle className='h-3.5 w-3.5 animate-spin text-muted-foreground' /> : null}
                  <Switch
                    size='sm'
                    checked={rule.enabled}
                    aria-label={`Toggle automation ${rule.name || rule.id}`}
                    disabled={action?.loading}
                    onCheckedChange={(checked: boolean) => {
                      void toggleRule(rule, checked);
                    }}
                  />
                  <ChevronRight className={cn('h-4 w-4 shrink-0', isActive ? 'opacity-80' : 'opacity-50')} />
                </div>
              </div>

              {action?.error ? (
                <div className='px-4 pb-2 text-[10px] text-rose-400'>
                  {action.error}
                </div>
              ) : null}

              {!isLastSavedRule ? (
                <div aria-hidden='true' className='px-4'>
                  <div className='h-px bg-white/5' />
                </div>
              ) : null}
            </div>
          );
        })}

        <button
          type='button'
          onClick={() => {
            if (activePath === '/automations/new') {
              return;
            }

            runWithViewTransition(() => {
              navigate('/automations/new');
            }, { direction: 'forward' });
          }}
          className={cn(
            'flex w-full items-center justify-between px-3 py-2.5 text-left transition-all duration-100',
            activePath === '/automations/new' ? 'bg-primary/10 text-primary' : 'hover:bg-accent/25',
          )}
        >
          <div className='flex items-center gap-2.5'>
            <div
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center',
                activePath === '/automations/new' ? 'bg-primary/14 text-primary' : 'bg-white/5 text-muted-foreground',
              )}
            >
              <Plus className={cn('h-4 w-4', activePath === '/automations/new' ? 'opacity-100' : 'opacity-60')} />
            </div>
            <div className={cn('font-mono text-sm', activePath === '/automations/new' ? 'text-primary' : 'text-foreground')}>
              Create new automation
            </div>
          </div>
          <ChevronRight className={cn('h-5 w-5 shrink-0', activePath === '/automations/new' ? 'opacity-80' : 'opacity-50')} />
        </button>
      </div>
    </nav>
  );
}