import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyThemeToDocument, defaultThemeId, getStoredThemeId, themeStorageKey } from './themeRuntime';
import { builtInThemes } from './themes';

describe('themeRuntime', () => {
  const originalThemeColor = document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');

    if (!document.querySelector('meta[name="theme-color"]')) {
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('style');

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      if (originalThemeColor === null) {
        meta.removeAttribute('content');
      } else {
        meta.setAttribute('content', originalThemeColor);
      }
    }
  });

  it('falls back to the default theme id when storage is empty', () => {
    expect(getStoredThemeId()).toBe(defaultThemeId);
  });

  it('applies a theme to the document root and theme-color meta tag', () => {
    const tacticalSlateTheme = builtInThemes.find((theme) => theme.id === 'tactical-slate');
    expect(tacticalSlateTheme).toBeDefined();

    applyThemeToDocument(tacticalSlateTheme!);

    expect(document.documentElement.dataset.theme).toBe('tactical-slate');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--background')).toBe('#0A0B10');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0A0B10');
  });

  it('reads a previously selected theme id from storage', () => {
    localStorage.setItem(themeStorageKey, 'ocean-light');

    expect(getStoredThemeId()).toBe('ocean-light');
  });
});
