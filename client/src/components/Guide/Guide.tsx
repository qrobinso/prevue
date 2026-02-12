import { useState, useCallback, useRef, useEffect } from 'react';
import { useSchedule } from '../../hooks/useSchedule';
import { useKeyboard } from '../../hooks/useKeyboard';
import GuideGrid from './GuideGrid';
import PreviewPanel from './PreviewPanel';
import { getVisibleChannels, getAutoScroll, getAutoScrollSpeed, getGuideHours } from '../Settings/DisplaySettings';
import type { Channel, ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import './Guide.css';

interface GuideProps {
  onTune: (channel: Channel, program: ScheduleProgram) => void;
  onOpenSettings: () => void;
  streamingPaused?: boolean;
  initialChannelId?: number | null;
}

export default function Guide({ onTune, onOpenSettings, streamingPaused = false, initialChannelId }: GuideProps) {
  const { channels, scheduleByChannel, loading, error, refresh } = useSchedule();
  const visibleChannels = getVisibleChannels();
  const [guideHours, setGuideHoursState] = useState(getGuideHours);
  const [focusedChannelIdx, setFocusedChannelIdx] = useState(0);
  const [focusedProgramIdx, setFocusedProgramIdx] = useState(0);
  const [currentTime, setCurrentTime] = useState(new Date());
  const hasRestoredPosition = useRef(false);
  // Store the initial channel ID so we can restore it even if channels load later
  const initialChannelIdRef = useRef(initialChannelId);
  
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
      // Also set auto-scroll offset so the channel is visible
      setAutoScrollOffset(idx);
      hasRestoredPosition.current = true;
    }
  }, [channels, scheduleByChannel, findCurrentProgramIdx]);

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
      onTune(focusedChannel, focusedProgram);
    }
  }, [focusedChannel, focusedProgram, onTune, pauseAutoScroll]);

  useKeyboard('guide', {
    onUp: handleUp,
    onDown: handleDown,
    onLeft: handleLeft,
    onRight: handleRight,
    onEnter: handleEnter,
    onEscape: onOpenSettings,
  });

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
    <div className="guide">
      <button
        className="guide-settings-btn"
        onClick={onOpenSettings}
        title="Settings"
      >
        ⚙
      </button>
      <PreviewPanel
        channel={focusedChannel}
        program={focusedChannel?.current_program || focusedProgram}
        currentTime={currentTime}
        streamingPaused={streamingPaused}
        onTune={handleEnter}
      />
      <GuideGrid
        channels={channels}
        scheduleByChannel={scheduleByChannel}
        focusedChannelIdx={focusedChannelIdx}
        focusedProgramIdx={focusedProgramIdx}
        currentTime={currentTime}
        visibleChannels={visibleChannels}
        guideHours={guideHours}
        scrollToChannelIdx={autoScrollEnabled && !autoScrollPaused ? autoScrollOffset : undefined}
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
          setFocusedChannelIdx(chIdx);
          setFocusedProgramIdx(progIdx);
          const ch = channels[chIdx];
          const progs = scheduleByChannel.get(ch.id) || [];
          const prog = progs[progIdx];
          if (ch && prog) onTune(ch, prog);
        }}
      />
    </div>
  );
}
