interface FluxMonitorDesktop {
  isDesktop: boolean;
  platform: string;
  savedTheme: { id: string; mode: string; radius: string; colors: Record<string, string> } | null;
  saveThemeConfig: (snapshot: {
    id: string;
    mode: string;
    radius: string;
    colors: Record<string, string>;
  }) => void;
}

interface Window {
  fluxMonitorDesktop?: FluxMonitorDesktop;
}
