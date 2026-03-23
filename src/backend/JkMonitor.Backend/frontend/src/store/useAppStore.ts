import { create } from 'zustand';
import { type ThemeConfig, builtInThemes } from '../lib/themes';

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
  activeThemeId: 'emerald-dark',

  setActiveThemeId: (id) => {
    const theme = get().themes.find(t => t.id === id);
    if (theme) {
      set({ activeThemeId: id });
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

        // Ensure the active theme gets applied at least once, or fallback to the loaded one
        const active = get().themes.find(t => t.id === get().activeThemeId);
        if (active) {
          get().applyTheme(active);
        }
      }
    } catch (error) {
      console.error('Failed to load external theme.json:', error);
      // Still apply default
      const active = get().themes.find(t => t.id === get().activeThemeId);
      if (active) get().applyTheme(active);
    }
  }
}));

