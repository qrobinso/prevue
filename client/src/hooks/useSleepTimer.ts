import { useState, useEffect, useCallback, useRef } from 'react';

// ─── localStorage keys ───────────────────────────────
const SLEEP_ENABLED_KEY = 'prevue_sleep_enabled';
const SLEEP_PRESET_KEY = 'prevue_sleep_preset';
const SLEEP_WINDDOWN_KEY = 'prevue_sleep_winddown_min';
const SLEEP_DIM_KEY = 'prevue_sleep_dim_sec';

// ─── Exported getters / setters (Settings tab reads these) ───

export function getSleepEnabled(): boolean {
  try { return localStorage.getItem(SLEEP_ENABLED_KEY) !== 'false'; } catch { return true; }
}
export function setSleepEnabled(v: boolean): void {
  localStorage.setItem(SLEEP_ENABLED_KEY, String(v));
  window.dispatchEvent(new CustomEvent('prevue_sleep_settings_change'));
}

export function getStoredPreset(): number {
  try {
    const n = parseInt(localStorage.getItem(SLEEP_PRESET_KEY) ?? '', 10);
    if (!Number.isNaN(n) && n > 0) return n;
  } catch {}
  return 30;
}
export function setStoredPreset(minutes: number): void {
  localStorage.setItem(SLEEP_PRESET_KEY, String(minutes));
}

export function getWindDownMinutes(): number {
  try {
    const n = parseInt(localStorage.getItem(SLEEP_WINDDOWN_KEY) ?? '', 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  } catch {}
  return 5; // default 5 minutes
}
export function setWindDownMinutes(v: number): void {
  localStorage.setItem(SLEEP_WINDDOWN_KEY, String(v));
  window.dispatchEvent(new CustomEvent('prevue_sleep_settings_change'));
}

export function getDimSeconds(): number {
  try {
    const n = parseInt(localStorage.getItem(SLEEP_DIM_KEY) ?? '', 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  } catch {}
  return 60; // default 60 seconds
}
export function setDimSeconds(v: number): void {
  localStorage.setItem(SLEEP_DIM_KEY, String(v));
  window.dispatchEvent(new CustomEvent('prevue_sleep_settings_change'));
}

// ─── Constants ───────────────────────────────────────
export const SLEEP_PRESETS = [15, 30, 45, 60, 90, 120] as const;
export const WINDDOWN_OPTIONS = [0, 1, 2, 3, 5, 10] as const;   // minutes
export const DIM_OPTIONS = [0, 15, 30, 60, 90, 120] as const;    // seconds

// ─── Types ───────────────────────────────────────────
export interface SleepTimerState {
  /** Feature enabled in settings */
  enabled: boolean;
  active: boolean;
  remainingMs: number;
  totalMs: number;
  isWindingDown: boolean;
  isDimming: boolean;
  isExpired: boolean;
  showPicker: boolean;
  lastPreset: number;
  /** 0-1, how much to dim the screen (0 = none, 1 = fully dimmed) */
  dimOpacity: number;
  /** 0-1, volume multiplier during wind-down (1 = full, 0 = silent) */
  volumeMultiplier: number;
  /** Current configurable durations */
  windDownMinutes: number;
  dimSeconds: number;
}

export interface SleepTimerActions {
  start: (minutes: number) => void;
  cancel: () => void;
  snooze: (minutes?: number) => void;
  togglePicker: () => void;
  closePicker: () => void;
  onUserActivity: () => void;
}

// ─── Hook ────────────────────────────────────────────
export function useSleepTimer(): [SleepTimerState, SleepTimerActions] {
  const [enabled, setEnabledState] = useState(getSleepEnabled);
  const [active, setActive] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [isExpired, setIsExpired] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [lastPreset, setLastPreset] = useState(getStoredPreset);
  const [windDownMin, setWindDownMin] = useState(getWindDownMinutes);
  const [dimSec, setDimSec] = useState(getDimSeconds);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const snoozePromptedRef = useRef(false);

  // Listen for settings changes from the Timer settings tab
  useEffect(() => {
    const handler = () => {
      setEnabledState(getSleepEnabled());
      setWindDownMin(getWindDownMinutes());
      setDimSec(getDimSeconds());
    };
    window.addEventListener('prevue_sleep_settings_change', handler);
    return () => window.removeEventListener('prevue_sleep_settings_change', handler);
  }, []);

  // If feature gets disabled while timer is active, cancel it
  useEffect(() => {
    if (!enabled && active) {
      clearTimer();
      setActive(false);
      setRemainingMs(0);
      setTotalMs(0);
      setIsExpired(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const windDownMs = windDownMin * 60 * 1000;
  const dimStartMs = dimSec * 1000;

  const isWindingDown = active && remainingMs > 0 && windDownMs > 0 && remainingMs <= windDownMs;
  const isDimming = active && remainingMs > 0 && dimStartMs > 0 && remainingMs <= dimStartMs;

  const dimOpacity = isDimming ? Math.min(0.95, (1 - remainingMs / dimStartMs) * 0.95) : 0;
  const volumeMultiplier = isWindingDown ? Math.max(0, remainingMs / windDownMs) : 1;

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const start = useCallback((minutes: number) => {
    clearTimer();
    const ms = minutes * 60 * 1000;
    setTotalMs(ms);
    setRemainingMs(ms);
    setActive(true);
    setIsExpired(false);
    setShowPicker(false);
    setLastPreset(minutes);
    setStoredPreset(minutes);
    snoozePromptedRef.current = false;
  }, [clearTimer]);

  const cancel = useCallback(() => {
    clearTimer();
    setActive(false);
    setRemainingMs(0);
    setTotalMs(0);
    setIsExpired(false);
    snoozePromptedRef.current = false;
  }, [clearTimer]);

  const snooze = useCallback((minutes = 15) => {
    setRemainingMs(prev => prev + minutes * 60 * 1000);
    setTotalMs(prev => prev + minutes * 60 * 1000);
    setIsExpired(false);
    snoozePromptedRef.current = false;
  }, []);

  const togglePicker = useCallback(() => {
    if (!enabled) return;
    setShowPicker(prev => !prev);
  }, [enabled]);

  const closePicker = useCallback(() => {
    setShowPicker(false);
  }, []);

  const onUserActivity = useCallback(() => {
    if (!isWindingDown || snoozePromptedRef.current) return;
    snoozePromptedRef.current = true;
  }, [isWindingDown]);

  // Countdown interval
  useEffect(() => {
    if (!active || isExpired) return;
    intervalRef.current = setInterval(() => {
      setRemainingMs(prev => {
        const next = prev - 1000;
        if (next <= 0) {
          clearTimer();
          setIsExpired(true);
          setActive(false);
          return 0;
        }
        return next;
      });
    }, 1000);
    return clearTimer;
  }, [active, isExpired, clearTimer]);

  const state: SleepTimerState = {
    enabled,
    active,
    remainingMs,
    totalMs,
    isWindingDown,
    isDimming,
    isExpired,
    showPicker,
    lastPreset,
    dimOpacity,
    volumeMultiplier,
    windDownMinutes: windDownMin,
    dimSeconds: dimSec,
  };

  const actions: SleepTimerActions = {
    start, cancel, snooze, togglePicker, closePicker, onUserActivity,
  };

  return [state, actions];
}

/** Format milliseconds as MM:SS */
export function formatSleepRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}
