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
const BASE_CHANNEL_COL_WIDTH = 144; /* ~20% larger for readable channel names */
const MIN_CHANNEL_COL_WIDTH = 72;
const MIN_ROW_HEIGHT = 44; // Touch-friendly minimum
const PROGRAM_CELL_GAP = 6; // Horizontal spacing between schedule blocks

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
  const scrollLeftRef = useRef(0); // Track horizontal scroll for sticky titles (ref to avoid per-frame re-renders)
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
  
  // Channel column width - smaller on mobile, but with minimum (~20% larger for readability)
  const baseColWidth = isMobile ? (isSmallMobile ? 78 : 96) : BASE_CHANNEL_COL_WIDTH;
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

  // Snap target row to top of view (return from player or auto-scroll)
  const scrollRowToTop = (element: HTMLElement) => {
    const container = gridRef.current;
    if (!container) return;
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    container.scrollTop = container.scrollTop + (elementRect.top - containerRect.top);
  };

  // When scroll target is set, snap that row to the top
  useEffect(() => {
    if (scrollTargetRef.current && isAutoScrolling) {
      scrollRowToTop(scrollTargetRef.current);
    }
  }, [effectiveScrollIdx, isAutoScrolling]);
  
  // Scroll focused row into view when user navigates (centered so guide moves with user)
  useEffect(() => {
    if (scrollToChannelIdx === undefined) {
      focusedRowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focusedChannelIdx, scrollToChannelIdx]);

  // Drive horizontal scroll by continuous time so the schedule slides left smoothly (classic TV guide strip).
  // Uses direct DOM manipulation only — no React state updates per frame, so no re-render jank.
  const SLOT_MS = 30 * 60 * 1000;
  useEffect(() => {
    const grid = gridRef.current;
    const timeHeader = timeHeaderRef.current;
    if (!grid || !timeHeader || availableWidth <= 0 || timeSlotWidth <= 0) return;

    const rangeStartMs = timeRange.start.getTime();
    const maxScroll = Math.max(0, timeSlots.length * timeSlotWidth - availableWidth);

    let rafId: number;
    const tick = () => {
      const elapsedMs = Date.now() - rangeStartMs;
      // Continuous position — no Math.floor, so it moves every frame
      const scrollPosition = (elapsedMs / SLOT_MS) * timeSlotWidth;
      const scroll = Math.max(0, Math.min(maxScroll, scrollPosition));

      // Direct DOM writes only — no setState to avoid re-render overhead
      grid.scrollLeft = scroll;
      timeHeader.scrollLeft = scroll;
      scrollLeftRef.current = scroll;

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [timeRange, timeSlotWidth, availableWidth, timeSlots.length]);

  const currentTimeStr = currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

  return (
    <div
      className="guide-grid-container"
      ref={containerRef}
      style={{ '--guide-channel-col-width': `${channelColWidth}px` } as React.CSSProperties}
    >
      {/* Time header - width must match channel column exactly */}
      <div className="guide-time-header">
        <div className="guide-time-header-spacer guide-time-header-clock-wrap">
          <span className="guide-time-header-clock">{currentTimeStr}</span>
        </div>
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

                  // Calculate position and width (with gap between adjacent blocks)
                  const visibleStart = Math.max(progStart, rangeStart);
                  const visibleEnd = Math.min(progEnd, rangeEnd);
                  const left = ((visibleStart - rangeStart) / (30 * 60 * 1000)) * timeSlotWidth + PROGRAM_CELL_GAP / 2;
                  const width = Math.max(((visibleEnd - visibleStart) / (30 * 60 * 1000)) * timeSlotWidth - PROGRAM_CELL_GAP, 2);
                  
                  const isFocused = isFocusedRow && progIdx === focusedProgramIdx;
                  const isCurrentlyAiring =
                    currentTime.getTime() >= progStart && currentTime.getTime() < progEnd;

                  // Show subtitle if cell is wide enough (threshold varies by device)
                  const subtitleThreshold = isMobile ? 120 : 150;
                  const showSubtitle = width > subtitleThreshold && prog.subtitle && prog.type !== 'interstitial';
                  
                  // Calculate sticky title offset - title slides within cell bounds as time scrolls
                  const padding = 8; // Match CSS padding
                  // How far has the grid scrolled past this cell's left edge?
                  const scrollPastCell = scrollLeftRef.current - left;
                  // Reserve space for title text (estimate ~150px for title, but at least show something)
                  const reservedForText = Math.min(150, width * 0.4);
                  // Clamp the offset: 0 if not scrolled past, or capped so title stays within cell
                  const maxOffset = Math.max(0, width - padding * 2 - reservedForText);
                  const titleOffset = Math.max(0, Math.min(scrollPastCell, maxOffset));
                  
                  return (
                    <div
                      key={`${prog.start_time}-${progIdx}`}
                      className={`guide-program-cell ${isFocused ? 'guide-program-focused' : ''} ${isCurrentlyAiring ? 'guide-program-airing' : ''} ${prog.type === 'interstitial' ? 'guide-program-interstitial' : ''}`}
                      style={{ left, width }}
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
