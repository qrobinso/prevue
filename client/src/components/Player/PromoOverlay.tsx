import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, ScheduleProgram } from '../../types';
import { sanitizeImageUrl } from '../../utils/sanitize';
import { ArrowRight } from '@phosphor-icons/react';
import { useBottomNotifications } from './BottomNotificationManager';
import './Player.css';

export interface PromoOverlayHandle {
  trigger: () => void;
}

/** Duration the "Starting Soon" card stays on screen (ms). */
const STARTING_SOON_DURATION_MS = 10_000;
const STARTING_SOON_ID = 'starting-soon';
const STARTING_SOON_PRIORITY = 10; // Lower than iconic scene (20)

const PROMO_ID = 'promo-card';
const PROMO_PRIORITY = 5; // Lower than starting-soon (10) and iconic scene (20)

interface PromoOverlayProps {
  currentProgram: ScheduleProgram;
  upcomingPrograms: ScheduleProgram[];
  isInterstitial: boolean;
  enabled: boolean;
  /** Separate toggle for "Starting Soon" cross-channel notifications */
  startingSoonEnabled: boolean;
  creditsVisible: boolean;
  /** Full schedule map for cross-channel "Starting Soon" lookup */
  scheduleByChannel?: Map<number, ScheduleProgram[]>;
  /** Channel list for resolving channel names */
  channels?: Channel[];
  /** Current channel ID so we skip it when searching other channels */
  currentChannelId?: number;
  /** Ref handle for imperative trigger (e.g. keyboard shortcut) */
  triggerRef?: React.MutableRefObject<PromoOverlayHandle | null>;
  /** Called when user clicks a "Starting Soon" promo — receives the target channel ID */
  onTuneChannel?: (channelId: number) => void;
}

/** Return the next :00 and :30 wall-clock marks that fall within the program window. */
function schedulePromoTimes(startMs: number, endMs: number): number[] {
  const now = Date.now();
  const effectiveStart = Math.max(startMs, now) + 30_000;
  const effectiveEnd = endMs - 120_000;

  if (effectiveEnd <= effectiveStart) return [];

  const firstMark = new Date(effectiveStart);
  firstMark.setSeconds(0, 0);
  if (firstMark.getMinutes() % 30 !== 0) {
    const m = firstMark.getMinutes();
    firstMark.setMinutes(m < 30 ? 30 : 60);
  }
  if (firstMark.getTime() < effectiveStart) {
    firstMark.setMinutes(firstMark.getMinutes() + 30);
  }

  const times: number[] = [];
  let t = firstMark.getTime();
  while (t <= effectiveEnd) {
    times.push(t);
    t += 30 * 60 * 1000;
  }

  return times;
}

function relevanceScore(
  candidate: ScheduleProgram,
  currentGenres: string[],
  currentRating: string | null,
): number {
  let score = 0;
  if (currentGenres.length > 0 && candidate.genres?.length) {
    for (const g of candidate.genres) {
      if (currentGenres.includes(g)) score += 2;
    }
  }
  if (currentRating && candidate.rating === currentRating) {
    score += 1;
  }
  return score;
}

function findStartingSoon(
  scheduleByChannel: Map<number, ScheduleProgram[]>,
  currentChannelId: number,
  currentProgram: ScheduleProgram,
): { program: ScheduleProgram; channelId: number } | null {
  const now = Date.now();
  const oneMinFromNow = now + 60_000;
  const currentGenres = currentProgram.genres ?? [];
  const currentRating = currentProgram.rating;
  const contentType = currentProgram.content_type;

  let best: {
    program: ScheduleProgram;
    channelId: number;
    score: number;
    startsAt: number;
  } | null = null;

  for (const [channelId, programs] of scheduleByChannel) {
    if (channelId === currentChannelId) continue;
    for (const p of programs) {
      if (p.type !== 'program') continue;
      const startMs = p.start_ms ?? new Date(p.start_time).getTime();
      if (startMs <= now || startMs > oneMinFromNow) continue;
      if (contentType && p.content_type !== contentType) continue;
      const score = relevanceScore(p, currentGenres, currentRating);
      if (!best || score > best.score || (score === best.score && startMs < best.startsAt)) {
        best = { program: p, channelId, score, startsAt: startMs };
      }
    }
  }

  return best ? { program: best.program, channelId: best.channelId } : null;
}

