import { create } from 'zustand';
import { type ThemeConfig, builtInThemes } from '../lib/themes';
import { type UpdateActionResult, type UpdateProgress } from '../lib/systemUpdate';

const updateRestartHeartbeatDetail = 'Flux Monitor is restarting. Waiting for the heartbeat before reloading the frontend.';
const updateReloadingFrontendDetail = 'Flux Monitor is back online. Reloading the frontend to pick up the new JavaScript and styles.';
const updateHeartbeatPollIntervalMs = 1500;
const updateProgressReconnectDelayMs = 2000;

let restartRecoveryPromise: Promise<void> | null = null;
let updateProgressEventSource: EventSource | null = null;
let updateProgressReconnectHandle: number | null = null;

type UpdateProgressStreamEnvelope = {
  progress: UpdateProgress | null;
};

function isUpdateProgress(value: unknown): value is UpdateProgress {
  return typeof value === 'object'
    && value !== null
    && 'sessionId' in value
    && 'status' in value
    && 'isRunning' in value;
}

function createRestartHeartbeatProgress(progress: UpdateProgress): UpdateProgress {
  return {
    ...progress,
    status: 'restarting',
    isRunning: true,
    success: null,
    stage: 'Restarting Flux Monitor…',
    detail: updateRestartHeartbeatDetail,
  };
}

function createFrontendReloadProgress(progress: UpdateProgress): UpdateProgress {
  return {
    ...progress,
    status: 'restarting',
    isRunning: true,
    success: null,
    stage: 'Reloading updated interface…',
    detail: updateReloadingFrontendDetail,
  };
}

function shouldRecoverRestartFromProgressLoss(progress: UpdateProgress | null | undefined): progress is UpdateProgress {
  if (!progress) {
    return false;
  }

  if (progress.status === 'restarting') {
    return true;
  }

  if (!progress.isRunning || progress.canCancel) {
    return false;
  }

  if (progress.stepIndex != null && progress.stepCount != null && progress.stepCount > 0 && progress.stepIndex >= progress.stepCount) {
    return true;
  }

  return (progress.percentComplete ?? 0) >= 96;
}

function getUpdateStatusRank(status: UpdateProgress['status']): number {
  switch (status) {
    case 'running':
      return 0;
    case 'cancelling':
      return 1;
    case 'restarting':
      return 2;
    case 'cancelled':
    case 'failed':
    case 'succeeded':
      return 3;
    default:
      return 0;
  }
}

function parseProgressUpdatedAt(progress: UpdateProgress): number | null {
  const timestamp = Date.parse(progress.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isStaleProgressSnapshot(current: UpdateProgress | null, incoming: UpdateProgress): boolean {
  if (!current || current.sessionId !== incoming.sessionId) {
    return false;
  }

  const currentUpdatedAt = parseProgressUpdatedAt(current);
  const incomingUpdatedAt = parseProgressUpdatedAt(incoming);
  if (currentUpdatedAt !== null && incomingUpdatedAt !== null && incomingUpdatedAt !== currentUpdatedAt) {
    return incomingUpdatedAt < currentUpdatedAt;
  }

  const currentStepIndex = current.stepIndex ?? -1;
  const incomingStepIndex = incoming.stepIndex ?? -1;
  if (currentStepIndex !== incomingStepIndex) {
    return incomingStepIndex < currentStepIndex;
  }

  const currentPercent = current.percentComplete ?? -1;
  const incomingPercent = incoming.percentComplete ?? -1;
  if (currentPercent !== incomingPercent) {
    return incomingPercent < currentPercent;
  }

  return getUpdateStatusRank(incoming.status) < getUpdateStatusRank(current.status);
}

function applyUpdateProgressSnapshot(
  progress: UpdateProgress | null,
  set: (partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState> | AppState),
  ) => void,
  get: () => AppState,
): void {
  if (!progress) {
    set((state) => {
      if (shouldRecoverRestartFromProgressLoss(state.updateProgress)) {
        return {
          updateProgress: createRestartHeartbeatProgress(state.updateProgress),
        };
      }

      return { updateProgress: null };
    });

    if (shouldRecoverRestartFromProgressLoss(get().updateProgress)) {
      beginRestartRecovery(set, get);
    }

    return;
  }

  set((state) => {
    if (isStaleProgressSnapshot(state.updateProgress, progress)) {
      return state;
    }

    if (!progress.isRunning && state.dismissedUpdateSessionId === progress.sessionId) {
      return state;
    }

    return {
      updateProgress: progress,
      dismissedUpdateSessionId: progress.isRunning ? null : state.dismissedUpdateSessionId,
    };
  });
}

async function clearFrontendRuntimeCaches(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map(async (registration) => {
        try {
          await registration.unregister();
        } catch {
          // Best effort; a full document reload still happens below.
        }
      }));
    } catch {
      // Best effort; cache cleanup is additive, not required for the reload.
    }
  }

  if ('caches' in window) {
    try {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys.map(async (cacheKey) => {
        try {
          await caches.delete(cacheKey);
        } catch {
          // Best effort; continue to the forced reload.
        }
      }));
    } catch {
      // Best effort; continue to the forced reload.
    }
  }
}

