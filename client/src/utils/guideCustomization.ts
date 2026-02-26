// ─── Guide Dividers ─────────────────────────────────────
// Dividers are persisted server-side via the settings API.
// localStorage is used as a fast cache for synchronous reads (e.g. GuideGrid mount).

import { updateSettings } from '../services/api';

export interface GuideDivider {
  id: string;
  sort_order: number;
  label: string;
}

const DIVIDERS_KEY = 'prevue_guide_dividers';

export function getGuideDividers(): GuideDivider[] {
  try {
    const raw = localStorage.getItem(DIVIDERS_KEY);
    if (raw) return JSON.parse(raw) as GuideDivider[];
  } catch { /* ignore */ }
  return [];
}

/** Save dividers to localStorage cache + dispatch event. Call persistDividers() after for server sync. */
export function saveGuideDividers(dividers: GuideDivider[]): void {
  try {
    localStorage.setItem(DIVIDERS_KEY, JSON.stringify(dividers));
    window.dispatchEvent(new Event('guidedividerschange'));
  } catch { /* ignore */ }
}

/** Persist dividers to server settings (fire-and-forget). */
export function persistDividers(dividers: GuideDivider[]): void {
  updateSettings({ guide_dividers: dividers }).catch(() => { /* ignore */ });
}

/** Hydrate localStorage cache from server settings data. */
export function hydrateDividersFromServer(serverDividers: GuideDivider[]): void {
  saveGuideDividers(serverDividers);
}

export function createDivider(sortOrder: number, label: string = ''): GuideDivider {
  return {
    id: `div-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sort_order: sortOrder,
    label,
  };
}

// ─── Channel Colors ─────────────────────────────────────
// Per-channel color stored in localStorage. Reflected on guide channel column.

const COLORS_KEY = 'prevue_channel_colors';
const LAST_COLOR_KEY = 'prevue_last_channel_color';

export const CHANNEL_COLOR_PRESETS = [
  { id: 'red',      hex: '#c0392b', label: 'Red' },
  { id: 'orange',   hex: '#d35400', label: 'Orange' },
  { id: 'gold',     hex: '#b7950b', label: 'Gold' },
  { id: 'green',    hex: '#27ae60', label: 'Green' },
  { id: 'teal',     hex: '#16a085', label: 'Teal' },
  { id: 'blue',     hex: '#2980b9', label: 'Blue' },
  { id: 'indigo',   hex: '#4a4de7', label: 'Indigo' },
  { id: 'purple',   hex: '#8e44ad', label: 'Purple' },
  { id: 'pink',     hex: '#c0388f', label: 'Pink' },
  { id: 'slate',    hex: '#4a6274', label: 'Slate' },
] as const;

export function getChannelColors(): Record<number, string> {
  try {
    const raw = localStorage.getItem(COLORS_KEY);
    if (raw) return JSON.parse(raw) as Record<number, string>;
  } catch { /* ignore */ }
  return {};
}

export function saveChannelColors(colors: Record<number, string>): void {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify(colors));
  } catch { /* ignore */ }
}

export function setChannelColor(channelId: number, hex: string): void {
  const colors = getChannelColors();
  colors[channelId] = hex;
  saveChannelColors(colors);
  setLastUsedColor(hex);
  window.dispatchEvent(new Event('channelcolorschange'));
  persistChannelColors(colors);
}

export function clearChannelColor(channelId: number): void {
  const colors = getChannelColors();
  delete colors[channelId];
  saveChannelColors(colors);
  window.dispatchEvent(new Event('channelcolorschange'));
  persistChannelColors(colors);
}

/** Persist channel colors to server settings (fire-and-forget). */
export function persistChannelColors(colors: Record<number, string>): void {
  updateSettings({ channel_colors: colors }).catch(() => { /* ignore */ });
}

/** Hydrate localStorage cache from server settings data. */
export function hydrateChannelColorsFromServer(serverColors: Record<number, string>): void {
  saveChannelColors(serverColors);
  window.dispatchEvent(new Event('channelcolorschange'));
}

export function getLastUsedColor(): string | null {
  try {
    return localStorage.getItem(LAST_COLOR_KEY);
  } catch { /* ignore */ }
  return null;
}

export function setLastUsedColor(hex: string): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, hex);
  } catch { /* ignore */ }
}
