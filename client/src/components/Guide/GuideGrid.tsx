import { useRef, useEffect, useMemo, useState } from 'react';
import type { ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import './Guide.css';

interface GuideGridProps {
  channels: ChannelWithProgram[];
  scheduleByChannel: Map<number, ScheduleProgram[]>;
  focusedChannelIdx: number;
  focusedProgramIdx: number;
  currentTime: Date;
  visibleChannels: number;
  guideHours: number;
  scrollToChannelIdx?: number; // For auto-scroll: which channel to scroll to (separate from focus)
  onChannelClick: (channelIdx: number) => void;
  onProgramClick: (channelIdx: number, programIdx: number) => void;
}

const BASE_ROW_HEIGHT = 52;
const BASE_CHANNEL_COL_WIDTH = 120;
const MIN_CHANNEL_COL_WIDTH = 60;
const MIN_ROW_HEIGHT = 44; // Touch-friendly minimum

export default function GuideGrid({
  channels,
  scheduleByChannel,
  focusedChannelIdx,
  focusedProgramIdx,
  currentTime,
  visibleChannels,
  guideHours,
  scrollToChannelIdx,
  onChannelClick,
  onProgramClick,
}: GuideGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const timeHeaderRef = useRef<HTMLDivElement>(null);
  const focusedRowRef = useRef<HTMLDivElement>(null);
  const [gridHeight, setGridHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0); // Track horizontal scroll for sticky titles
  const isScrollingSynced = useRef(false);

  // Measure the container to compute dynamic sizes
  useEffect(() => {
    const container = containerRef.current;
    const grid = gridRef.current;
    if (!container || !grid) return;
    
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === grid) {
          setGridHeight(entry.contentRect.height);
        }
        if (entry.target === container) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(grid);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Detect if mobile (for consistent sizing)
  const isMobile = containerWidth > 0 && containerWidth < 768;
  const isSmallMobile = containerWidth > 0 && containerWidth < 480;

  // Compute dynamic sizes based on visible channels
  const rawRowHeight = gridHeight > 0
    ? Math.floor(gridHeight / visibleChannels)
    : BASE_ROW_HEIGHT;
  const rowHeight = Math.max(rawRowHeight, MIN_ROW_HEIGHT);
  const scale = rowHeight / BASE_ROW_HEIGHT;
  
  // Channel column width - smaller on mobile, but with minimum
  const baseColWidth = isMobile ? (isSmallMobile ? 65 : 80) : BASE_CHANNEL_COL_WIDTH;
  const channelColWidth = Math.max(
    Math.round(baseColWidth * Math.min(scale, 1.5)),
    MIN_CHANNEL_COL_WIDTH
  );

  // Calculate time slot width to fill available space
  // guideHours controls zoom (how many hours fit on screen), but we show full 8-hour schedule
  const TOTAL_SCHEDULE_HOURS = 8;
  const numVisibleTimeSlots = guideHours * 2; // Slots visible on screen at once
  const availableWidth = containerWidth - channelColWidth;
  const timeSlotWidth = availableWidth > 0 ? Math.floor(availableWidth / numVisibleTimeSlots) : 200;

  // Font sizes - consistent sizing with mobile-friendly minimums
  const baseFontScale = Math.min(scale, isMobile ? 1.5 : 2.5);
  const channelNumFontSize = Math.max(Math.round(12 * baseFontScale), isMobile ? 11 : 12);
  const channelNameFontSize = Math.max(Math.round(8 * baseFontScale), isMobile ? 8 : 7);
  const programTitleFontSize = Math.max(Math.round(12 * baseFontScale), isMobile ? 11 : 12);

  // Calculate time range: start at current 8-hour block, extend for full 8 hours
  // The user can scroll through all 8 hours; guideHours just controls zoom level
  const timeRange = useMemo(() => {
    const start = new Date(currentTime);
    // Round down to current 8-hour block boundary (0:00, 8:00, or 16:00)
    const blockHour = Math.floor(start.getHours() / TOTAL_SCHEDULE_HOURS) * TOTAL_SCHEDULE_HOURS;
    start.setHours(blockHour, 0, 0, 0);

    const end = new Date(start);
    end.setHours(end.getHours() + TOTAL_SCHEDULE_HOURS);

    return { start, end };
  }, [Math.floor(currentTime.getTime() / 60000)]); // Recalc every minute

  // Generate time slots (30-min intervals)
  const timeSlots = useMemo(() => {
    const slots: Date[] = [];
    const t = new Date(timeRange.start);
    while (t < timeRange.end) {
      slots.push(new Date(t));
      t.setMinutes(t.getMinutes() + 30);
    }
    return slots;
  }, [timeRange]);

  // Track the row we want to scroll to (for auto-scroll feature)
  const scrollTargetRef = useRef<HTMLDivElement>(null);
  
  // Determine which channel index to scroll to
  const effectiveScrollIdx = scrollToChannelIdx ?? focusedChannelIdx;
  const isAutoScrolling = scrollToChannelIdx !== undefined;

  // Custom slow scroll animation for auto-scroll (less jarring)
  const smoothScrollTo = (element: HTMLElement, duration: number) => {
    const container = gridRef.current;
    if (!container) return;
    
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    
    // Calculate if element is already in view
    const isAbove = elementRect.top < containerRect.top;
    const isBelow = elementRect.bottom > containerRect.bottom;
    
    if (!isAbove && !isBelow) return; // Already in view
    
    // Calculate target scroll position
    let targetScroll: number;
    if (isAbove) {
      targetScroll = container.scrollTop + (elementRect.top - containerRect.top);
    } else {
      targetScroll = container.scrollTop + (elementRect.bottom - containerRect.bottom);
    }
    
    const startScroll = container.scrollTop;
    const distance = targetScroll - startScroll;
    const startTime = performance.now();
    
    const easeInOutCubic = (t: number) => {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };
    
    const animateScroll = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeInOutCubic(progress);
      
      container.scrollTop = startScroll + (distance * eased);
      
      if (progress < 1) {
        requestAnimationFrame(animateScroll);
      }
    };
    
    requestAnimationFrame(animateScroll);
  };

  // Auto-scroll target row into view with slow animation
  useEffect(() => {
    if (scrollTargetRef.current && isAutoScrolling) {
      // Use slower animation (1.5 seconds) for auto-scroll
      smoothScrollTo(scrollTargetRef.current, 1500);
    }
  }, [effectiveScrollIdx, isAutoScrolling]);
  
  // Also scroll focused row into view when user navigates (faster for manual navigation)
  useEffect(() => {
    if (scrollToChannelIdx === undefined) {
      focusedRowRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedChannelIdx, scrollToChannelIdx]);

  // Sync horizontal scroll between grid and time header, and track scroll position for sticky titles
  useEffect(() => {
    const grid = gridRef.current;
    const timeHeader = timeHeaderRef.current;
    if (!grid || !timeHeader) return;

    const handleGridScroll = () => {
      // Track scroll position for sticky program titles
      setScrollLeft(grid.scrollLeft);
      
      if (isScrollingSynced.current) return;
      isScrollingSynced.current = true;
      timeHeader.scrollLeft = grid.scrollLeft;
      requestAnimationFrame(() => { isScrollingSynced.current = false; });
    };

    const handleHeaderScroll = () => {
      if (isScrollingSynced.current) return;
      isScrollingSynced.current = true;
      grid.scrollLeft = timeHeader.scrollLeft;
      setScrollLeft(timeHeader.scrollLeft);
      requestAnimationFrame(() => { isScrollingSynced.current = false; });
    };

    grid.addEventListener('scroll', handleGridScroll);
    timeHeader.addEventListener('scroll', handleHeaderScroll);

    return () => {
      grid.removeEventListener('scroll', handleGridScroll);
      timeHeader.removeEventListener('scroll', handleHeaderScroll);
    };
  }, []);

  // Scroll to current time on initial load (so "now" is visible)
  const hasInitialScrolled = useRef(false);
  useEffect(() => {
    // Skip if already scrolled
    if (hasInitialScrolled.current) return;
    
    // Wait for DOM refs to be ready
    if (!gridRef.current || !timeHeaderRef.current) return;
    
    // Wait for container to be measured (ResizeObserver needs to fire)
    if (containerWidth === 0) return;
    
    // Use actual current time (not the prop which might be stale on first render)
    const now = new Date();
    const rangeStartMs = timeRange.start.getTime();
    const elapsedMs = now.getTime() - rangeStartMs;
    
    // Calculate scroll position: each 30-min slot = timeSlotWidth
    const scrollPosition = (elapsedMs / (30 * 60 * 1000)) * timeSlotWidth;
    
    // Scroll so current time is about 10% from the left edge
    const paddingLeft = Math.max(availableWidth * 0.1, 20);
    const targetScroll = Math.max(0, scrollPosition - paddingLeft);
    
    gridRef.current.scrollLeft = targetScroll;
    timeHeaderRef.current.scrollLeft = targetScroll;
    setScrollLeft(targetScroll); // Update state for sticky titles
    hasInitialScrolled.current = true;
  }, [containerWidth, timeSlotWidth, availableWidth, timeRange]);

  // Current time marker position (includes channel col width since it's part of the layout)
  const nowOffset = ((currentTime.getTime() - timeRange.start.getTime()) / (30 * 60 * 1000)) * timeSlotWidth + channelColWidth;

  return (
    <div className="guide-grid-container" ref={containerRef}>
      {/* Time header */}
      <div className="guide-time-header">
        <div className="guide-time-header-spacer" style={{ width: channelColWidth }} />
        <div className="guide-time-header-slots" ref={timeHeaderRef}>
          {timeSlots.map((slot, i) => (
            <div
              key={i}
              className="guide-time-slot"
              style={{ width: timeSlotWidth }}
            >
              {slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          ))}
        </div>
      </div>

      {/* Grid body */}
      <div className="guide-grid" ref={gridRef}>
        {/* Now marker */}
        <div
          className="guide-now-marker"
          style={{ left: nowOffset, height: channels.length * rowHeight }}
        />

        {channels.map((channel, chIdx) => {
          const programs = scheduleByChannel.get(channel.id) || [];
          const isFocusedRow = chIdx === focusedChannelIdx;
          const isScrollTarget = chIdx === effectiveScrollIdx;

          // Determine which ref to attach (scroll target takes priority for auto-scroll)
          const rowRef = isScrollTarget ? scrollTargetRef : (isFocusedRow ? focusedRowRef : undefined);

          return (
            <div
              key={channel.id}
              ref={rowRef}
              className={`guide-row ${isFocusedRow ? 'guide-row-focused' : ''}`}
              style={{ height: rowHeight }}
            >
              {/* Channel number/name column */}
              <div
                className="guide-channel-col"
                style={{ width: channelColWidth }}
                onClick={() => onChannelClick(chIdx)}
              >
                <span className="guide-channel-num" style={{ fontSize: channelNumFontSize }}>
                  {channel.number}
                </span>
                <span className="guide-channel-name" style={{ fontSize: channelNameFontSize }}>
                  {channel.name}
                </span>
              </div>

              {/* Programs */}
              <div className="guide-programs-row" style={{ minWidth: timeSlots.length * timeSlotWidth }}>
                {programs.map((prog, progIdx) => {
                  const progStart = new Date(prog.start_time).getTime();
                  const progEnd = new Date(prog.end_time).getTime();
                  const rangeStart = timeRange.start.getTime();
                  const rangeEnd = timeRange.end.getTime();

                  // Skip programs outside visible range
                  if (progEnd <= rangeStart || progStart >= rangeEnd) return null;

                  // Calculate position and width
                  const visibleStart = Math.max(progStart, rangeStart);
                  const visibleEnd = Math.min(progEnd, rangeEnd);
                  const left = ((visibleStart - rangeStart) / (30 * 60 * 1000)) * timeSlotWidth;
                  const width = ((visibleEnd - visibleStart) / (30 * 60 * 1000)) * timeSlotWidth;
                  
                  const isFocused = isFocusedRow && progIdx === focusedProgramIdx;
                  const isCurrentlyAiring =
                    currentTime.getTime() >= progStart && currentTime.getTime() < progEnd;

                  // Show subtitle if cell is wide enough (threshold varies by device)
                  const subtitleThreshold = isMobile ? 120 : 150;
                  const showSubtitle = width > subtitleThreshold && prog.subtitle && prog.type !== 'interstitial';
                  
                  // Calculate sticky title offset - title slides within cell bounds as user scrolls
                  const padding = 8; // Match CSS padding
                  // How far has the user scrolled past this cell's left edge?
                  const scrollPastCell = scrollLeft - left;
                  // Reserve space for title text (estimate ~150px for title, but at least show something)
                  const reservedForText = Math.min(150, width * 0.4);
                  // Clamp the offset: 0 if not scrolled past, or capped so title stays within cell
                  const maxOffset = Math.max(0, width - padding * 2 - reservedForText);
                  const titleOffset = Math.max(0, Math.min(scrollPastCell, maxOffset));
                  
                  return (
                    <div
                      key={`${prog.start_time}-${progIdx}`}
                      className={`guide-program-cell ${isFocused ? 'guide-program-focused' : ''} ${isCurrentlyAiring ? 'guide-program-airing' : ''} ${prog.type === 'interstitial' ? 'guide-program-interstitial' : ''}`}
                      style={{ left, width: Math.max(width, 2) }}
                      onClick={() => onProgramClick(chIdx, progIdx)}
                      title={prog.title + (prog.subtitle ? ` - ${prog.subtitle}` : '')}
                    >
                      <div 
                        className="guide-program-content"
                        style={{ transform: `translateX(${titleOffset}px)` }}
                      >
                        <span className="guide-program-title" style={{ fontSize: programTitleFontSize }}>
                          {prog.title}
                        </span>
                        {showSubtitle && (
                          <span className="guide-program-subtitle" style={{ fontSize: Math.max(programTitleFontSize - 3, 9) }}>
                            {prog.subtitle}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