async function hardReloadFrontend(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  await clearFrontendRuntimeCaches();

  const reloadUrl = new URL(window.location.href);
  reloadUrl.searchParams.set('_reload', Date.now().toString());
  window.location.replace(reloadUrl.toString());
}

function beginRestartRecovery(
  set: (partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState> | AppState),
  ) => void,
  get: () => AppState,
): void {
  if (typeof window === 'undefined' || restartRecoveryPromise) {
    return;
  }

  restartRecoveryPromise = (async () => {
    while (true) {
      try {
        const response = await fetch(`/api/health?nocache=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
        });

        if (response.ok) {
          const current = get().updateProgress;
          if (current?.status === 'restarting') {
            set({ updateProgress: createFrontendReloadProgress(current) });
          }

          await hardReloadFrontend();
          return;
        }
      } catch {
        // The service is still restarting; keep polling.
      }

      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, updateHeartbeatPollIntervalMs);
      });
    }
  })()
    .catch((error) => {
      console.error('Failed while waiting for Flux Monitor to restart:', error);
    })
    .finally(() => {
      restartRecoveryPromise = null;
    });
}

function connectUpdateProgressStream(
  set: (partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState> | AppState),
  ) => void,
  get: () => AppState,
): void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined' || updateProgressEventSource) {
    return;
  }

  clearUpdateProgressReconnect();

  const eventSource = new EventSource('/api/system/update/stream');
  updateProgressEventSource = eventSource;

  eventSource.onopen = () => {
    clearUpdateProgressReconnect();
  };

  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data) as UpdateProgressStreamEnvelope;
      applyUpdateProgressSnapshot(payload.progress, set, get);
    } catch (error) {
      console.error('Failed to parse pushed update progress:', error);
    }
  };

  eventSource.onerror = () => {
    if (shouldRecoverRestartFromProgressLoss(get().updateProgress)) {
      const current = get().updateProgress;
      if (current) {
        set({ updateProgress: createRestartHeartbeatProgress(current) });
      }

      beginRestartRecovery(set, get);
      disconnectUpdateProgressStream();
      return;
    }

    disconnectUpdateProgressStream();
    scheduleUpdateProgressReconnect(set, get);
  };
}

function disconnectUpdateProgressStream(): void {
  if (!updateProgressEventSource) {
    clearUpdateProgressReconnect();
    return;
  }

  updateProgressEventSource.close();
  updateProgressEventSource = null;
  clearUpdateProgressReconnect();
}

function clearUpdateProgressReconnect(): void {
  if (updateProgressReconnectHandle === null || typeof window === 'undefined') {
    return;
  }

  window.clearTimeout(updateProgressReconnectHandle);
  updateProgressReconnectHandle = null;
}

function scheduleUpdateProgressReconnect(
  set: (partial:
    | Partial<AppState>
    | ((state: AppState) => Partial<AppState> | AppState),
  ) => void,
  get: () => AppState,
): void {
  if (typeof window === 'undefined' || updateProgressReconnectHandle !== null || restartRecoveryPromise) {
    return;
  }

  updateProgressReconnectHandle = window.setTimeout(() => {
    updateProgressReconnectHandle = null;
    connectUpdateProgressStream(set, get);
    void get().fetchUpdateProgress();
  }, updateProgressReconnectDelayMs);
}

interface AppState {
  isDesktopSidebarOpen: boolean;
  isMobileSidebarOpen: boolean;
  toggleSidebar: () => void;
  closeMobileSidebar: () => void;
  themes: ThemeConfig[];
  activeThemeId: string;
  setActiveThemeId: (id: string) => void;
  loadExternalTheme: () => Promise<void>;
  applyTheme: (theme: ThemeConfig) => void;
  updateProgress: UpdateProgress | null;
  updateActionPending: 'starting' | 'cancelling' | null;
  dismissedUpdateSessionId: string | null;
  connectUpdateProgressStream: () => void;
  disconnectUpdateProgressStream: () => void;
  fetchUpdateProgress: () => Promise<void>;
  startSystemUpdate: () => Promise<UpdateActionResult>;
  cancelSystemUpdate: () => Promise<UpdateActionResult>;
  dismissUpdateNotice: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  isDesktopSidebarOpen: true,
  isMobileSidebarOpen: false,
  toggleSidebar: () => {
    const isMobileViewport = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;

    set((state) => isMobileViewport
      ? { isMobileSidebarOpen: !state.isMobileSidebarOpen }
      : { isDesktopSidebarOpen: !state.isDesktopSidebarOpen });
  },
  closeMobileSidebar: () => set({ isMobileSidebarOpen: false }),

  themes: builtInThemes,
  activeThemeId: (typeof window !== 'undefined' && localStorage.getItem('FluxMonitor-theme')) || 'emerald-dark',

  setActiveThemeId: (id) => {
    const theme = get().themes.find(t => t.id === id);
    if (theme) {
      set({ activeThemeId: id });
      if (typeof window !== 'undefined') localStorage.setItem('FluxMonitor-theme', id);
      get().applyTheme(theme);
    }
  },

  applyTheme: (theme) => {
    const root = document.documentElement;
    if (theme.mode === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }

    if (theme.radius) {
      root.style.setProperty('--radius', theme.radius);
    }

    if (theme.colors) {
      Object.entries(theme.colors).forEach(([key, value]) => {
        root.style.setProperty(key, value);
      });
    }

    const bg = theme.colors?.['--background'] ?? (theme.mode === 'dark' ? '#09090b' : '#f8fafc');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  },

  loadExternalTheme: async () => {
    try {
      const response = await fetch('/theme.json?nocache=' + new Date().getTime());
      if (response.ok) {
        const config: ThemeConfig = await response.json();
        config.id = 'custom-json';

        set((state) => {
          const existingThemes = state.themes.filter(t => t.id !== 'custom-json');
          return { themes: [config, ...existingThemes] };
        });

        const active = get().themes.find(t => t.id === get().activeThemeId);
        if (active) {
          get().applyTheme(active);
        }
      }
    } catch (error) {
      console.error('Failed to load external theme.json:', error);
      const active = get().themes.find(t => t.id === get().activeThemeId);
      if (active) get().applyTheme(active);
    }
  },

  updateProgress: null,
  updateActionPending: null,
  dismissedUpdateSessionId: null,
  connectUpdateProgressStream: () => {
    connectUpdateProgressStream(set, get);
  },
  disconnectUpdateProgressStream: () => {
    disconnectUpdateProgressStream();
  },

  fetchUpdateProgress: async () => {
    try {
      const response = await fetch('/api/system/update/progress', { cache: 'no-store' });
      if (response.status === 204) {
        applyUpdateProgressSnapshot(null, set, get);
        return;
      }

      if (!response.ok) {
        throw new Error('Unable to read update status.');
      }

      const progress = await response.json() as UpdateProgress;
      applyUpdateProgressSnapshot(progress, set, get);
    } catch (error) {
      const current = get().updateProgress;
      if (shouldRecoverRestartFromProgressLoss(current)) {
        set({
          updateProgress: createRestartHeartbeatProgress(current),
        });
        beginRestartRecovery(set, get);
        return;
      }

      console.error('Failed to fetch update progress:', error);
    }
  },

  startSystemUpdate: async () => {
    set({ updateActionPending: 'starting' });

    try {
      const response = await fetch('/api/system/update/install', { method: 'POST' });
      const body = await response.json().catch(() => null) as { error?: string } | UpdateProgress | null;

      if (!response.ok) {
        return {
          ok: false,
          error: body && 'error' in body ? body.error ?? 'Unable to start the update.' : 'Unable to start the update.',
        };
      }

      if (isUpdateProgress(body)) {
        set({ updateProgress: body, dismissedUpdateSessionId: null });
      } else {
        await get().fetchUpdateProgress();
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to start the update.',
      };
    } finally {
      set({ updateActionPending: null });
    }
  },

  cancelSystemUpdate: async () => {
    set({ updateActionPending: 'cancelling' });

    try {
      const response = await fetch('/api/system/update/cancel', { method: 'POST' });
      const body = await response.json().catch(() => null) as { error?: string; progress?: UpdateProgress } | UpdateProgress | null;

      if (!response.ok) {
        const progress = body && 'progress' in body ? body.progress ?? null : null;
        if (progress) {
          set({ updateProgress: progress });
        }

        return {
          ok: false,
          error: body && 'error' in body ? body.error ?? 'Unable to cancel the update.' : 'Unable to cancel the update.',
        };
      }

      if (isUpdateProgress(body)) {
        set({ updateProgress: body });
      } else {
        await get().fetchUpdateProgress();
      }

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to cancel the update.',
      };
    } finally {
      set({ updateActionPending: null });
    }
  },

  dismissUpdateNotice: () => set((state) => (
    state.updateProgress && !state.updateProgress.isRunning
      ? {
        dismissedUpdateSessionId: state.updateProgress.sessionId,
        updateProgress: null,
      }
      : state
  )),
}));