const SLOT_DURATION_MS = 5000;

type Phase = 'now' | 'next';

export default function PromoOverlay({
  currentProgram,
  upcomingPrograms,
  isInterstitial,
  enabled,
  startingSoonEnabled,
  creditsVisible,
  scheduleByChannel,
  channels,
  currentChannelId,
  triggerRef,
  onTuneChannel,
}: PromoOverlayProps) {
  const [phase, setPhase] = useState<Phase>('now');

  const scheduledTimesRef = useRef<number[]>([]);
  const programIdRef = useRef<string | null>(null);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAppearanceRef = useRef<() => void>(() => {});
  const startingSoonShownRef = useRef<string | null>(null);
  const startingSoonLastShownAt = useRef<number>(0);
  const programStartedAtRef = useRef<number>(Date.now());
  const promoVisibleRef = useRef(false);

  const { show: showNotification, hide: hideNotification } = useBottomNotifications();

  const clearSequenceTimer = useCallback(() => {
    if (sequenceTimerRef.current) {
      clearTimeout(sequenceTimerRef.current);
      sequenceTimerRef.current = null;
    }
  }, []);

  const nextProgram = upcomingPrograms[0] ?? null;

  const hidePromo = useCallback(() => {
    promoVisibleRef.current = false;
    hideNotification(PROMO_ID);
  }, [hideNotification]);

  const showPromoForProgram = useCallback((prog: ScheduleProgram, label: string) => {
    const backdropUrl = prog.backdrop_url || prog.thumbnail_url || prog.banner_url;
    const hdBackdrop = backdropUrl
      ? sanitizeImageUrl(backdropUrl + (backdropUrl.includes('?') ? '&' : '?') + 'maxWidth=960') || undefined
      : undefined;

    promoVisibleRef.current = true;
    showNotification(PROMO_ID, PROMO_PRIORITY, {
      label,
      labelColor: 'var(--text-gold)',
      title: prog.title,
      subtitle: prog.subtitle || undefined,
      meta: (
        <>
          {prog.year && <span className="bottom-notification-chip">{prog.year}</span>}
          {prog.rating && <span className="bottom-notification-chip">{prog.rating}</span>}
        </>
      ),
      backdropUrl: hdBackdrop,
      className: 'bottom-notification--promo',
      autoDismissMs: 0, // managed by our own sequence timer
    });
  }, [showNotification]);

  // Start the two-phase promo card appearance sequence
  const startAppearance = useCallback(() => {
    if (isInterstitial || creditsVisible || !enabled) return;

    clearSequenceTimer();
    setPhase('now');
    showPromoForProgram(currentProgram, "YOU'RE WATCHING");

    if (nextProgram) {
      sequenceTimerRef.current = setTimeout(() => {
        setPhase('next');
        showPromoForProgram(nextProgram, 'COMING UP NEXT');
        sequenceTimerRef.current = setTimeout(() => {
          hidePromo();
        }, SLOT_DURATION_MS);
      }, SLOT_DURATION_MS);
    } else {
      sequenceTimerRef.current = setTimeout(() => {
        hidePromo();
      }, SLOT_DURATION_MS);
    }
  }, [currentProgram, nextProgram, isInterstitial, creditsVisible, enabled, clearSequenceTimer, showPromoForProgram, hidePromo]);

  startAppearanceRef.current = startAppearance;

  // Expose imperative trigger handle
  useEffect(() => {
    if (triggerRef) {
      triggerRef.current = { trigger: startAppearance };
    }
    return () => {
      if (triggerRef) triggerRef.current = null;
    };
  }, [triggerRef, startAppearance]);

  // Schedule promo appearances when program changes
  useEffect(() => {
    const programId = currentProgram.media_item_id;
    if (programId === programIdRef.current) return;
    programIdRef.current = programId;
    programStartedAtRef.current = Date.now();

    hidePromo();
    clearSequenceTimer();
    startingSoonShownRef.current = null;
    hideNotification(STARTING_SOON_ID);

    if (!enabled || currentProgram.type === 'interstitial') {
      scheduledTimesRef.current = [];
      return;
    }

    const startMs = currentProgram.start_ms ?? new Date(currentProgram.start_time).getTime();
    const endMs = currentProgram.end_ms ?? new Date(currentProgram.end_time).getTime();
    scheduledTimesRef.current = schedulePromoTimes(startMs, endMs);

    const interval = setInterval(() => {
      const now = Date.now();
      const times = scheduledTimesRef.current;
      const idx = times.findIndex((t) => t <= now);
      if (idx >= 0) {
        scheduledTimesRef.current = times.filter((_, i) => i !== idx);
        startAppearanceRef.current();
      }
    }, 1000);

    return () => {
      clearInterval(interval);
      clearSequenceTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProgram.media_item_id, currentProgram.start_time, currentProgram.end_time, currentProgram.start_ms, currentProgram.end_ms, currentProgram.type, enabled, clearSequenceTimer]);

  // "Starting Soon" — check every second for a matching program about to start on another channel
  useEffect(() => {
    if (!startingSoonEnabled || !scheduleByChannel || !channels || currentChannelId == null) return;

    const COOLDOWN_MS = 3 * 60 * 1000;
    const INITIAL_DELAY_MS = 15_000;

    const interval = setInterval(() => {
      if (isInterstitial || creditsVisible || promoVisibleRef.current) return;

      if (Date.now() - programStartedAtRef.current < INITIAL_DELAY_MS) return;
      if (Date.now() - startingSoonLastShownAt.current < COOLDOWN_MS) return;

      const match = findStartingSoon(scheduleByChannel, currentChannelId, currentProgram);
      if (!match) return;

      if (match.program.media_item_id === startingSoonShownRef.current) return;
      startingSoonShownRef.current = match.program.media_item_id;
      startingSoonLastShownAt.current = Date.now();

      const ch = channels.find((c) => c.id === match.channelId);
      const channelName = ch ? `CH ${ch.number} ${ch.name}` : null;
      const ssClickable = match.channelId != null && !!onTuneChannel;

      const ssBackdropUrl = match.program.backdrop_url || match.program.thumbnail_url || match.program.banner_url;
      const ssHdBackdrop = ssBackdropUrl
        ? sanitizeImageUrl(ssBackdropUrl + (ssBackdropUrl.includes('?') ? '&' : '?') + 'maxWidth=1280') || undefined
        : undefined;

      showNotification(STARTING_SOON_ID, STARTING_SOON_PRIORITY, {
        label: 'STARTING SOON',
        labelColor: undefined, // uses CSS default (cyan via modifier)
        title: match.program.title,
        subtitle: match.program.subtitle || undefined,
        meta: (
          <>
            {channelName && <span className="bottom-notification-channel">{channelName}</span>}
            {match.program.year && <span className="bottom-notification-chip">{match.program.year}</span>}
            {match.program.rating && <span className="bottom-notification-chip">{match.program.rating}</span>}
            {ssClickable && <span className="bottom-notification-tune">Tune In <ArrowRight size={14} weight="bold" /></span>}
          </>
        ),
        backdropUrl: ssHdBackdrop,
        className: 'bottom-notification--starting-soon',
        autoDismissMs: STARTING_SOON_DURATION_MS,
        pauseOnHover: true,
        onClick: ssClickable ? () => {
          onTuneChannel!(match.channelId);
          hideNotification(STARTING_SOON_ID);
        } : undefined,
      });
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startingSoonEnabled, scheduleByChannel, channels, currentChannelId, currentProgram, isInterstitial, creditsVisible, showNotification, hideNotification, onTuneChannel]);

  // Suppress if conditions change mid-display
  useEffect(() => {
    if (promoVisibleRef.current && (isInterstitial || creditsVisible || !enabled)) {
      hidePromo();
      clearSequenceTimer();
    }
    if (isInterstitial || creditsVisible) {
      hideNotification(STARTING_SOON_ID);
    }
  }, [isInterstitial, creditsVisible, enabled, clearSequenceTimer, hideNotification, hidePromo]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      hideNotification(STARTING_SOON_ID);
      hideNotification(PROMO_ID);
    };
  }, [hideNotification]);

  return null; // All rendering handled by BottomNotificationProvider
}
