import { memo, useRef, useEffect, useMemo, useState, useCallback } from 'react';
import type { ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import {
  getGuideColorsEnabled,
  getGuideColorMovie,
  getGuideColorEpisode,
  getGuideRatings,
  getGuideArtwork,
  getClockFormat,
  type ClockFormat,
} from '../Settings/DisplaySettings';
import './Guide.css';

let artworkCache = new Map<string, string>();
let artworkPending = new Set<string>();
let artworkFailed = new Set<string>();

function clearArtworkCache(): void {
  for (const url of artworkCache.values()) {
    URL.revokeObjectURL(url);
  }
  artworkCache = new Map();
  artworkPending = new Set();
  artworkFailed = new Set();
}

const ArtworkThumbnail = memo(function ArtworkThumbnail({ itemId, size }: { itemId: string; size: number }) {
  const [src, setSrc] = useState<string | null>(artworkCache.get(itemId) || null);
  const [failed, setFailed] = useState(artworkFailed.has(itemId));

  useEffect(() => {
    if (artworkCache.has(itemId)) {
      setSrc(artworkCache.get(itemId) || null);
      return;
    }
    if (artworkFailed.has(itemId)) {
      setFailed(true);
      return;
    }
    if (artworkPending.has(itemId)) return;

    artworkPending.add(itemId);
    fetch(`/api/images/${itemId}/Primary?maxWidth=80`)
      .then(res => {
        if (!res.ok) throw new Error('not found');
        return res.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        artworkCache.set(itemId, url);
        artworkPending.delete(itemId);
        setSrc(url);
      })
      .catch(() => {
        artworkPending.delete(itemId);
        artworkFailed.add(itemId);
        setFailed(true);
      });
  }, [itemId]);

  if (failed || !src) return null;

  return (
    <img
      className="guide-program-artwork"
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
    />
  );
});

interface GuideGridProps {
  channels: ChannelWithProgram[];
  scheduleByChannel: Map<number, ScheduleProgram[]>;
  focusedChannelIdx: number;
  focusedProgramIdx: number;
  visibleChannels: number;
  guideHours: number;
  scrollToChannelIdx?: number;
  smoothScroll?: boolean;
  onChannelClick: (channelIdx: number) => void;
  onProgramClick: (channelIdx: number, programIdx: number) => void;
}

const BASE_ROW_HEIGHT = 52;
const BASE_CHANNEL_COL_WIDTH = 144;
const MIN_CHANNEL_COL_WIDTH = 72;
const MIN_ROW_HEIGHT = 44;
const PROGRAM_CELL_GAP = 6;
const SLOT_MS = 30 * 60 * 1000;
const TOTAL_SCHEDULE_HOURS = 8;
const VIRTUAL_OVERSCAN_ROWS = 4;

interface GuideProgramCellProps {
  prog: ScheduleProgram;
  progIdx: number;
  chIdx: number;
  isFocused: boolean;
  nowMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  timeSlotWidth: number;
  isMobile: boolean;
  showArtwork: boolean;
  artworkThreshold: number;
  artworkSize: number;
  showRatings: boolean;
  programTitleFontSize: number;
  guideColors: { enabled: boolean; movie: string; episode: string };
  scrollLeft: number;
  onProgramClick: (channelIdx: number, programIdx: number) => void;
}

const GuideProgramCell = memo(function GuideProgramCell({
  prog,
  progIdx,
  chIdx,
  isFocused,
  nowMs,
  rangeStartMs,
  rangeEndMs,
  timeSlotWidth,
  isMobile,
  showArtwork,
  artworkThreshold,
  artworkSize,
  showRatings,
  programTitleFontSize,
  guideColors,
  scrollLeft,
  onProgramClick,
}: GuideProgramCellProps) {
  const progStart = new Date(prog.start_time).getTime();
  const progEnd = new Date(prog.end_time).getTime();

  if (progEnd <= rangeStartMs || progStart >= rangeEndMs) return null;

  const visibleStart = Math.max(progStart, rangeStartMs);
  const visibleEnd = Math.min(progEnd, rangeEndMs);
  const left = ((visibleStart - rangeStartMs) / SLOT_MS) * timeSlotWidth + PROGRAM_CELL_GAP / 2;
  const width = Math.max(((visibleEnd - visibleStart) / SLOT_MS) * timeSlotWidth - PROGRAM_CELL_GAP, 2);

  const isCurrentlyAiring = nowMs >= progStart && nowMs < progEnd;
  const subtitleThreshold = isMobile ? 120 : 150;
  const showSubtitle = width > subtitleThreshold && prog.subtitle && prog.type !== 'interstitial';
  const cellShowArtwork = showArtwork && prog.type !== 'interstitial' && prog.thumbnail_url && width > artworkThreshold;
  const artworkSpace = cellShowArtwork ? artworkSize + 6 : 0;

  const padding = 8;
  const scrollPastCell = scrollLeft - left;
  const reservedForText = Math.min(150, width * 0.4);
  const maxOffset = Math.max(0, width - padding * 2 - reservedForText - artworkSpace);
  const titleOffset = Math.max(0, Math.min(scrollPastCell, maxOffset));

  const cellBg = guideColors.enabled && prog.type !== 'interstitial'
    ? prog.content_type === 'movie'
      ? guideColors.movie
      : prog.content_type === 'episode'
        ? guideColors.episode
        : undefined
    : undefined;

  const clippedMs = rangeStartMs - progStart;
  const continuationArrow = clippedMs > SLOT_MS ? '\u25C2\u25C2 ' : clippedMs > 0 ? '\u25C2 ' : '';

  return (
    <div
      className={`guide-program-cell ${isFocused ? 'guide-program-focused' : ''} ${isCurrentlyAiring ? 'guide-program-airing' : ''} ${prog.type === 'interstitial' ? 'guide-program-interstitial' : ''}`}
      style={{ left, width, background: cellBg }}
      onClick={() => onProgramClick(chIdx, progIdx)}
      title={prog.title + (prog.subtitle ? ` - ${prog.subtitle}` : '')}
    >
      <div className="guide-program-content" style={{ transform: `translateX(${titleOffset}px)` }}>
        {continuationArrow && <span className="guide-continuation-arrow">{continuationArrow}</span>}
        {cellShowArtwork && (
          <ArtworkThumbnail itemId={prog.jellyfin_item_id} size={artworkSize} />
        )}
        <div className="guide-program-text">
          <span className="guide-program-title" style={{ fontSize: programTitleFontSize }}>
            {prog.title}
            {showRatings && prog.rating && prog.type !== 'interstitial' && (
              <span className="guide-rating-badge">{prog.rating}</span>
            )}
          </span>
          {showSubtitle && (
            <span className="guide-program-subtitle" style={{ fontSize: Math.max(programTitleFontSize - 3, 9) }}>
              {prog.subtitle}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

interface GuideRowProps {
  channel: ChannelWithProgram;
  chIdx: number;
  programs: ScheduleProgram[];
  rowHeight: number;
  isFocusedRow: boolean;
  focusedProgramIdx: number;
  nowMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  timeSlotWidth: number;
  totalSlotsWidth: number;
  isMobile: boolean;
  showArtwork: boolean;
  artworkThreshold: number;
  artworkSize: number;
  showRatings: boolean;
  programTitleFontSize: number;
  guideColors: { enabled: boolean; movie: string; episode: string };
  scrollLeft: number;
  channelNumFontSize: number;
  channelNameFontSize: number;
  onChannelClick: (channelIdx: number) => void;
  onProgramClick: (channelIdx: number, programIdx: number) => void;
}

const GuideRow = memo(function GuideRow({
  channel,
  chIdx,
  programs,
  rowHeight,
  isFocusedRow,
  focusedProgramIdx,
  nowMs,
  rangeStartMs,
  rangeEndMs,
  timeSlotWidth,
  totalSlotsWidth,
  isMobile,
  showArtwork,
  artworkThreshold,
  artworkSize,
  showRatings,
  programTitleFontSize,
  guideColors,
  scrollLeft,
  channelNumFontSize,
  channelNameFontSize,
  onChannelClick,
  onProgramClick,
}: GuideRowProps) {
  return (
    <div className={`guide-row ${isFocusedRow ? 'guide-row-focused' : ''}`} style={{ height: rowHeight }}>
      <div className="guide-channel-col" onClick={() => onChannelClick(chIdx)}>
        <span className="guide-channel-num" style={{ fontSize: channelNumFontSize }}>{channel.number}</span>
        <span className="guide-channel-name" style={{ fontSize: channelNameFontSize }}>{channel.name}</span>
      </div>

      <div className="guide-programs-row" style={{ minWidth: totalSlotsWidth }}>
        {programs.map((prog, progIdx) => (
          <GuideProgramCell
            key={`${prog.start_time}-${progIdx}`}
            prog={prog}
            progIdx={progIdx}
            chIdx={chIdx}
            isFocused={isFocusedRow && progIdx === focusedProgramIdx}
            nowMs={nowMs}
            rangeStartMs={rangeStartMs}
            rangeEndMs={rangeEndMs}
            timeSlotWidth={timeSlotWidth}
            isMobile={isMobile}
            showArtwork={showArtwork}
            artworkThreshold={artworkThreshold}
            artworkSize={artworkSize}
            showRatings={showRatings}
            programTitleFontSize={programTitleFontSize}
            guideColors={guideColors}
            scrollLeft={scrollLeft}
            onProgramClick={onProgramClick}
          />
        ))}
      </div>
    </div>
  );
});

function GuideGrid({
  channels,
  scheduleByChannel,
  focusedChannelIdx,
  focusedProgramIdx,
  visibleChannels,
  guideHours,
  scrollToChannelIdx,
  smoothScroll = false,
  onChannelClick,
  onProgramClick,
}: GuideGridProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const timeHeaderRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);
  const verticalScrollAnimRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const [gridHeight, setGridHeight] = useState(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const scrollLeftRef = useRef(0);

  const [guideColors, setGuideColors] = useState(() => ({
    enabled: getGuideColorsEnabled(),
    movie: getGuideColorMovie(),
    episode: getGuideColorEpisode(),
  }));
  const [showRatings, setShowRatings] = useState(getGuideRatings);
  const [showArtwork, setShowArtwork] = useState(getGuideArtwork);
  const [clockFormat, setClockFormatState] = useState<ClockFormat>(getClockFormat);

  useEffect(() => {
    const refreshGuideColors = () => {
      setGuideColors({
        enabled: getGuideColorsEnabled(),
        movie: getGuideColorMovie(),
        episode: getGuideColorEpisode(),
      });
    };
    const refreshRatings = () => setShowRatings(getGuideRatings());
    const refreshArtwork = () => setShowArtwork(getGuideArtwork());
    const refreshClockFormat = () => setClockFormatState(getClockFormat());

    window.addEventListener('guidecolorschange', refreshGuideColors);
    window.addEventListener('guideratingschange', refreshRatings);
    window.addEventListener('guideartworkchange', refreshArtwork);
    window.addEventListener('clockformatchange', refreshClockFormat);

    return () => {
      window.removeEventListener('guidecolorschange', refreshGuideColors);
      window.removeEventListener('guideratingschange', refreshRatings);
      window.removeEventListener('guideartworkchange', refreshArtwork);
      window.removeEventListener('clockformatchange', refreshClockFormat);
    };
  }, []);

  useEffect(() => {
    clearArtworkCache();
    return () => clearArtworkCache();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const updateClock = () => {
      if (!clockRef.current) return;
      clockRef.current.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: clockFormat === '12h',
      });
    };
    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, [clockFormat]);

  useEffect(() => {
    const container = containerRef.current;
    const grid = gridRef.current;
    if (!container || !grid) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === grid) setGridHeight(entry.contentRect.height);
        if (entry.target === container) setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(grid);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const isMobile = containerWidth > 0 && containerWidth < 768;
  const isSmallMobile = containerWidth > 0 && containerWidth < 480;

  const rawRowHeight = gridHeight > 0 ? Math.floor(gridHeight / visibleChannels) : BASE_ROW_HEIGHT;
  const rowHeight = Math.max(rawRowHeight, MIN_ROW_HEIGHT);
  const scale = rowHeight / BASE_ROW_HEIGHT;

  const baseColWidth = isMobile ? (isSmallMobile ? 78 : 96) : BASE_CHANNEL_COL_WIDTH;
  const channelColWidth = Math.max(Math.round(baseColWidth * Math.min(scale, 1.5)), MIN_CHANNEL_COL_WIDTH);

  const numVisibleTimeSlots = guideHours * 2;
  const availableWidth = containerWidth - channelColWidth;
  const timeSlotWidth = availableWidth > 0 ? Math.floor(availableWidth / numVisibleTimeSlots) : 200;

  const baseFontScale = Math.min(scale, isMobile ? 1.5 : 2.5);
  const channelNumFontSize = Math.max(Math.round(12 * baseFontScale), isMobile ? 11 : 12);
  const channelNameFontSize = Math.max(Math.round(8 * baseFontScale), isMobile ? 8 : 7);
  const zoomFontScale = Math.min(1.4, 4 / guideHours);
  const programTitleFontSize = Math.max(Math.round(12 * baseFontScale * zoomFontScale), isMobile ? 11 : 12);

  const artworkSize = Math.max(Math.round(rowHeight - 12), 24);
  const artworkThreshold = isMobile ? 100 : 120;

  const timeHeaderHeight = Math.max(28, Math.min(48, Math.round(32 * Math.min(scale, 1.5))));
  const clockMaxForCol = Math.floor((channelColWidth - 16) / 8);
  const timeHeaderClockFontSize = Math.min(Math.max(Math.round(10 * baseFontScale), isMobile ? 8 : 9), clockMaxForCol);
  const timeSlotFontSize = Math.max(Math.round(9 * baseFontScale), isMobile ? 8 : 9);

  const timeRange = useMemo(() => {
    const start = new Date(nowMs);
    start.setMinutes(Math.floor(start.getMinutes() / 30) * 30, 0, 0);
    const end = new Date(start);
    end.setHours(end.getHours() + TOTAL_SCHEDULE_HOURS);
    return { start, end };
  }, [Math.floor(nowMs / SLOT_MS)]);

  const timeSlots = useMemo(() => {
    const slots: Date[] = [];
    const t = new Date(timeRange.start);
    while (t < timeRange.end) {
      slots.push(new Date(t));
      t.setMinutes(t.getMinutes() + 30);
    }
    return slots;
  }, [timeRange]);

  const totalSlotsWidth = timeSlots.length * timeSlotWidth;
  const maxScroll = timeSlotWidth;
  const effectiveScrollIdx = scrollToChannelIdx ?? focusedChannelIdx;
  const isAutoScrolling = scrollToChannelIdx !== undefined;

  const animateVerticalScroll = useCallback((targetTop: number, smooth: boolean) => {
    const container = gridRef.current;
    if (!container) return;

    if (verticalScrollAnimRef.current !== null) {
      cancelAnimationFrame(verticalScrollAnimRef.current);
      verticalScrollAnimRef.current = null;
    }

    if (!smooth) {
      container.scrollTop = targetTop;
      return;
    }

    const startTop = container.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 1) {
      container.scrollTop = targetTop;
      return;
    }

    const durationMs = 420;
    const startAt = performance.now();
    const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

    const animate = (now: number) => {
      const elapsed = now - startAt;
      const progress = Math.min(elapsed / durationMs, 1);
      container.scrollTop = startTop + distance * easeInOutCubic(progress);
      if (progress < 1) {
        verticalScrollAnimRef.current = requestAnimationFrame(animate);
      } else {
        verticalScrollAnimRef.current = null;
      }
    };

    verticalScrollAnimRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    if (!isAutoScrolling) return;
    animateVerticalScroll(Math.max(0, effectiveScrollIdx * rowHeight), smoothScroll);
  }, [isAutoScrolling, effectiveScrollIdx, rowHeight, smoothScroll, animateVerticalScroll]);

  useEffect(() => {
    if (scrollToChannelIdx !== undefined) return;
    const container = gridRef.current;
    if (!container) return;
    const centeredTop = Math.max(0, focusedChannelIdx * rowHeight - (container.clientHeight - rowHeight) / 2);
    animateVerticalScroll(centeredTop, true);
  }, [focusedChannelIdx, rowHeight, scrollToChannelIdx, animateVerticalScroll]);

  const handleGridScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(gridRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => {
    const grid = gridRef.current;
    const timeHeader = timeHeaderRef.current;
    if (!grid || !timeHeader || availableWidth <= 0 || timeSlotWidth <= 0) return;

    const rangeStartMs = timeRange.start.getTime();

    let rafId: number;
    const tick = () => {
      const elapsedMs = Date.now() - rangeStartMs;
      const scrollPosition = (elapsedMs / SLOT_MS) * timeSlotWidth;
      const scroll = Math.max(0, Math.min(maxScroll, scrollPosition));
      grid.scrollLeft = scroll;
      timeHeader.scrollLeft = scroll;
      scrollLeftRef.current = scroll;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [timeRange, timeSlotWidth, availableWidth, maxScroll]);

  useEffect(() => {
    return () => {
      if (verticalScrollAnimRef.current !== null) cancelAnimationFrame(verticalScrollAnimRef.current);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  const visibleRowCount = Math.max(1, Math.ceil((gridHeight || 1) / rowHeight));
  let virtualStart = Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN_ROWS);
  let virtualEnd = Math.min(channels.length, virtualStart + visibleRowCount + VIRTUAL_OVERSCAN_ROWS * 2);
  const mustIncludeStart = Math.min(focusedChannelIdx, effectiveScrollIdx);
  const mustIncludeEnd = Math.max(focusedChannelIdx, effectiveScrollIdx);
  virtualStart = Math.max(0, Math.min(virtualStart, mustIncludeStart));
  virtualEnd = Math.min(channels.length, Math.max(virtualEnd, mustIncludeEnd + 1));

  return (
    <div
      className="guide-grid-container"
      ref={containerRef}
      style={{ '--guide-channel-col-width': `${channelColWidth}px` } as React.CSSProperties}
    >
      <div className="guide-time-header" style={{ height: timeHeaderHeight }}>
        <div className="guide-time-header-spacer guide-time-header-clock-wrap">
          <span ref={clockRef} className="guide-time-header-clock" style={{ fontSize: timeHeaderClockFontSize }} />
        </div>
        <div className="guide-time-header-slots" ref={timeHeaderRef}>
          {timeSlots.map((slot, i) => (
            <div key={i} className="guide-time-slot" style={{ width: timeSlotWidth, fontSize: timeSlotFontSize }}>
              {slot.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: clockFormat === '12h' })}
            </div>
          ))}
        </div>
      </div>

      <div className="guide-grid" ref={gridRef} onScroll={handleGridScroll}>
        <div className="guide-rows-virtualizer" style={{ height: channels.length * rowHeight }}>
          {channels.slice(virtualStart, virtualEnd).map((channel, offset) => {
            const chIdx = virtualStart + offset;
            const programs = scheduleByChannel.get(channel.id) || [];
            return (
              <div key={channel.id} className="guide-row-virtual-item" style={{ top: chIdx * rowHeight }}>
                <GuideRow
                  channel={channel}
                  chIdx={chIdx}
                  programs={programs}
                  rowHeight={rowHeight}
                  isFocusedRow={chIdx === focusedChannelIdx}
                  focusedProgramIdx={focusedProgramIdx}
                  nowMs={nowMs}
                  rangeStartMs={timeRange.start.getTime()}
                  rangeEndMs={timeRange.end.getTime()}
                  timeSlotWidth={timeSlotWidth}
                  totalSlotsWidth={totalSlotsWidth}
                  isMobile={isMobile}
                  showArtwork={showArtwork}
                  artworkThreshold={artworkThreshold}
                  artworkSize={artworkSize}
                  showRatings={showRatings}
                  programTitleFontSize={programTitleFontSize}
                  guideColors={guideColors}
                  scrollLeft={scrollLeftRef.current}
                  channelNumFontSize={channelNumFontSize}
                  channelNameFontSize={channelNameFontSize}
                  onChannelClick={onChannelClick}
                  onProgramClick={onProgramClick}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default memo(GuideGrid);