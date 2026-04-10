import { builtInThemes, type ThemeConfig } from './themes';

export const themeStorageKey = 'FluxMonitor-theme';
export const defaultThemeId = 'tactical-slate';

function getStorage(storageOverride?: Pick<Storage, 'getItem'> | null): Pick<Storage, 'getItem'> | null {
  if (storageOverride !== undefined) {
    return storageOverride;
  }

  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getStoredThemeId(storageOverride?: Pick<Storage, 'getItem'> | null): string {
  const storage = getStorage(storageOverride);
  return storage?.getItem(themeStorageKey) || defaultThemeId;
}

export function findThemeById(id: string, themes: ThemeConfig[] = builtInThemes): ThemeConfig | undefined {
  return themes.find((theme) => theme.id === id);
}

export function applyThemeToDocument(theme: ThemeConfig, targetDocument: Document = document): void {
  const root = targetDocument.documentElement;
  root.dataset.theme = theme.id;

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

  root.style.colorScheme = theme.mode;

  const background = theme.colors?.['--background'] ?? (theme.mode === 'dark' ? '#09090b' : '#f8fafc');
  const meta = targetDocument.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', background);
  }
}
