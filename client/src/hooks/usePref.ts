import { useCallback } from 'react';
import { useProfile } from '../contexts/ProfileContext';

/**
 * Read and write one per-profile preference.
 *
 * Mirrors useState's shape so migrating a localStorage call site is mechanical.
 * Returns defaultValue until the profile's prefs blob has loaded, and whenever
 * the stored value's type does not match the default — which keeps a corrupt or
 * stale blob from breaking first render.
 */
export function usePref<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const { prefs, setPref } = useProfile();

  const stored = prefs[key];
  const value =
    stored !== undefined && typeof stored === typeof defaultValue ? (stored as T) : defaultValue;

  const set = useCallback((next: T) => setPref(key, next), [key, setPref]);

  return [value, set];
}
