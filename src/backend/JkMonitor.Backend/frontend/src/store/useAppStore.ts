import { create } from 'zustand';

interface ThemeConfig {
  themeName: string;
  mode: 'light' | 'dark' | 'system';
  radius: string;
  colors: Record<string, string>;
}

interface AppState {
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  theme: 'light' | 'dark' | 'system';
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  loadThemeConfig: () => Promise<void>;
  themeConfig: ThemeConfig | null;
}

export const useAppStore = create<AppState>((set) => ({
  isSidebarOpen: true,
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  theme: 'dark', // Default fallback
  setTheme: (theme) => set({ theme }),
  themeConfig: null,
  loadThemeConfig: async () => {
    try {
      const response = await fetch('/theme.json?nocache=' + new Date().getTime());
      if (response.ok) {
        const config: ThemeConfig = await response.json();
        
        set({ theme: config.mode, themeConfig: config });
        
        const root = document.documentElement;
        if (config.mode === 'dark') {
          root.classList.add('dark');
        } else if (config.mode === 'light') {
          root.classList.remove('dark');
        }

        if (config.radius) {
          root.style.setProperty('--radius', config.radius);
        }
        
        if (config.colors) {
          Object.entries(config.colors).forEach(([key, value]) => {
            root.style.setProperty(key, value);
          });
        }
      }
    } catch (error) {
      console.error('Failed to load theme.json:', error);
    }
  }
}));
