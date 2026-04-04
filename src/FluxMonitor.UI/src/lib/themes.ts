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
      "--background": "#0A0B10",
      "--foreground": "#E3E1E9",
      "--card": "#1E1F25",
      "--card-foreground": "#E3E1E9",
      "--popover": "#1E1F25",
      "--popover-foreground": "#E3E1E9",
      "--primary": "#c5ff41",
      "--primary-foreground": "#253500",
      "--secondary": "#292A2F",
      "--secondary-foreground": "#E3E1E9",
      "--muted": "#1A1B21",
      "--muted-foreground": "#8D937B",
      "--accent": "#292A2F",
      "--accent-foreground": "#E3E1E9",
      "--destructive": "#ff6b70",
      "--border": "#34343A",
      "--input": "#1A1B21",
      "--ring": "#c5ff41",
      "--chart-1": "#c5ff41",
      "--chart-2": "#7de2d1",
      "--chart-3": "#f7b955",
      "--chart-4": "#6fa8ff",
      "--chart-5": "#ff6b70",
      "--sidebar": "#0D0E13",
      "--sidebar-foreground": "#E3E1E9",
      "--sidebar-primary": "#c5ff41",
      "--sidebar-primary-foreground": "#253500",
      "--sidebar-accent": "#1A1B21",
      "--sidebar-accent-foreground": "#E3E1E9",
      "--sidebar-border": "#34343A",
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
