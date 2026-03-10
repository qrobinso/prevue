import React, { useEffect, useRef, useCallback } from 'react';
import type { ScheduleProgram } from '../../types';
import { getCatchUpEnabled } from '../Settings/GeneralSettings';
import { getCatchUpSummary } from '../../services/api';
import { useBottomNotifications } from './BottomNotificationManager';

interface CatchUpOverlayProps {
  program: ScheduleProgram;
  channelId: number;
  /** Set to true when a manual trigger (keyboard shortcut) fires. Reset by parent. */
  manualTrigger?: boolean;
  /** Called after manual trigger is consumed so parent can reset the flag. */
  onManualTriggerConsumed?: () => void;
  /** When true the notification is suppressed (e.g. metadata overlay is visible). */
  hidden?: boolean;
}

const NOTIFICATION_ID = 'catch-up';
const NOTIFICATION_PRIORITY = 15; // Between starting-soon (10) and iconic scenes (20)
const TRIGGER_DELAY_MS = 15_000; // Wait 15s before triggering LLM call
const MIN_ELAPSED_MINUTES = 5; // Don't trigger if movie just started
const AUTO_DISMISS_MS = 45_000;
const MANUAL_COOLDOWN_MS = 60_000; // 1 minute between fresh LLM calls

/** Inline spinner rendered as notification meta while loading. */
function LoadingMeta() {
  return React.createElement('div', { className: 'catch-up-loading' },
    React.createElement('div', { className: 'catch-up-spinner' }),
    React.createElement('span', { className: 'catch-up-loading-text' }, 'Getting you up to speed...')
  );
}

/** Cached result for a program so we can re-show or refresh. */
interface CachedResult {
  mediaItemId: string;
  summary: string;
  fetchedAt: number; // Date.now() when this was fetched
}

export default function CatchUpOverlay({ program, channelId, manualTrigger, onManualTriggerConsumed, hidden }: CatchUpOverlayProps) {
  const { show, hide } = useBottomNotifications();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const fetchingRef = useRef(false);
  const autoTriggeredRef = useRef<Set<string>>(new Set()); // tracks auto-trigger per program
  const cachedRef = useRef<CachedResult | null>(null);

  // Called by BottomNotificationManager when user explicitly dismisses (X, swipe, auto-dismiss)
  const handleUserDismiss = useCallback(() => {
    activeRef.current = false;
  }, []);

  const showNotification = useCallback((prog: ScheduleProgram, summary: string) => {
    activeRef.current = true;
    show(NOTIFICATION_ID, NOTIFICATION_PRIORITY, {
      label: 'WHAT DID I MISS',
      labelColor: '#4fc3f7',
      title: prog.title,
      subtitle: summary,
      autoDismissMs: AUTO_DISMISS_MS,
      pauseOnHover: true,
      onDismiss: handleUserDismiss,
      className: 'bottom-notification--catch-up',
    });
  }, [show, handleUserDismiss]);

  const showLoading = useCallback((prog: ScheduleProgram) => {
    activeRef.current = true;
    show(NOTIFICATION_ID, NOTIFICATION_PRIORITY, {
      label: 'WHAT DID I MISS',
      labelColor: '#4fc3f7',
      title: prog.title,
      meta: React.createElement(LoadingMeta),
      autoDismissMs: 0,
      pauseOnHover: true,
      onDismiss: handleUserDismiss,
      className: 'bottom-notification--catch-up',
    });
  }, [show, handleUserDismiss]);

  const doFetchAndShow = useCallback(async (prog: ScheduleProgram) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const startMs = prog.start_ms ?? new Date(prog.start_time).getTime();
    const elapsedMin = (Date.now() - startMs) / 60_000;
    const durationMin = Math.round(prog.duration_ms / 60_000);

    showLoading(prog);

    try {
      console.log(`[CatchUp] Fetching summary for "${prog.title}" (${Math.round(elapsedMin)}min elapsed)`);
      const { summary } = await getCatchUpSummary({
        mediaItemId: prog.media_item_id,
        title: prog.title,
        year: prog.year ?? null,
        elapsedMinutes: Math.round(elapsedMin),
        durationMinutes: durationMin,
      });

      cachedRef.current = {
        mediaItemId: prog.media_item_id,
        summary,
        fetchedAt: Date.now(),
      };

      showNotification(prog, summary);
    } catch (err) {
      console.warn('[CatchUp] Failed to fetch summary:', err);
      hide(NOTIFICATION_ID);
      activeRef.current = false;
    } finally {
      fetchingRef.current = false;
    }
  }, [showLoading, showNotification, hide]);

  // Handle manual trigger (M key)
  useEffect(() => {
    if (!manualTrigger) return;
    onManualTriggerConsumed?.();

    if (!getCatchUpEnabled()) {
      activeRef.current = true;
      show(NOTIFICATION_ID, NOTIFICATION_PRIORITY, {
        label: 'WHAT DID I MISS',
        labelColor: '#4fc3f7',
        title: 'Feature not enabled',
        subtitle: 'Turn on "What Did I Miss" in Settings \u2192 AI to use this feature.',
        autoDismissMs: 5000,
        onDismiss: handleUserDismiss,
        className: 'bottom-notification--catch-up',
      });
      return;
    }

    // If notification is currently showing, dismiss it (toggle behavior)
    if (activeRef.current) {
      hide(NOTIFICATION_ID);
      activeRef.current = false;
      return;
    }

    const cached = cachedRef.current;
    const hasCachedForThis = cached && cached.mediaItemId === program.media_item_id;
    const cooldownActive = hasCachedForThis && (Date.now() - cached.fetchedAt) < MANUAL_COOLDOWN_MS;

    if (cooldownActive) {
      // Within 1min cooldown — re-show the last result
      showNotification(program, cached.summary);
    } else {
      // Past cooldown or no cache — fetch fresh
      doFetchAndShow(program);
    }
  }, [manualTrigger, program, doFetchAndShow, showNotification, show, onManualTriggerConsumed]);

  // On program/channel change: always dismiss any active notification and clear timer
  useEffect(() => {
    // Cleanup from previous program runs first (via return below),
    // then set up for new program.

    // Clear any previous notification immediately
    if (activeRef.current) {
      hide(NOTIFICATION_ID);
      activeRef.current = false;
    }

    if (!getCatchUpEnabled()) return;
    if (program.content_type !== 'movie') return;
    if (autoTriggeredRef.current.has(program.media_item_id)) return;

    const startMs = program.start_ms ?? new Date(program.start_time).getTime();
    const elapsedMin = (Date.now() - startMs) / 60_000;

    if (elapsedMin < MIN_ELAPSED_MINUTES) return;

    console.log(`[CatchUp] Eligible: "${program.title}" (${Math.round(elapsedMin)}min in). Starting ${TRIGGER_DELAY_MS / 1000}s timer...`);

    timerRef.current = setTimeout(() => {
      if (!getCatchUpEnabled()) return;
      if (autoTriggeredRef.current.has(program.media_item_id)) return;
      autoTriggeredRef.current.add(program.media_item_id);
      doFetchAndShow(program);
    }, TRIGGER_DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (activeRef.current) {
        hide(NOTIFICATION_ID);
        activeRef.current = false;
      }
    };
  }, [program.media_item_id, channelId, doFetchAndShow, hide]);

  // Hide based on hidden prop
  useEffect(() => {
    if (hidden && activeRef.current) {
      hide(NOTIFICATION_ID);
    }
  }, [hidden, hide]);

  // Cleanup on unmount
  useEffect(() => {
    return () => hide(NOTIFICATION_ID);
  }, [hide]);

  return null;
}
