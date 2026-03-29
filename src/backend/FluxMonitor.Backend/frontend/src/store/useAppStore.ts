import { create } from 'zustand';
import { type ThemeConfig, builtInThemes } from '../lib/themes';
import { type UpdateActionResult, type UpdateProgress } from '../lib/systemUpdate';

function isUpdateProgress(value: unknown): value is UpdateProgress {
  return typeof value === 'object'
    && value !== null
    && 'sessionId' in value
    && 'status' in value
    && 'isRunning' in value;
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

  fetchUpdateProgress: async () => {
    try {
      const response = await fetch('/api/system/update/progress', { cache: 'no-store' });
      if (response.status === 204) {
        set((state) => {
          if (state.updateProgress?.status === 'restarting') {
            return {
              updateProgress: {
                ...state.updateProgress,
                status: 'succeeded',
                isRunning: false,
                success: true,
                stage: 'Update complete.',
                detail: 'Flux Monitor restarted successfully and is serving the updated release.',
              },
            };
          }

          return { updateProgress: null };
        });
        return;
      }

      if (!response.ok) {
        throw new Error('Unable to read update status.');
      }

      const progress = await response.json() as UpdateProgress;
      set((state) => {
        if (!progress.isRunning && state.dismissedUpdateSessionId === progress.sessionId) {
          return state;
        }

        return {
          updateProgress: progress,
          dismissedUpdateSessionId: progress.isRunning ? null : state.dismissedUpdateSessionId,
        };
      });
    } catch (error) {
      const current = get().updateProgress;
      if (current?.status === 'restarting') {
        set({
          updateProgress: {
            ...current,
            stage: 'Restarting Flux Monitor…',
            detail: 'The service is restarting. This page will reconnect automatically.',
            isRunning: true,
            success: null,
            status: 'restarting',
          },
        });
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
