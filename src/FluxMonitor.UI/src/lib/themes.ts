export interface ThemeConfig {
  id: string;
  themeName: string;
  description?: string;
  mode: 'light' | 'dark';
  radius: string;
  colors: Record<string, string>;
}

export const builtInThemes: ThemeConfig[] = [
  {
    id: "tactical-slate",
    themeName: "Tactical Slate",
    description: "Operational slate panels, mono telemetry, and lime system accents.",
    mode: "dark",
    radius: "0rem",
    colors: {
      "--background": "#080b10",
      "--foreground": "#edf1d5",
      "--card": "#12161d",
      "--card-foreground": "#edf1d5",
      "--popover": "#141921",
      "--popover-foreground": "#edf1d5",
      "--primary": "#c5ff41",
      "--primary-foreground": "#0b0d0f",
      "--secondary": "#181d24",
      "--secondary-foreground": "#d5dbc1",
      "--muted": "#151a21",
      "--muted-foreground": "#8d947c",
      "--accent": "#202630",
      "--accent-foreground": "#edf1d5",
      "--destructive": "#ff6b70",
      "--border": "#2c3440",
      "--input": "#242b35",
      "--ring": "#c5ff41",
      "--chart-1": "#c5ff41",
      "--chart-2": "#7de2d1",
      "--chart-3": "#f7b955",
      "--chart-4": "#6fa8ff",
      "--chart-5": "#ff6b70",
      "--sidebar": "#10141b",
      "--sidebar-foreground": "#e6ebcf",
      "--sidebar-primary": "#c5ff41",
      "--sidebar-primary-foreground": "#0b0d0f",
      "--sidebar-accent": "#1b212b",
      "--sidebar-accent-foreground": "#edf1d5",
      "--sidebar-border": "#2b313c",
      "--sidebar-ring": "#c5ff41"
    }
  },
  {
    id: "ocean-light",
    themeName: "Ocean Clean",
    description: "Airy light surfaces with crisp blue controls.",
    mode: "light",
    radius: "0.75rem",
    colors: {
      "--background": "#f8fafc",
      "--foreground": "#0f172a",
      "--primary": "#0ea5e9", 
      "--primary-foreground": "#f8fafc",
      "--muted": "#e2e8f0",
      "--muted-foreground": "#64748b",
      "--border": "#cbd5e1",
      "--card": "#ffffff",
      "--card-foreground": "#0f172a"
    }
  }
];
