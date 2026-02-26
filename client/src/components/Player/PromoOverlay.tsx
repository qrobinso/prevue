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

/** Compute 2-3 random appearance times spread across remaining program duration. */
function schedulePromoTimes(startMs: number, endMs: number): number[] {
  const now = Date.now();
  const effectiveStart = Math.max(startMs, now) + 30_000;
  const effectiveEnd = endMs - 120_000;
  const window = effectiveEnd - effectiveStart;

  if (window < 180_000) return [];

  const count = window < 1_200_000 ? 2 : 3;
  const segmentSize = window / count;

  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    const segStart = effectiveStart + i * segmentSize;
    const t = segStart + Math.random() * segmentSize;
    times.push(Math.round(t));
  }

  return times;
}

/** Find a program starting soon on another channel that matches the current content type. */
function findStartingSoon(
  scheduleByChannel: Map<number, ScheduleProgram[]>,
  currentChannelId: number,
  contentType: string | null,
): { program: ScheduleProgram; channelId: number } | null {
  const now = Date.now();
  const oneMinFromNow = now + 60_000;

  let best: { program: ScheduleProgram; channelId: number; startsAt: number } | null = null;

  for (const [channelId, programs] of scheduleByChannel) {
    if (channelId === currentChannelId) continue;

    for (const p of programs) {
      if (p.type !== 'program') continue;
      const startMs = p.start_ms ?? new Date(p.start_time).getTime();
      // Must be starting within the next 60 seconds
      if (startMs <= now || startMs > oneMinFromNow) continue;
      // Content type must match: movie→movie, episode→episode
      if (contentType && p.content_type !== contentType) continue;
      // Pick the soonest one
      if (!best || startMs < best.startsAt) {
        best = { program: p, channelId, startsAt: startMs };
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
    if (!enabled || !scheduleByChannel || !channels || currentChannelId == null) return;

    const interval = setInterval(() => {
      if (isInterstitial || creditsVisible || visible) return;

      const match = findStartingSoon(scheduleByChannel, currentChannelId, currentProgram.content_type);
      if (!match) return;

      // Don't show the same starting-soon program twice
      if (match.program.jellyfin_item_id === startingSoonShownRef.current) return;
      startingSoonShownRef.current = match.program.jellyfin_item_id;

      const ch = channels.find((c) => c.id === match.channelId);
      setStartingSoonProgram(match.program);
      setStartingSoonChannelName(ch ? `CH ${ch.number} ${ch.name}` : null);
      setStartingSoonChannelId(match.channelId);
      setPhase('starting-soon');
      setVisible(true);

      clearSequenceTimer();
      sequenceTimerRef.current = setTimeout(() => {
        setVisible(false);
      }, STARTING_SOON_DURATION_MS);
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, scheduleByChannel, channels, currentChannelId, currentProgram.content_type, isInterstitial, creditsVisible, clearSequenceTimer]);

  // Suppress immediately if conditions change mid-display
  useEffect(() => {
    if (visible && (isInterstitial || creditsVisible || !enabled)) {
      setVisible(false);
      clearSequenceTimer();
    }
  }, [visible, isInterstitial, creditsVisible, enabled, clearSequenceTimer]);

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
