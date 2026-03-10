// Auto-tune service: localStorage persistence + helpers for "Just Watch" mode
// Follows the same pattern as useVolume.ts (localStorage + custom events)

const AUTO_TUNE_KEY = 'prevue_auto_tune';
const LAST_CHANNEL_KEY = 'prevue_last_channel_number';

export const AUTO_TUNE_CHANGE_EVENT = 'prevue_auto_tune_change';

export function isAutoTuneEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_TUNE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setAutoTuneEnabled(enabled: boolean): void {
  localStorage.setItem(AUTO_TUNE_KEY, String(enabled));
  window.dispatchEvent(new CustomEvent(AUTO_TUNE_CHANGE_EVENT, { detail: { enabled } }));
}

export function getPersistedChannelNumber(): number | null {
  try {
    const stored = localStorage.getItem(LAST_CHANNEL_KEY);
    if (stored === null) return null;
    const num = parseInt(stored, 10);
    return Number.isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

export function setPersistedChannelNumber(num: number): void {
  localStorage.setItem(LAST_CHANNEL_KEY, String(num));
}
