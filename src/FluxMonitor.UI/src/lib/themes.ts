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
    radius: "0.45rem",
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
    id: "emerald-dark",
    themeName: "Emerald Tech",
    description: "Dark monitor palette with balanced emerald highlights.",
    mode: "dark",
    radius: "0.5rem",
    colors: {
      "--background": "#09090b",
      "--foreground": "#fafafa",
      "--primary": "#10b981", 
      "--primary-foreground": "#052e16",
      "--muted": "#27272a",
      "--muted-foreground": "#a1a1aa",
      "--border": "#27272a",
      "--card": "#09090b",
      "--card-foreground": "#fafafa"
    }
  },
  {
    id: "cyber-punk",
    themeName: "Cyberpunk",
    description: "High-contrast noir with neon red and cyan terminals.",
    mode: "dark",
    radius: "0rem",
    colors: {
      "--background": "#000000",
      "--foreground": "#00ffcc",
      "--primary": "#ff003c", 
      "--primary-foreground": "#000000",
      "--muted": "#111111",
      "--muted-foreground": "#009977",
      "--border": "#ff003c",
      "--card": "#050505",
      "--card-foreground": "#00ffcc"
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
  },
  {
    id: "monochrome-pro",
    themeName: "Monochrome Pro",
    description: "Minimal black and white workspace with restrained contrast.",
    mode: "light",
    radius: "0.25rem",
    colors: {
      "--background": "#ffffff",
      "--foreground": "#000000",
      "--primary": "#000000", 
      "--primary-foreground": "#ffffff",
      "--muted": "#f1f5f9",
      "--muted-foreground": "#475569",
      "--border": "#e2e8f0",
      "--card": "#ffffff",
      "--card-foreground": "#000000"
    }
  },
  {
    id: "solarized-dark",
    themeName: "Solarized Shadow",
    description: "Muted solarized dark tones with warm amber accents.",
    mode: "dark",
    radius: "0.5rem",
    colors: {
      "--background": "#002b36",
      "--foreground": "#839496",
      "--primary": "#b58900", 
      "--primary-foreground": "#002b36",
      "--muted": "#073642",
      "--muted-foreground": "#586e75",
      "--border": "#073642",
      "--card": "#002b36",
      "--card-foreground": "#839496"
    }
  }
];
