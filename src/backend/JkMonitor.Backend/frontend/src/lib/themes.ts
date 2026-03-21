export interface ThemeConfig {
  id: string;
  themeName: string;
  mode: 'light' | 'dark';
  radius: string;
  colors: Record<string, string>;
}

export const builtInThemes: ThemeConfig[] = [
  {
    id: "emerald-dark",
    themeName: "Emerald Tech",
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
