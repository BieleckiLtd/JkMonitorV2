import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

const installPollIntervalMs = 1500;
const restartPollIntervalMs = 1500;

type SetupStateSnapshot = {
  environmentName: string;
  connectionString?: string | null;
  canAutoRestart: boolean;
  applyMessage: string;
};

type LocalDependenciesStateResponse = {
  supported: boolean;
  isRunning: boolean;
  hasCompleted: boolean;
  succeeded?: boolean | null;
  requiresRestart: boolean;
  canAutoRestart: boolean;
  message: string;
  logLines: string[];
  updatedAt: string;
};

type InstallLocalDependenciesResponse = {
  started: boolean;
  message: string;
  status: LocalDependenciesStateResponse;
};

type RestartApplicationResponse = {
  restartScheduled: boolean;
  message: string;
};

type HealthSnapshot = {
  startedAt?: string | null;
};

function getMessageFromBody(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
    return body.message;
  }

  return fallback;
}

async function readJson<T>(response: Response): Promise<T | null> {
  return await response.json().catch(() => null) as T | null;
}

export function SetupRequiredScreen({ setupState }: { setupState: SetupStateSnapshot }) {
  const [dependenciesState, setDependenciesState] = useState<LocalDependenciesStateResponse | null>(null);
  const [loadingDependenciesState, setLoadingDependenciesState] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [installPending, setInstallPending] = useState(false);
  const [restartPending, setRestartPending] = useState(false);
  const [restartBaselineStartedAt, setRestartBaselineStartedAt] = useState<string | null>(null);
  const autoRestartRequestedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const loadDependenciesState = async () => {
      try {
        const response = await fetch('/api/setup/local-dependencies', { cache: 'no-store' });
        const body = await readJson<LocalDependenciesStateResponse>(response);

        if (!response.ok) {
          throw new Error(getMessageFromBody(body, 'Unable to load the dependency installer status.'));
        }

        if (!cancelled && body) {
          setDependenciesState(body);
          setActionError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setActionError(error instanceof Error ? error.message : 'Unable to load the dependency installer status.');
        }
      } finally {
        if (!cancelled) {
          setLoadingDependenciesState(false);
        }
      }
    };

    void loadDependenciesState();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (dependenciesState?.isRunning !== true) {
      return;
    }

    const handle = window.setTimeout(async () => {
      try {
        const response = await fetch('/api/setup/local-dependencies', { cache: 'no-store' });
        const body = await readJson<LocalDependenciesStateResponse>(response);

        if (!response.ok) {
          throw new Error(getMessageFromBody(body, 'Unable to refresh the dependency installer status.'));
        }

        if (body) {
          setDependenciesState(body);
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Unable to refresh the dependency installer status.');
      }
    }, installPollIntervalMs);

    return () => {
      window.clearTimeout(handle);
    };
  }, [dependenciesState?.isRunning, dependenciesState?.updatedAt]);

  useEffect(() => {
    if (!dependenciesState?.hasCompleted || dependenciesState.succeeded !== true || !dependenciesState.requiresRestart) {
      return;
    }

    if (!dependenciesState.canAutoRestart || restartPending || autoRestartRequestedRef.current) {
      return;
    }

    autoRestartRequestedRef.current = true;
    void (async () => {
      try {
        let baselineStartedAt: string | null = null;

        try {
          const baselineResponse = await fetch(`/api/health?nocache=${Date.now()}`, { cache: 'no-store' });
          const baselineSnapshot = await readJson<HealthSnapshot>(baselineResponse);
          baselineStartedAt = typeof baselineSnapshot?.startedAt === 'string' && baselineSnapshot.startedAt.length > 0
            ? baselineSnapshot.startedAt
            : null;
        } catch {
          baselineStartedAt = null;
        }

        setRestartBaselineStartedAt(baselineStartedAt);

        const response = await fetch('/api/setup/restart', { method: 'POST' });
        const body = await readJson<RestartApplicationResponse>(response);

        if (!response.ok || !body?.restartScheduled) {
          autoRestartRequestedRef.current = false;
          throw new Error(getMessageFromBody(body, 'Flux Monitor could not restart automatically.'));
        }

        setActionMessage(body.message);
        setActionError(null);
        setRestartPending(true);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Flux Monitor could not restart automatically.');
      }
    })();
  }, [dependenciesState, restartPending]);

  useEffect(() => {
    if (!restartPending) {
      return;
    }

    let cancelled = false;

    const waitForRestart = async () => {
      let observedUnavailability = false;

      while (!cancelled) {
        try {
          const response = await fetch(`/api/health?nocache=${Date.now()}`, {
            cache: 'no-store',
            headers: {
              'Cache-Control': 'no-cache',
              Pragma: 'no-cache',
            },
          });

          if (response.ok) {
            const snapshot = await readJson<HealthSnapshot>(response);
            const startedAt = typeof snapshot?.startedAt === 'string' && snapshot.startedAt.length > 0
              ? snapshot.startedAt
              : null;

            if (observedUnavailability || (
              restartBaselineStartedAt !== null
              && startedAt !== null
              && startedAt !== restartBaselineStartedAt
            )) {
              window.location.reload();
              return;
            }
          } else {
            observedUnavailability = true;
          }
        } catch {
          observedUnavailability = true;
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, restartPollIntervalMs);
        });
      }
    };

    void waitForRestart();

    return () => {
      cancelled = true;
    };
  }, [restartBaselineStartedAt, restartPending]);

  const installDependencies = async () => {
    setInstallPending(true);
    setActionError(null);
    setActionMessage(null);
    autoRestartRequestedRef.current = false;

    try {
      const response = await fetch('/api/setup/local-dependencies/install', { method: 'POST' });
      const body = await readJson<InstallLocalDependenciesResponse | { message?: string }>(response);

      if (!response.ok || !body || !('status' in body)) {
        throw new Error(getMessageFromBody(body, 'Flux Monitor could not start dependency installation.'));
      }

      setDependenciesState(body.status);
      setActionMessage(body.message);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Flux Monitor could not start dependency installation.');
    } finally {
      setInstallPending(false);
    }
  };

  const installationBusy = installPending || dependenciesState?.isRunning === true || restartPending;
  const installSupported = dependenciesState?.supported === true;
  const installCompleted = dependenciesState?.hasCompleted === true;
  const installSucceeded = dependenciesState?.succeeded === true;
  const showLogs = (dependenciesState?.logLines.length ?? 0) > 0;

  return (
    <div className='min-h-screen bg-[radial-gradient(circle_at_top,#16354f_0%,transparent_38%),linear-gradient(180deg,#020617_0%,#08111f_42%,#0b1728_100%)] px-6 py-10 text-foreground'>
      <div className='mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-6xl items-center justify-center'>
        <div className='grid w-full gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]'>
          <Card className='border-white/10 bg-slate-950/75 shadow-[0_24px_80px_rgba(2,6,23,0.45)] backdrop-blur'>
            <CardHeader className='gap-3'>
              <div className='text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300/80'>
                Flux Monitor Setup
              </div>
              <CardTitle className='text-3xl text-white sm:text-4xl'>
                Local storage still needs to be installed.
              </CardTitle>
              <CardDescription className='max-w-3xl text-base leading-7 text-slate-300'>
                Flux Monitor started in setup-required mode because PostgreSQL storage is not configured for this Windows app yet.
                Use the in-app installer to provision PostgreSQL and TimescaleDB, write the local connection string, and restart cleanly.
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-4'>
              <Alert className='border-cyan-400/30 bg-cyan-400/10 text-slate-100'>
                <AlertTitle>Environment</AlertTitle>
                <AlertDescription>
                  Running in <span className='font-medium text-white'>{setupState.environmentName}</span>.
                  {' '}
                  {setupState.canAutoRestart
                    ? 'This desktop app can restart itself after setup.'
                    : setupState.applyMessage}
                </AlertDescription>
              </Alert>

              {actionError ? (
                <Alert variant='destructive' className='border-red-400/35 bg-red-500/10 text-red-100'>
                  <AlertTitle>Setup failed</AlertTitle>
                  <AlertDescription>{actionError}</AlertDescription>
                </Alert>
              ) : null}

              {actionMessage ? (
                <Alert className='border-emerald-400/25 bg-emerald-500/10 text-emerald-50'>
                  <AlertTitle>Setup progress</AlertTitle>
                  <AlertDescription>{actionMessage}</AlertDescription>
                </Alert>
              ) : null}

              {dependenciesState ? (
                <Alert className='border-white/10 bg-white/5 text-slate-100'>
                  <AlertTitle>Installer status</AlertTitle>
                  <AlertDescription>{dependenciesState.message}</AlertDescription>
                </Alert>
              ) : null}

              {showLogs ? (
                <div className='overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70'>
                  <div className='border-b border-white/10 px-4 py-3 text-xs font-semibold uppercase tracking-[0.24em] text-slate-400'>
                    Installer log
                  </div>
                  <pre className='max-h-[28rem] overflow-auto px-4 py-4 text-xs leading-6 text-slate-200'>
                    {dependenciesState?.logLines.join('\n')}
                  </pre>
                </div>
              ) : null}
            </CardContent>
            <CardFooter className='justify-between gap-3 border-white/10 bg-white/5'>
              <div className='text-sm text-slate-300'>
                {installCompleted && installSucceeded
                  ? 'Storage is installed. Flux Monitor is waiting for the restart to complete.'
                  : 'The installer downloads PostgreSQL binaries into your Windows local app data and configures Flux Monitor to use them.'}
              </div>
              <Button
                type='button'
                size='lg'
                disabled={loadingDependenciesState || installationBusy || !installSupported}
                onClick={() => {
                  void installDependencies();
                }}
              >
                {restartPending
                  ? 'Restarting Flux Monitor…'
                  : dependenciesState?.isRunning
                    ? 'Installing dependencies…'
                    : 'Install local PostgreSQL'}
              </Button>
            </CardFooter>
          </Card>

          <Card className='border-white/10 bg-black/20 shadow-[0_24px_80px_rgba(2,6,23,0.35)] backdrop-blur'>
            <CardHeader className='gap-3'>
              <CardTitle className='text-white'>What this fixes</CardTitle>
              <CardDescription className='text-slate-300'>
                The desktop app is missing its local database dependency, not the UI bundle.
              </CardDescription>
            </CardHeader>
            <CardContent className='space-y-5 text-sm leading-7 text-slate-200'>
              <div className='rounded-2xl border border-white/10 bg-white/5 p-4'>
                <div className='text-xs font-semibold uppercase tracking-[0.24em] text-slate-400'>Installed automatically</div>
                <div className='mt-2 text-base text-white'>PostgreSQL 17 binaries</div>
                <div className='text-slate-300'>A local cluster is created under your Windows profile for Flux Monitor.</div>
              </div>
              <div className='rounded-2xl border border-white/10 bg-white/5 p-4'>
                <div className='text-xs font-semibold uppercase tracking-[0.24em] text-slate-400'>Enabled automatically</div>
                <div className='mt-2 text-base text-white'>TimescaleDB extension</div>
                <div className='text-slate-300'>Flux Monitor enables the extension and creates the application database if needed.</div>
              </div>
              <div className='rounded-2xl border border-white/10 bg-white/5 p-4'>
                <div className='text-xs font-semibold uppercase tracking-[0.24em] text-slate-400'>Written locally</div>
                <div className='mt-2 text-base text-white'>Backend storage settings</div>
                <div className='text-slate-300'>
                  {setupState.connectionString
                    ? `Current configured connection string: ${setupState.connectionString}`
                    : 'The installer writes a local Flux Monitor connection string and restarts the app to apply it.'}
                </div>
              </div>
              {!loadingDependenciesState && !installSupported ? (
                <Alert variant='destructive' className='border-red-400/35 bg-red-500/10 text-red-100'>
                  <AlertTitle>Automatic install unavailable</AlertTitle>
                  <AlertDescription>
                    {dependenciesState?.message ?? 'This build does not include the Windows dependency installer.'}
                  </AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
