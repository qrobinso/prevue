import { useCallback } from 'react';
import { useProfile } from '../contexts/ProfileContext';

// Cheap shape classifier: distinguishes null, arrays, and plain objects from
// one another (typeof alone reports 'object' for all three). Not a deep
// schema check — just enough to keep a corrupt/stale value from reaching a
// consumer that expects a specific shape (e.g. .map() on an array pref).
type Shape = 'null' | 'array' | 'object' | string;
function shapeOf(v: unknown): Shape {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Read and write one per-profile preference.
 *
 * Mirrors useState's shape so migrating a localStorage call site is mechanical.
 * Returns defaultValue until the profile's prefs blob has loaded, and whenever
 * the stored value's shape does not match the default's — which keeps a corrupt
 * or stale blob (including null, or an object where an array is expected, or
 * vice versa) from breaking first render.
 */
export function usePref<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const { prefs, setPref } = useProfile();

  const stored = prefs[key];
  const value =
    stored !== undefined && shapeOf(stored) === shapeOf(defaultValue) ? (stored as T) : defaultValue;

  const set = useCallback((next: T) => setPref(key, next), [key, setPref]);

  return [value, set];
}
