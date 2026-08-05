import { useEffect } from 'react';
import { usePref } from './usePref';

export const THEME_STORAGE_KEY = 'prevue_color_theme';
export const DEFAULT_COLOR_THEME = 'classic';

/**
 * Apply the active profile's colour theme to the document, app-wide.
 *
 * The theme is a per-profile preference, so it must follow whoever is watching
 * rather than the device. This hook lives above the router so the theme applies
 * on every screen — previously `data-theme` was only set by `DisplaySettings`,
 * which mounts on `/settings`, so the guide kept whatever theme the device had
 * cached until you happened to open Settings.
 *
 * `localStorage` is still written, but only as a first-paint hint for the
 * module-eval bootstrap in `DisplaySettings` (avoiding a flash of the wrong
 * theme before prefs load). The profile remains the source of truth.
 */
export function useApplyTheme(): void {
  const [colorTheme] = usePref('color_theme', DEFAULT_COLOR_THEME);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', colorTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, colorTheme);
    } catch {
      // Storage unavailable; the theme still applies for this session.
    }
  }, [colorTheme]);
}
