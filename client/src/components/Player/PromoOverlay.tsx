import { useState, useEffect, useRef, useCallback } from 'react';
import type { Channel, ScheduleProgram } from '../../types';
import { sanitizeImageUrl } from '../../utils/sanitize';
import './Player.css';

export interface PromoOverlayHandle {
  trigger: () => void;
}

/** Duration the "Starting Soon" card stays on screen (ms). */
const STARTING_SOON_DURATION_MS = 10_000;

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

/** Return the next :00 and :30 wall-clock marks that fall within the program window.
 *  Skips marks too close to the start (< 30s in) or end (< 2 min left). */
function schedulePromoTimes(startMs: number, endMs: number): number[] {
  const now = Date.now();
  const effectiveStart = Math.max(startMs, now) + 30_000;   // skip first 30s
  const effectiveEnd = endMs - 120_000;                      // stop 2 min before end

  if (effectiveEnd <= effectiveStart) return [];

  // Find the first :00 or :30 mark at or after effectiveStart
  const firstMark = new Date(effectiveStart);
  firstMark.setSeconds(0, 0);
  if (firstMark.getMinutes() % 30 !== 0) {
    // Round up to next :00 or :30
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
    t += 30 * 60 * 1000; // next :00 or :30
  }

  return times;
}

/** Score how relevant a candidate program is to the current program.
 *  Higher = more relevant. Genre overlap is weighted most, then rating match. */
function relevanceScore(
  candidate: ScheduleProgram,
  currentGenres: string[],
  currentRating: string | null,
): number {
  let score = 0;

  // Genre overlap: +2 per shared genre
  if (currentGenres.length > 0 && candidate.genres?.length) {
    for (const g of candidate.genres) {
      if (currentGenres.includes(g)) score += 2;
    }
  }

  // Rating match: +1
  if (currentRating && candidate.rating === currentRating) {
    score += 1;
  }

  return score;
}

/** Find a program starting soon on another channel, prioritizing genre/rating relevance. */
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
      // Content type must match: movie→movie, episode→episode
      if (contentType && p.content_type !== contentType) continue;

      const score = relevanceScore(p, currentGenres, currentRating);

      // Pick highest relevance, break ties by soonest start
      if (!best || score > best.score || (score === best.score && startMs < best.startsAt)) {
        best = { program: p, channelId, score, startsAt: startMs };
      }
    }
  }

  return best ? { program: best.program, channelId: best.channelId } : null;
}

/** Duration each slot is displayed (ms). */
const SLOT_DURATION_MS = 5000;

