import { useState, useCallback, useRef, useEffect } from 'react';
import { useSchedule } from '../../hooks/useSchedule';
import { useKeyboard } from '../../hooks/useKeyboard';
import GuideGrid from './GuideGrid';
import PreviewPanel from './PreviewPanel';
import ProgramInfoModal from './ProgramInfoModal';
import { getVisibleChannels, getAutoScroll, getAutoScrollSpeed, getGuideHours } from '../Settings/DisplaySettings';
import { isIOSPWA } from '../../utils/platform';
import type { Channel, ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import './Guide.css';

interface GuideProps {
  onTune: (channel: Channel, program: ScheduleProgram, opts?: { fromFullscreen?: boolean }) => void;
  onOpenSettings: () => void;
  streamingPaused?: boolean;
  initialChannelId?: number | null;
  keyboardDisabled?: boolean;
}

export default function Guide({ onTune, onOpenSettings, streamingPaused = false, initialChannelId, keyboardDisabled = false }: GuideProps) {
  const { channels, scheduleByChannel, loading, error, refresh } = useSchedule();
  const visibleChannels = getVisibleChannels();
  const [guideHours, setGuideHoursState] = useState(getGuideHours);
  const [focusedChannelIdx, setFocusedChannelIdx] = useState(0);
  const [focusedProgramIdx, setFocusedProgramIdx] = useState(0);
  const [currentTime, setCurrentTime] = useState(new Date());
  const hasRestoredPosition = useRef(false);
  /** When returning from player, scroll this channel to top once; cleared after scroll */
  const [scrollToChannelIdxOnce, setScrollToChannelIdxOnce] = useState<number | null>(null);
  // Store the initial channel ID so we can restore it even if channels load later
  const initialChannelIdRef = useRef(initialChannelId);

  // When initialChannelId prop changes (returning from player), update ref and allow re-restoration
  useEffect(() => {
    if (initialChannelId != null && initialChannelId !== initialChannelIdRef.current) {
      initialChannelIdRef.current = initialChannelId;
      hasRestoredPosition.current = false;
    }
  }, [initialChannelId]);
  
  // Auto-scroll state
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(getAutoScroll);
  const [autoScrollSpeed, setAutoScrollSpeed] = useState(getAutoScrollSpeed);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const autoScrollPauseTimeoutRef = useRef<number | null>(null);

  // Update current time every second
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Listen for auto-scroll and guide hours setting changes
  useEffect(() => {
    const handleAutoScrollChange = (e: CustomEvent<{ enabled: boolean }>) => {
      setAutoScrollEnabled(e.detail.enabled);
    };
    const handleSpeedChange = (e: CustomEvent<{ speedId: string }>) => {
      setAutoScrollSpeed(getAutoScrollSpeed());
    };
    const handleGuideHoursChange = (e: CustomEvent<{ hours: number }>) => {
      setGuideHoursState(e.detail.hours);
    };

    window.addEventListener('autoscrollchange', handleAutoScrollChange as EventListener);
    window.addEventListener('autoscrollspeedchange', handleSpeedChange as EventListener);
    window.addEventListener('guidehourschange', handleGuideHoursChange as EventListener);

    return () => {
      window.removeEventListener('autoscrollchange', handleAutoScrollChange as EventListener);
      window.removeEventListener('autoscrollspeedchange', handleSpeedChange as EventListener);
      window.removeEventListener('guidehourschange', handleGuideHoursChange as EventListener);
    };
  }, []);

  // Helper to find the index of the currently airing program (defined early for auto-scroll)
  const findCurrentProgramIdx = useCallback((channelId: number): number => {
    const programs = scheduleByChannel.get(channelId) || [];
    const now = Date.now();
    const idx = programs.findIndex(prog => {
      const start = new Date(prog.start_time).getTime();
      const end = new Date(prog.end_time).getTime();
      return now >= start && now < end;
    });
    return idx >= 0 ? idx : 0;
  }, [scheduleByChannel]);

  // Auto-scroll display offset (separate from focused channel for selection)
  const [autoScrollOffset, setAutoScrollOffset] = useState(0);

  // Restore channel position when returning from player
  useEffect(() => {
    // Use the ref to ensure we have the initial value even across re-renders
    const targetChannelId = initialChannelIdRef.current;
    
    // Wait until we have both channels and schedule data before restoring
    if (hasRestoredPosition.current || targetChannelId == null || channels.length === 0 || scheduleByChannel.size === 0) {
      return;
    }
    
    const idx = channels.findIndex(ch => ch.id === targetChannelId);
    if (idx >= 0) {
      setFocusedChannelIdx(idx);
      setFocusedProgramIdx(findCurrentProgramIdx(channels[idx].id));
      setAutoScrollOffset(idx);
      setScrollToChannelIdxOnce(idx); // So grid scrolls this channel to top
      hasRestoredPosition.current = true;
    }
  }, [channels, scheduleByChannel, findCurrentProgramIdx, initialChannelId]);

  // Clear one-time scroll target after grid has snapped (so normal auto-scroll/focus scroll takes over)
  useEffect(() => {
    if (scrollToChannelIdxOnce === null) return;
    const t = setTimeout(() => setScrollToChannelIdxOnce(null), 100);
    return () => clearTimeout(t);
  }, [scrollToChannelIdxOnce]);

  // Auto-scroll through channels (page at a time, like classic TV Guide)
  // This only moves the display, not the user's selection
  useEffect(() => {
    if (!autoScrollEnabled || autoScrollPaused || channels.length === 0) {
      return;
    }

    const intervalMs = autoScrollSpeed.seconds * 1000;
    const timer = setInterval(() => {
      setAutoScrollOffset(prev => {
        // Move by a full page of visible channels
        const nextOffset = prev + visibleChannels;
        // If we'd go past the end, loop back to the start
        return nextOffset >= channels.length ? 0 : nextOffset;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [autoScrollEnabled, autoScrollPaused, autoScrollSpeed, channels.length, visibleChannels]);

  // Reset auto-scroll offset when user interacts (so display follows their selection)
  useEffect(() => {
    if (autoScrollPaused) {
      setAutoScrollOffset(focusedChannelIdx);
    }
  }, [autoScrollPaused, focusedChannelIdx]);

  // Pause auto-scroll on user interaction
  const pauseAutoScroll = useCallback(() => {
    if (!autoScrollEnabled) return;
    
    setAutoScrollPaused(true);
    
    // Clear any existing timeout
    if (autoScrollPauseTimeoutRef.current) {
      clearTimeout(autoScrollPauseTimeoutRef.current);
    }
    
    // Resume after 20 seconds of inactivity
    autoScrollPauseTimeoutRef.current = window.setTimeout(() => {
      setAutoScrollPaused(false);
    }, 20000);
  }, [autoScrollEnabled]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (autoScrollPauseTimeoutRef.current) {
        clearTimeout(autoScrollPauseTimeoutRef.current);
      }
    };
  }, []);

  const focusedChannel = channels[focusedChannelIdx] || null;
  const focusedPrograms = focusedChannel ? scheduleByChannel.get(focusedChannel.id) || [] : [];
  const focusedProgram = focusedPrograms[focusedProgramIdx] || null;

  // Compute the currently airing program from schedule + currentTime (updates every second).
  // This ensures the preview automatically switches when one program ends and the next starts,
  // instead of waiting for the 60-second schedule refresh.
  const currentAiringProgram = focusedChannel ? (() => {
    const programs = scheduleByChannel.get(focusedChannel.id) || [];
    const now = currentTime.getTime();
    return programs.find(p => {
      const start = new Date(p.start_time).getTime();
      const end = new Date(p.end_time).getTime();
      return now >= start && now < end;
    }) ?? null;
  })() : null;

  /** When set, show program info modal (future program click). */
  const [programInfoModal, setProgramInfoModal] = useState<{ channel: Channel; program: ScheduleProgram } | null>(null);

  // Fullscreen support
  const guideRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = useCallback(() => {
    const el = guideRef.current;
    if (!el) return;

    // On iOS PWA, Fullscreen API shows a toolbar. Use CSS-only fullscreen instead.
    if (isIOSPWA()) {
      setIsFullscreen((prev) => !prev);
      return;
    }

    const doc = document as Document & { exitFullscreen?: () => Promise<void>; webkitExitFullscreen?: () => void; msExitFullscreen?: () => void };
    const fsEl = (document as { fullscreenElement?: Element | null; webkitFullscreenElement?: Element | null; msFullscreenElement?: Element | null }).fullscreenElement
      ?? (document as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
      ?? (document as { msFullscreenElement?: Element | null }).msFullscreenElement;
    if (fsEl === el) {
      if (doc.exitFullscreen) doc.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
      else if (doc.msExitFullscreen) doc.msExitFullscreen();
    } else {
      const htmlEl = el as HTMLElement & { requestFullscreen?: () => Promise<void>; webkitRequestFullscreen?: () => void; msRequestFullscreen?: () => void };
      if (htmlEl.requestFullscreen) htmlEl.requestFullscreen();
      else if (htmlEl.webkitRequestFullscreen) htmlEl.webkitRequestFullscreen();
      else if (htmlEl.msRequestFullscreen) htmlEl.msRequestFullscreen();
    }
  }, []);

  useEffect(() => {
    if (isIOSPWA()) return; // CSS-only fullscreen; no Fullscreen API events
    const onFsChange = () => {
      const fsEl = (document as { fullscreenElement?: Element | null; webkitFullscreenElement?: Element | null; msFullscreenElement?: Element | null }).fullscreenElement
        ?? (document as { webkitFullscreenElement?: Element | null }).webkitFullscreenElement
        ?? (document as { msFullscreenElement?: Element | null }).msFullscreenElement;
      setIsFullscreen(fsEl === guideRef.current);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    document.addEventListener('MSFullscreenChange', onFsChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      document.removeEventListener('MSFullscreenChange', onFsChange);
    };
  }, []);

  const handleUp = useCallback(() => {
    pauseAutoScroll();
    setFocusedChannelIdx(prev => {
      const newIdx = Math.max(0, prev - 1);
      const newChannel = channels[newIdx];
      if (newChannel) {
        setFocusedProgramIdx(findCurrentProgramIdx(newChannel.id));
      }
      return newIdx;
    });
  }, [channels, findCurrentProgramIdx, pauseAutoScroll]);

  const handleDown = useCallback(() => {
    pauseAutoScroll();
    setFocusedChannelIdx(prev => {
      const newIdx = Math.min(channels.length - 1, prev + 1);
      const newChannel = channels[newIdx];
      if (newChannel) {
        setFocusedProgramIdx(findCurrentProgramIdx(newChannel.id));
      }
      return newIdx;
    });
  }, [channels, findCurrentProgramIdx, pauseAutoScroll]);

  const handleLeft = useCallback(() => {
    pauseAutoScroll();
    setFocusedProgramIdx(prev => Math.max(0, prev - 1));
  }, [pauseAutoScroll]);

  const handleRight = useCallback(() => {
    pauseAutoScroll();
    setFocusedProgramIdx(prev => Math.min(focusedPrograms.length - 1, prev + 1));
  }, [focusedPrograms.length, pauseAutoScroll]);

  const handleEnter = useCallback(() => {
    pauseAutoScroll();
    if (focusedChannel && focusedProgram) {
      onTune(focusedChannel, focusedProgram, { fromFullscreen: isFullscreen });
    }
  }, [focusedChannel, focusedProgram, onTune, pauseAutoScroll, isFullscreen]);

  useKeyboard('guide', {
    onUp: handleUp,
    onDown: handleDown,
    onLeft: handleLeft,
    onRight: handleRight,
    onEnter: handleEnter,
    onEscape: onOpenSettings,
  }, !keyboardDisabled);

  if (loading) {
    return (
      <div className="guide">
        <div className="guide-loading">
          <div className="guide-loading-text">LOADING GUIDE DATA...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="guide">
        <div className="guide-error">
          <div className="guide-error-title">CONNECTION ERROR</div>
          <div className="guide-error-msg">{error}</div>
          <div className="guide-error-actions">
            <button className="guide-error-btn" onClick={refresh}>
              RETRY
            </button>
            <button className="guide-error-btn" onClick={onOpenSettings}>
              CONFIGURE SERVER
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <div className="guide">
        <div className="guide-empty">
          <div className="guide-empty-title">NO CHANNELS</div>
          <div className="guide-empty-msg">Connect a Jellyfin server to get started</div>
          <button className="guide-empty-btn" onClick={onOpenSettings}>
            SETUP
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`guide ${isFullscreen ? 'guide-fullscreen' : ''} ${isIOSPWA() && isFullscreen ? 'guide-fullscreen-ios-pwa' : ''}`}
      ref={guideRef}
    >
      <button
        className="guide-fullscreen-btn"
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {isFullscreen ? '⊡' : '⛶'}
      </button>
      <button
        className="guide-settings-btn"
        onClick={onOpenSettings}
        title="Settings"
      >
        ⚙
      </button>
      <PreviewPanel
        channel={focusedChannel}
        program={currentAiringProgram}
        currentTime={currentTime}
        streamingPaused={streamingPaused}
        onTune={handleEnter}
        onSwipeUp={handleUp}
        onSwipeDown={handleDown}
        guideHours={guideHours}
      />
      {programInfoModal && (
        <ProgramInfoModal
          channel={programInfoModal.channel}
          program={programInfoModal.program}
          onClose={() => setProgramInfoModal(null)}
        />
      )}
      <GuideGrid
        channels={channels}
        scheduleByChannel={scheduleByChannel}
        focusedChannelIdx={focusedChannelIdx}
        focusedProgramIdx={focusedProgramIdx}
        currentTime={currentTime}
        visibleChannels={visibleChannels}
        guideHours={guideHours}
        scrollToChannelIdx={scrollToChannelIdxOnce ?? (autoScrollEnabled && !autoScrollPaused ? autoScrollOffset : undefined)}
        onChannelClick={(chIdx) => {
          pauseAutoScroll();
          setFocusedChannelIdx(chIdx);
          const ch = channels[chIdx];
          if (ch) {
            setFocusedProgramIdx(findCurrentProgramIdx(ch.id));
          }
        }}
        onProgramClick={(chIdx, progIdx) => {
          pauseAutoScroll();
          const ch = channels[chIdx];
          const progs = scheduleByChannel.get(ch?.id ?? 0) || [];
          const prog = progs[progIdx];
          if (!ch || !prog) return;
          const now = Date.now();
          const progStart = new Date(prog.start_time).getTime();
          if (progStart > now) {
            // Future program: only show info modal, don't change channel/preview
            setProgramInfoModal({ channel: ch, program: prog });
          } else {
            // Current/past program: change selection and tune
            setFocusedChannelIdx(chIdx);
            setFocusedProgramIdx(progIdx);
            onTune(ch, prog, { fromFullscreen: isFullscreen });
          }
        }}
      />
    </div>
  );
}
