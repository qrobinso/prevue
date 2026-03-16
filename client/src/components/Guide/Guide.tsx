import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useSchedule } from '../../hooks/useSchedule';
import { useNavZone, useNavigation, moveFocus, arrowToDirection, focusFirst } from '../../navigation';
import GuideGrid from './GuideGrid';
import PreviewPanel from './PreviewPanel';
import ProgramInfoModal from './ProgramInfoModal';
import ChannelSearch from './ChannelSearch';
import GuideFilterDropdown from './GuideFilter';
import Ticker from './Ticker';
import { getVisibleChannels, getAutoScroll, getAutoScrollSpeed, getGuideHours, getPreviewStyle, getTickerEnabled } from '../Settings/DisplaySettings';
import type { PreviewStyle } from '../Settings/DisplaySettings';
import Settings from '../Settings/Settings';
import { MagnifyingGlass, Funnel, FrameCorners, CornersIn, GearSix } from '@phosphor-icons/react';
import { isIOSPWA } from '../../utils/platform';
import {
  getFullscreenElement,
  isFullscreenElement,
  enterFullscreen,
  exitFullscreen,
  type FullscreenMode,
} from '../../utils/fullscreen';
import { getGuideFilters, setGuideFilters, applyGuideFilter, type GuideFilterId } from './guideFilterUtils';
import type { Channel, ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import { requestPlaybackHandoff } from '../../services/playbackHandoff';
import './Guide.css';

interface GuideProps {
  onTune: (channel: Channel, program: ScheduleProgram, opts?: { fromFullscreen?: boolean }) => void;
  onOpenSettings: () => void;
  settingsOpen?: boolean;
  onCloseSettings?: () => void;
  streamingPaused?: boolean;
  initialChannelId?: number | null;
  keyboardDisabled?: boolean;
  onFocusedChannelChange?: (channelId: number | null) => void;
  onLastChannel?: () => void;
  sleepState?: import('../../hooks/useSleepTimer').SleepTimerState;
  sleepActions?: import('../../hooks/useSleepTimer').SleepTimerActions;
}

export default function Guide({
  onTune,
  onOpenSettings,
  settingsOpen = false,
  onCloseSettings,
  streamingPaused = false,
  initialChannelId,
  keyboardDisabled = false,
  onFocusedChannelChange,
  onLastChannel,
  sleepState,
  sleepActions,
}: GuideProps) {
  const { channels, scheduleByChannel, loading, error, refresh } = useSchedule();
  const visibleChannels = getVisibleChannels();
  const [guideHours, setGuideHoursState] = useState(getGuideHours);
  const [previewStyle, setPreviewStyleState] = useState<PreviewStyle>(getPreviewStyle);
  const [focusedChannelIdx, setFocusedChannelIdx] = useState(0);
  const [focusedProgramIdx, setFocusedProgramIdx] = useState(0);
  const [previewTime, setPreviewTime] = useState(new Date());
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
  
  // Ticker state
  const [tickerEnabled, setTickerEnabledState] = useState(getTickerEnabled);

  // Auto-scroll state
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(getAutoScroll);
  const [autoScrollSpeed, setAutoScrollSpeed] = useState(getAutoScrollSpeed);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const autoScrollPauseTimeoutRef = useRef<number | null>(null);
  const mouseOverGuideRef = useRef(false);

  // Guide filter state
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<GuideFilterId[]>(getGuideFilters);

  // Update preview time at low frequency so the entire guide tree does not rerender every second.
  useEffect(() => {
    const timer = setInterval(() => setPreviewTime(new Date()), 15000);
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
    const handlePreviewStyleChange = (e: CustomEvent<{ style: PreviewStyle }>) => {
      setPreviewStyleState(e.detail.style);
    };

    const handleFilterChange = (e: CustomEvent<{ filterIds: GuideFilterId[] }>) => {
      setActiveFilters(e.detail.filterIds);
    };
    const handleTickerChange = (e: CustomEvent<{ enabled: boolean }>) => {
      setTickerEnabledState(e.detail.enabled);
    };

    window.addEventListener('autoscrollchange', handleAutoScrollChange as EventListener);
    window.addEventListener('autoscrollspeedchange', handleSpeedChange as EventListener);
    window.addEventListener('guidehourschange', handleGuideHoursChange as EventListener);
    window.addEventListener('previewstylechange', handlePreviewStyleChange as EventListener);
    window.addEventListener('guidefilterchange', handleFilterChange as EventListener);
    window.addEventListener('tickerchange', handleTickerChange as EventListener);

    return () => {
      window.removeEventListener('autoscrollchange', handleAutoScrollChange as EventListener);
      window.removeEventListener('autoscrollspeedchange', handleSpeedChange as EventListener);
      window.removeEventListener('guidehourschange', handleGuideHoursChange as EventListener);
      window.removeEventListener('previewstylechange', handlePreviewStyleChange as EventListener);
      window.removeEventListener('guidefilterchange', handleFilterChange as EventListener);
      window.removeEventListener('tickerchange', handleTickerChange as EventListener);
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

  // Track which channel the user is focused on, so we can "pin" it in the
  // filtered list even after time-sensitive filters (e.g. iconic-scene) expire.
  const prevFocusedIdRef = useRef<number | null>(null);

  // Apply guide filter to channels.
  // Pin the currently-focused channel so it stays visible even if it no longer
  // matches a time-sensitive filter (e.g. iconic-scene window passed).
  const pinnedChannelId = prevFocusedIdRef.current;
  const filteredChannels = useMemo(
    () => applyGuideFilter(channels, scheduleByChannel, activeFilters, pinnedChannelId),
    [channels, scheduleByChannel, activeFilters, pinnedChannelId],
  );

  // When the filtered list changes, try to keep the same channel focused by ID.
  // If the channel was filtered out, clamp to the nearest valid index.
  useEffect(() => {
    if (filteredChannels.length === 0) return;
    const prevId = prevFocusedIdRef.current;
    if (prevId != null) {
      const newIdx = filteredChannels.findIndex(ch => ch.id === prevId);
      if (newIdx >= 0) {
        setFocusedChannelIdx(newIdx);
        return;
      }
    }
    // Channel gone or first render — clamp index
    setFocusedChannelIdx(prev =>
      prev >= filteredChannels.length ? filteredChannels.length - 1 : prev,
    );
  }, [filteredChannels]);

  // Auto-scroll display offset (separate from focused channel for selection)
  const [autoScrollOffset, setAutoScrollOffset] = useState(0);

  // Keep auto-scroll state consistent when toggling on/off in settings.
  // This prevents stale "paused" state from making auto-scroll appear broken.
  useEffect(() => {
    if (autoScrollPauseTimeoutRef.current) {
      clearTimeout(autoScrollPauseTimeoutRef.current);
      autoScrollPauseTimeoutRef.current = null;
    }

    if (autoScrollEnabled) {
      setAutoScrollPaused(false);
      setAutoScrollOffset(prev => {
        if (filteredChannels.length === 0) return 0;
        const safePrev = Math.max(0, Math.min(filteredChannels.length - 1, prev));
        return safePrev;
      });
      return;
    }

    // Reset paused state when auto-scroll is disabled so re-enabling resumes immediately.
    setAutoScrollPaused(false);
  }, [autoScrollEnabled, filteredChannels.length]);

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
    if (!autoScrollEnabled || autoScrollPaused || filteredChannels.length === 0) {
      return;
    }

    const intervalMs = autoScrollSpeed.seconds * 1000;
    const timer = setInterval(() => {
      setAutoScrollOffset(prev => {
        // Move by a full page of visible channels
        const nextOffset = prev + visibleChannels;
        // If we'd go past the end, loop back to the start
        return nextOffset >= filteredChannels.length ? 0 : nextOffset;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [autoScrollEnabled, autoScrollPaused, autoScrollSpeed, filteredChannels.length, visibleChannels]);

  // Keep auto-scroll offset in sync with user's position:
  // - While paused, follow the focused channel
  // - When resuming (paused -> unpaused), start from the user's current position
  const wasPausedRef = useRef(autoScrollPaused);
  useEffect(() => {
    if (autoScrollPaused) {
      setAutoScrollOffset(focusedChannelIdx);
    } else if (wasPausedRef.current) {
      // Just resumed — start auto-scroll from where the user left off
      setAutoScrollOffset(focusedChannelIdx);
    }
    wasPausedRef.current = autoScrollPaused;
  }, [autoScrollPaused, focusedChannelIdx]);

  // Start (or restart) the inactivity resume timer
  const startResumeTimer = useCallback(() => {
    if (autoScrollPauseTimeoutRef.current) {
      clearTimeout(autoScrollPauseTimeoutRef.current);
    }
    // Don't start timer while mouse is hovering over the guide
    if (mouseOverGuideRef.current) return;
    autoScrollPauseTimeoutRef.current = window.setTimeout(() => {
      setAutoScrollPaused(false);
    }, 60000);
  }, []);

  // Pause auto-scroll on user interaction
  const pauseAutoScroll = useCallback(() => {
    if (!autoScrollEnabled) return;
    setAutoScrollPaused(true);
    startResumeTimer();
  }, [autoScrollEnabled, startResumeTimer]);

  // Mouse hover over guide grid: pause indefinitely (no resume timer)
  const handleGuideMouseEnter = useCallback(() => {
    mouseOverGuideRef.current = true;
    if (!autoScrollEnabled) return;
    setAutoScrollPaused(true);
    if (autoScrollPauseTimeoutRef.current) {
      clearTimeout(autoScrollPauseTimeoutRef.current);
      autoScrollPauseTimeoutRef.current = null;
    }
  }, [autoScrollEnabled]);

  // Mouse leaves guide grid: start inactivity timer
  const handleGuideMouseLeave = useCallback(() => {
    mouseOverGuideRef.current = false;
    if (!autoScrollEnabled || !autoScrollPaused) return;
    startResumeTimer();
  }, [autoScrollEnabled, autoScrollPaused, startResumeTimer]);

  // Clean up timeout on unmount
  useEffect(() => {
    return () => {
      if (autoScrollPauseTimeoutRef.current) {
        clearTimeout(autoScrollPauseTimeoutRef.current);
      }
    };
  }, []);

  const focusedChannel = filteredChannels[focusedChannelIdx] || null;
  prevFocusedIdRef.current = focusedChannel?.id ?? null;
  const focusedPrograms = focusedChannel ? scheduleByChannel.get(focusedChannel.id) || [] : [];
  const focusedProgram = focusedPrograms[focusedProgramIdx] || null;

  useEffect(() => {
    onFocusedChannelChange?.(focusedChannel?.id ?? null);
  }, [focusedChannel?.id, onFocusedChannelChange]);

  // Compute the currently airing program from schedule + previewTime.
  const currentAiringProgram = focusedChannel ? (() => {
    const programs = scheduleByChannel.get(focusedChannel.id) || [];
    const now = previewTime.getTime();
    return programs.find(p => {
      const start = new Date(p.start_time).getTime();
      const end = new Date(p.end_time).getTime();
      return now >= start && now < end;
    }) ?? null;
  })() : null;

  const handleGridChannelClick = useCallback((chIdx: number) => {
    pauseAutoScroll();
    setFocusedChannelIdx(chIdx);
    const ch = filteredChannels[chIdx];
    if (ch) {
      setFocusedProgramIdx(findCurrentProgramIdx(ch.id));
    }
  }, [pauseAutoScroll, filteredChannels, findCurrentProgramIdx]);

  const handlePromoChannelSelect = useCallback((channelId: number) => {
    const idx = filteredChannels.findIndex(ch => ch.id === channelId);
    if (idx >= 0) {
      pauseAutoScroll();
      setFocusedChannelIdx(idx);
      setFocusedProgramIdx(findCurrentProgramIdx(channelId));
    }
  }, [filteredChannels, pauseAutoScroll, findCurrentProgramIdx]);

  const handleTickerChannelSelect = useCallback((channelNumber: number) => {
    const idx = filteredChannels.findIndex(ch => ch.number === channelNumber);
    if (idx >= 0) {
      pauseAutoScroll();
      setFocusedChannelIdx(idx);
      setFocusedProgramIdx(findCurrentProgramIdx(filteredChannels[idx].id));
    }
  }, [filteredChannels, pauseAutoScroll, findCurrentProgramIdx]);

  /** When set, show program info modal (future program click). */
  const [programInfoModal, setProgramInfoModal] = useState<{ channel: Channel; program: ScheduleProgram } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [overlayVisible, setOverlayVisible] = useState(true);

  // Fullscreen support
  const guideRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenModeRef = useRef<FullscreenMode | null>(null);

  const handleGridProgramClick = useCallback((chIdx: number, progIdx: number) => {
    pauseAutoScroll();
    const ch = filteredChannels[chIdx];
    const progs = scheduleByChannel.get(ch?.id ?? 0) || [];
    const prog = progs[progIdx];
    if (!ch || !prog) return;
    const now = Date.now();
    const progStart = new Date(prog.start_time).getTime();
    if (progStart > now) {
      // Future program: only show info modal, don't change channel/preview
      setProgramInfoModal({ channel: ch, program: prog });
    } else if (chIdx === focusedChannelIdx && progIdx === focusedProgramIdx) {
      // Already focused: navigate to player — preserve stream for handoff
      if (currentAiringProgram?.media_item_id) {
        requestPlaybackHandoff('guide', 'player', ch.id, currentAiringProgram.media_item_id, 0);
      }
      onTune(ch, prog, { fromFullscreen: isFullscreen });
    } else {
      // Not focused yet: focus the program (preview it)
      setFocusedChannelIdx(chIdx);
      setFocusedProgramIdx(progIdx);
    }
  }, [pauseAutoScroll, filteredChannels, scheduleByChannel, focusedChannelIdx, focusedProgramIdx, currentAiringProgram, onTune, isFullscreen]);

  const toggleFullscreen = useCallback(() => {
    const el = guideRef.current;
    if (!el) return;

    // On iOS PWA, Fullscreen API shows a toolbar. Use CSS-only fullscreen instead.
    if (isIOSPWA()) {
      setIsFullscreen((prev) => !prev);
      return;
    }

    const isNativeFs = isFullscreenElement(el);
    const mode = fullscreenModeRef.current;
    if (isNativeFs || mode === 'video' || mode === 'fake') {
      exitFullscreen(mode || 'native');
      fullscreenModeRef.current = null;
      setIsFullscreen(false);
      return;
    }

    void (async () => {
      const enteredMode = await enterFullscreen(el);
      fullscreenModeRef.current = enteredMode;
      if (enteredMode === 'native') {
        setIsFullscreen(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (isIOSPWA()) return; // CSS-only fullscreen; no Fullscreen API events
    const onFsChange = () => {
      const isNowFullscreen = getFullscreenElement() === guideRef.current;
      if (isNowFullscreen) {
        fullscreenModeRef.current = 'native';
      } else if (fullscreenModeRef.current === 'native') {
        fullscreenModeRef.current = null;
      }
      setIsFullscreen(isNowFullscreen);
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

  // When player opens (guide streaming paused), force-guide fullscreen off.
  // Without this, iOS PWA CSS fullscreen can keep the guide as a fixed top layer
  // and visually hide the player overlay.
  useEffect(() => {
    if (!streamingPaused) return;

    const mode = fullscreenModeRef.current;

    if (isIOSPWA()) {
      if (isFullscreen) {
        setIsFullscreen(false);
      }
      fullscreenModeRef.current = null;
      return;
    }

    const guideEl = guideRef.current;
    if (mode === 'native' && guideEl && isFullscreenElement(guideEl)) {
      exitFullscreen('native');
    } else if (mode === 'video' || mode === 'fake') {
      exitFullscreen(mode);
    }

    fullscreenModeRef.current = null;
    if (isFullscreen) {
      setIsFullscreen(false);
    }
  }, [streamingPaused, isFullscreen]);

  const handleUp = useCallback(() => {
    pauseAutoScroll();
    setFocusedChannelIdx(prev => {
      const newIdx = Math.max(0, prev - 1);
      const newChannel = filteredChannels[newIdx];
      if (newChannel) {
        setFocusedProgramIdx(findCurrentProgramIdx(newChannel.id));
      }
      return newIdx;
    });
  }, [filteredChannels, findCurrentProgramIdx, pauseAutoScroll]);

  const handleDown = useCallback(() => {
    pauseAutoScroll();
    setFocusedChannelIdx(prev => {
      const newIdx = Math.min(filteredChannels.length - 1, prev + 1);
      const newChannel = filteredChannels[newIdx];
      if (newChannel) {
        setFocusedProgramIdx(findCurrentProgramIdx(newChannel.id));
      }
      return newIdx;
    });
  }, [filteredChannels, findCurrentProgramIdx, pauseAutoScroll]);

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
      if (currentAiringProgram?.media_item_id) {
        requestPlaybackHandoff('guide', 'player', focusedChannel.id, currentAiringProgram.media_item_id, 0);
      }
      onTune(focusedChannel, focusedProgram, { fromFullscreen: isFullscreen });
    }
  }, [focusedChannel, focusedProgram, currentAiringProgram, onTune, pauseAutoScroll, isFullscreen]);

  const handleRandomChannel = useCallback(() => {
    if (filteredChannels.length <= 1) return;
    pauseAutoScroll();
    let randIdx: number;
    do {
      randIdx = Math.floor(Math.random() * filteredChannels.length);
    } while (randIdx === focusedChannelIdx);
    setFocusedChannelIdx(randIdx);
    setScrollToChannelIdxOnce(randIdx);
    const ch = filteredChannels[randIdx];
    if (ch) {
      setFocusedProgramIdx(findCurrentProgramIdx(ch.id));
    }
  }, [filteredChannels, focusedChannelIdx, pauseAutoScroll, findCurrentProgramIdx]);

  const handleInfo = useCallback(() => {
    if (focusedChannel && focusedProgram) {
      setProgramInfoModal({ channel: focusedChannel, program: focusedProgram });
    }
  }, [focusedChannel, focusedProgram]);

  // ── Navigation Zone: Guide Header (4 buttons) ──
  const headerRef = useRef<HTMLDivElement>(null);
  const { activeZone, setActiveZone } = useNavigation();

  useNavZone({
    id: 'guide-header',
    onArrow: (dir) => {
      if (keyboardDisabled) return true;
      if (dir === 'left' || dir === 'right') {
        const d = arrowToDirection(dir, 'horizontal');
        if (d && headerRef.current) {
          return moveFocus(headerRef.current, d, { orientation: 'horizontal', wrap: true });
        }
      }
      // Down from header → go back to grid
      if (dir === 'down') return false; // let NavigationContext handle zone transition
      return false;
    },
    onEnter: () => {
      if (keyboardDisabled) return false;
      const el = document.activeElement;
      if (el instanceof HTMLElement && headerRef.current?.contains(el)) {
        el.click();
        return true;
      }
      return false;
    },
    onEscape: () => {
      if (!keyboardDisabled) onOpenSettings();
    },
    getAdjacentZone: (dir) => {
      if (dir === 'down') return 'guide-grid';
      return null;
    },
  });

  // ── Navigation Zone: Guide Grid ──
  useNavZone({
    id: 'guide-grid',
    onArrow: (dir) => {
      if (keyboardDisabled) return true;
      switch (dir) {
        case 'up':
          // At top of grid → transition to header
          if (focusedChannelIdx === 0) return false;
          handleUp();
          return true;
        case 'down':
          handleDown();
          return true;
        case 'left':
          handleLeft();
          return true;
        case 'right':
          handleRight();
          return true;
      }
      return false;
    },
    onEnter: () => {
      if (keyboardDisabled) return false;
      handleEnter();
      return true;
    },
    onEscape: () => {
      if (!keyboardDisabled) onOpenSettings();
    },
    onKey: (key) => {
      if (keyboardDisabled) return false;
      switch (key) {
        case 'r': case 'R':
          handleRandomChannel();
          return true;
        case 'f': case 'F':
          toggleFullscreen();
          return true;
        case 'i': case 'I':
          handleInfo();
          return true;
        case 'Backspace': case 'Delete':
          onLastChannel?.();
          return true;
      }
      return false;
    },
    getAdjacentZone: (dir) => {
      if (dir === 'up') return 'guide-header';
      return null;
    },
  });

  // When transitioning to guide-header, focus the first header button
  useEffect(() => {
    if (activeZone === 'guide-header' && headerRef.current) {
      focusFirst(headerRef.current);
    }
  }, [activeZone]);

  // When transitioning back to guide-grid, blur any focused header button
  useEffect(() => {
    if (activeZone === 'guide-grid') {
      const el = document.activeElement;
      if (el instanceof HTMLElement && headerRef.current?.contains(el)) {
        el.blur();
      }
    }
  }, [activeZone]);

  // When guide becomes keyboard-disabled (player opens), reset zone to grid
  useEffect(() => {
    if (keyboardDisabled && activeZone === 'guide-header') {
      setActiveZone('guide-grid');
    }
  }, [keyboardDisabled, activeZone, setActiveZone]);

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
        {settingsOpen && onCloseSettings && (
          <Settings onClose={onCloseSettings} sleepState={sleepState} sleepActions={sleepActions} />
        )}
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
        {settingsOpen && onCloseSettings && (
          <Settings onClose={onCloseSettings} sleepState={sleepState} sleepActions={sleepActions} />
        )}
      </div>
    );
  }

  return (
    <div
      className={`guide ${isFullscreen ? 'guide-fullscreen' : ''} ${isIOSPWA() && isFullscreen ? 'guide-fullscreen-ios-pwa' : ''} ${previewStyle === 'classic-left' ? 'guide-classic-left' : ''}`}
      ref={guideRef}
    >
      {/* Header buttons — navigable as a zone via remote control */}
      <div ref={headerRef} style={{ display: 'contents' }}>
        <button
          className={`guide-search-btn ${!overlayVisible ? 'guide-btn-hidden' : ''}`}
          onClick={() => setSearchOpen(true)}
          title="Search channels"
          aria-label="Search channels"
        >
          <MagnifyingGlass size={18} weight="bold" />
        </button>
        <button
          className={`guide-filter-btn ${activeFilters.length > 0 ? 'guide-filter-btn-active' : ''} ${!overlayVisible ? 'guide-btn-hidden' : ''}`}
          onClick={() => setFilterOpen(true)}
          title={activeFilters.length > 0 ? `${activeFilters.length} filter${activeFilters.length > 1 ? 's' : ''} active` : 'Filter channels'}
          aria-label="Filter channels"
        >
          <Funnel size={18} weight={activeFilters.length > 0 ? 'fill' : 'bold'} />
        </button>
        <button
          className={`guide-fullscreen-btn ${!overlayVisible ? 'guide-btn-hidden' : ''}`}
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <CornersIn size={18} weight="bold" /> : <FrameCorners size={18} weight="bold" />}
        </button>
        <button
          className={`guide-settings-btn ${!overlayVisible ? 'guide-btn-hidden' : ''}`}
          onClick={onOpenSettings}
          title="Settings"
        >
          <GearSix size={18} weight="bold" />
        </button>
      </div>
      <PreviewPanel
        channel={focusedChannel}
        program={currentAiringProgram}
        currentTime={previewTime}
        streamingPaused={streamingPaused}
        onTune={handleEnter}
        guideHours={guideHours}
        previewStyle={previewStyle}
        onOverlayVisibilityChange={setOverlayVisible}
        scheduleByChannel={scheduleByChannel}
        channels={channels}
        onSelectChannel={handlePromoChannelSelect}
      />
      <Ticker enabled={tickerEnabled} scheduleByChannel={scheduleByChannel} onChannelSelect={handleTickerChannelSelect} />
      {programInfoModal && (
        <ProgramInfoModal
          channel={programInfoModal.channel}
          program={programInfoModal.program}
          onClose={() => setProgramInfoModal(null)}
        />
      )}
      {searchOpen && (
        <ChannelSearch
          channels={filteredChannels}
          onSelect={(idx) => {
            pauseAutoScroll();
            setFocusedChannelIdx(idx);
            setFocusedProgramIdx(findCurrentProgramIdx(filteredChannels[idx].id));
            setScrollToChannelIdxOnce(idx);
            setSearchOpen(false);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {filterOpen && (
        <GuideFilterDropdown
          channels={channels}
          scheduleByChannel={scheduleByChannel}
          activeFilters={activeFilters}
          onToggleFilter={(filterId) => {
            const currentChannelId = focusedChannel?.id;
            const next = activeFilters.includes(filterId)
              ? activeFilters.filter(id => id !== filterId)
              : [...activeFilters, filterId];
            setGuideFilters(next);
            setActiveFilters(next);
            // Preserve current channel position in the new filtered list
            const newFiltered = applyGuideFilter(channels, scheduleByChannel, next);
            if (currentChannelId != null) {
              const newIdx = newFiltered.findIndex(ch => ch.id === currentChannelId);
              if (newIdx >= 0) {
                setFocusedChannelIdx(newIdx);
                return;
              }
            }
            // Channel was filtered out — clamp to nearest valid index
            setFocusedChannelIdx(prev =>
              prev >= newFiltered.length ? Math.max(0, newFiltered.length - 1) : prev,
            );
          }}
          onClearFilters={() => {
            const currentChannelId = focusedChannel?.id;
            setGuideFilters([]);
            setActiveFilters([]);
            // Preserve current channel position in the unfiltered list
            const newFiltered = applyGuideFilter(channels, scheduleByChannel, []);
            if (currentChannelId != null) {
              const newIdx = newFiltered.findIndex(ch => ch.id === currentChannelId);
              if (newIdx >= 0) {
                setFocusedChannelIdx(newIdx);
                return;
              }
            }
            setFocusedChannelIdx(0);
          }}
          onClose={() => setFilterOpen(false)}
        />
      )}
      {filteredChannels.length === 0 && activeFilters.length > 0 && (
        <div className="guide-filter-empty">
          No channels match this filter
        </div>
      )}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        onMouseEnter={handleGuideMouseEnter}
        onMouseLeave={handleGuideMouseLeave}
        onWheel={pauseAutoScroll}
        style={{ display: 'contents' }}
      >
        <GuideGrid
          channels={filteredChannels}
          scheduleByChannel={scheduleByChannel}
          focusedChannelIdx={focusedChannelIdx}
          focusedProgramIdx={focusedProgramIdx}
          visibleChannels={visibleChannels}
          guideHours={guideHours}
          scrollToChannelIdx={scrollToChannelIdxOnce ?? (autoScrollEnabled && !autoScrollPaused ? autoScrollOffset : undefined)}
          smoothScroll={scrollToChannelIdxOnce === undefined && autoScrollEnabled && !autoScrollPaused}
          onChannelClick={handleGridChannelClick}
          onProgramClick={handleGridProgramClick}
          hideDividers={activeFilters.length > 0}
        />
      </div>
      {settingsOpen && onCloseSettings && (
        <Settings onClose={onCloseSettings} sleepState={sleepState} sleepActions={sleepActions} />
      )}
    </div>
  );
}
