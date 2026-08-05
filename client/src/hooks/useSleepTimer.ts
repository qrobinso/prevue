import { useState, useEffect, useCallback, useRef } from 'react';
import { usePref } from './usePref';

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
  const [enabled] = usePref('sleep_enabled', true);
  const [active, setActive] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const [totalMs, setTotalMs] = useState(0);
  const [isExpired, setIsExpired] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [lastPreset, setLastPreset] = usePref('sleep_preset', 30);
  const [windDownMin] = usePref('sleep_winddown_min', 5);
  const [dimSec] = usePref('sleep_dim_sec', 60);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const snoozePromptedRef = useRef(false);

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
    snoozePromptedRef.current = false;
  }, [clearTimer, setLastPreset]);

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