type Phase = 'now' | 'next' | 'starting-soon';

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
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>('now');
  const [startingSoonProgram, setStartingSoonProgram] = useState<ScheduleProgram | null>(null);
  const [startingSoonChannelName, setStartingSoonChannelName] = useState<string | null>(null);
  const [startingSoonChannelId, setStartingSoonChannelId] = useState<number | null>(null);

  const scheduledTimesRef = useRef<number[]>([]);
  const programIdRef = useRef<string | null>(null);
  const sequenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startAppearanceRef = useRef<() => void>(() => {});
  const startingSoonShownRef = useRef<string | null>(null);
  const startingSoonLastShownAt = useRef<number>(0);
  const dismissTimerStartedAt = useRef<number>(0);
  const dismissDurationMs = useRef<number>(0);
  const dismissRemainingMs = useRef<number>(0);

  const clearSequenceTimer = useCallback(() => {
    if (sequenceTimerRef.current) {
      clearTimeout(sequenceTimerRef.current);
      sequenceTimerRef.current = null;
    }
  }, []);

  const nextProgram = upcomingPrograms[0] ?? null;

  // Start the two-phase (or three-phase) appearance sequence
  const startAppearance = useCallback(() => {
    if (isInterstitial || creditsVisible || !enabled) return;

    clearSequenceTimer();
    setPhase('now');
    setVisible(true);

    if (nextProgram) {
      // Phase 1: "You're Watching" → Phase 2: "Coming Up Next" → fade out
      sequenceTimerRef.current = setTimeout(() => {
        setPhase('next');
        sequenceTimerRef.current = setTimeout(() => {
          setVisible(false);
        }, SLOT_DURATION_MS);
      }, SLOT_DURATION_MS);
    } else {
      // No next program — just show current then fade out
      sequenceTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, SLOT_DURATION_MS);
    }
  }, [nextProgram, isInterstitial, creditsVisible, enabled, clearSequenceTimer]);

  // Keep ref in sync so the scheduling interval always calls the latest version
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
    const programId = currentProgram.jellyfin_item_id;
    if (programId === programIdRef.current) return;
    programIdRef.current = programId;

    setVisible(false);
    clearSequenceTimer();
    startingSoonShownRef.current = null;

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
  }, [currentProgram.jellyfin_item_id, currentProgram.start_time, currentProgram.end_time, currentProgram.start_ms, currentProgram.end_ms, currentProgram.type, enabled, clearSequenceTimer]);

  // "Starting Soon" — check every second for a matching program about to start on another channel
  useEffect(() => {
    if (!startingSoonEnabled || !scheduleByChannel || !channels || currentChannelId == null) return;

    const COOLDOWN_MS = 3 * 60 * 1000; // 3-minute cooldown between notifications

    const interval = setInterval(() => {
      if (isInterstitial || creditsVisible || visible) return;

      // Enforce cooldown between starting-soon notifications
      if (Date.now() - startingSoonLastShownAt.current < COOLDOWN_MS) return;

      const match = findStartingSoon(scheduleByChannel, currentChannelId, currentProgram);
      if (!match) return;

      // Don't show the same starting-soon program twice
      if (match.program.jellyfin_item_id === startingSoonShownRef.current) return;
      startingSoonShownRef.current = match.program.jellyfin_item_id;
      startingSoonLastShownAt.current = Date.now();

      const ch = channels.find((c) => c.id === match.channelId);
      setStartingSoonProgram(match.program);
      setStartingSoonChannelName(ch ? `CH ${ch.number} ${ch.name}` : null);
      setStartingSoonChannelId(match.channelId);
      setPhase('starting-soon');
      setVisible(true);

      clearSequenceTimer();
      dismissTimerStartedAt.current = Date.now();
      dismissDurationMs.current = STARTING_SOON_DURATION_MS;
      dismissRemainingMs.current = STARTING_SOON_DURATION_MS;
      sequenceTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, STARTING_SOON_DURATION_MS);
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startingSoonEnabled, scheduleByChannel, channels, currentChannelId, currentProgram, isInterstitial, creditsVisible, clearSequenceTimer]);

  // Suppress immediately if conditions change mid-display
  useEffect(() => {
    if (visible && (isInterstitial || creditsVisible || !enabled)) {
      setVisible(false);
      clearSequenceTimer();
    }
  }, [visible, isInterstitial, creditsVisible, enabled, clearSequenceTimer]);

  // Pause dismiss timer on mouse hover (starting-soon only)
  const handlePromoMouseEnter = useCallback(() => {
    if (phase !== 'starting-soon' || !sequenceTimerRef.current) return;
    // Calculate remaining time and pause
    const elapsed = Date.now() - dismissTimerStartedAt.current;
    dismissRemainingMs.current = Math.max(0, dismissDurationMs.current - elapsed);
    clearSequenceTimer();
  }, [phase, clearSequenceTimer]);

  // Resume dismiss timer on mouse leave
  const handlePromoMouseLeave = useCallback(() => {
    if (phase !== 'starting-soon' || !visible || dismissRemainingMs.current <= 0) return;
    sequenceTimerRef.current = setTimeout(() => {
      setVisible(false);
    }, dismissRemainingMs.current);
    dismissTimerStartedAt.current = Date.now();
    dismissDurationMs.current = dismissRemainingMs.current;
  }, [phase, visible]);

  const handleStartingSoonClick = useCallback(() => {
    if (phase === 'starting-soon' && startingSoonChannelId != null && onTuneChannel) {
      onTuneChannel(startingSoonChannelId);
      setVisible(false);
      clearSequenceTimer();
    }
  }, [phase, startingSoonChannelId, onTuneChannel, clearSequenceTimer]);

  if (!visible) return null;

  const showProgram =
    phase === 'starting-soon' && startingSoonProgram
      ? startingSoonProgram
      : phase === 'next' && nextProgram
        ? nextProgram
        : currentProgram;

  const label =
    phase === 'starting-soon' && startingSoonProgram
      ? 'STARTING SOON'
      : phase === 'next' && nextProgram
        ? 'COMING UP NEXT'
        : "YOU'RE WATCHING";

  const backdropUrl =
    showProgram.backdrop_url || showProgram.thumbnail_url || showProgram.banner_url;
  const hdBackdrop = backdropUrl
    ? backdropUrl + (backdropUrl.includes('?') ? '&' : '?') + 'maxWidth=960'
    : null;

  const isClickable = phase === 'starting-soon' && startingSoonChannelId != null && onTuneChannel;

  return (
    <div className={`promo-overlay ${visible ? 'promo-overlay-visible' : ''} ${isClickable ? 'promo-overlay-clickable' : ''}`}>
      <div
        className="promo-overlay-card"
        key={phase}
        onClick={isClickable ? handleStartingSoonClick : undefined}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleStartingSoonClick(); } : undefined}
        onMouseEnter={handlePromoMouseEnter}
        onMouseLeave={handlePromoMouseLeave}
      >
        <div className="promo-info">
          <span className="promo-label">{label}</span>
          <span className="promo-title">{showProgram.title}</span>
          {showProgram.subtitle && (
            <span className="promo-subtitle">{showProgram.subtitle}</span>
          )}
          <div className="promo-meta">
            {phase === 'starting-soon' && startingSoonChannelName && (
              <span className="promo-channel">{startingSoonChannelName}</span>
            )}
            {showProgram.year && <span className="promo-year">{showProgram.year}</span>}
            {showProgram.rating && <span className="promo-rating">{showProgram.rating}</span>}
          </div>
        </div>
        {hdBackdrop && (
          <div
            className="promo-backdrop"
            style={{ backgroundImage: `url("${sanitizeImageUrl(hdBackdrop) || ''}")` }}
          />
        )}
      </div>
    </div>
  );
}
