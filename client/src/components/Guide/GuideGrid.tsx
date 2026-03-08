import { memo, useRef, useEffect, useMemo, useState, useCallback } from 'react';
import type { ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import {
  getGuideColorsEnabled,
  getGuideColorMovie,
  getGuideColorEpisode,
  getGuideRatings,
  getGuideYear,
  getGuideResolution,
  getGuideHdr,
  getGuideArtwork,
  getClockFormat,
  type ClockFormat,
} from '../Settings/DisplaySettings';
import { getIconicScenesEnabled } from '../Settings/GeneralSettings';
import { isIconicSceneActive } from './guideFilterUtils';
import {
  type GuideDivider,
  getGuideDividers,
  getChannelColors,
  hydrateDividersFromServer,
  hydrateChannelColorsFromServer,
  persistDividers,
  persistChannelColors,
} from '../../utils/guideCustomization';
import { getSettings } from '../../services/api';
import './Guide.css';

const MAX_ARTWORK_CACHE = 500;
let artworkCache = new Map<string, string>();
let artworkPending = new Set<string>();
let artworkFailed = new Set<string>();

function addToArtworkCache(key: string, url: string): void {
  if (artworkCache.size >= MAX_ARTWORK_CACHE) {
    const oldest = artworkCache.keys().next().value;
    if (oldest) {
      URL.revokeObjectURL(artworkCache.get(oldest)!);
      artworkCache.delete(oldest);
    }
  }
  artworkCache.set(key, url);
}

function getFromArtworkCache(key: string): string | undefined {
  const url = artworkCache.get(key);
  if (url !== undefined) {
    // Move to most-recent position (LRU)
    artworkCache.delete(key);
    artworkCache.set(key, url);
  }
  return url;
}

function clearArtworkCache(): void {
  for (const url of artworkCache.values()) {
    URL.revokeObjectURL(url);
  }
  artworkCache = new Map();
  artworkPending = new Set();
  artworkFailed = new Set();
}

const EMPTY_PROGRAMS: ScheduleProgram[] = [];

/** Binary-search filter: return only programs overlapping [rangeStartMs, rangeEndMs]. */
function getVisiblePrograms(
  programs: ScheduleProgram[],
  rangeStartMs: number,
  rangeEndMs: number,
): { programs: ScheduleProgram[]; startOffset: number } {
  if (programs.length === 0) return { programs, startOffset: 0 };

  // Find first program whose end_ms > rangeStartMs
  let lo = 0, hi = programs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((programs[mid].end_ms ?? 0) <= rangeStartMs) lo = mid + 1;
    else hi = mid;
  }
  const startIdx = lo;

  // Find first program whose start_ms >= rangeEndMs
  lo = startIdx; hi = programs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((programs[mid].start_ms ?? 0) >= rangeEndMs) hi = mid;
    else lo = mid + 1;
  }

  return { programs: programs.slice(startIdx, lo), startOffset: startIdx };
}

const ArtworkThumbnail = memo(function ArtworkThumbnail({ itemId, size }: { itemId: string; size: number }) {
  const [src, setSrc] = useState<string | null>(getFromArtworkCache(itemId) ?? null);
  const [failed, setFailed] = useState(artworkFailed.has(itemId));

  useEffect(() => {
    const cached = getFromArtworkCache(itemId);
    if (cached) {
      setSrc(cached);
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
        addToArtworkCache(itemId, url);
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
  hideDividers?: boolean;
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
  isAiring: boolean;
  rangeStartMs: number;
  rangeEndMs: number;
  timeSlotWidth: number;
  isMobile: boolean;
  showArtwork: boolean;
  artworkThreshold: number;
  artworkSize: number;
  showRatings: boolean;
  showYear: boolean;
  showResolution: boolean;
  showHdr: boolean;
  showIconicScenes: boolean;
  nowMs: number;
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
  isAiring,
  rangeStartMs,
  rangeEndMs,
  timeSlotWidth,
  isMobile,
  showArtwork,
  artworkThreshold,
  artworkSize,
  showRatings,
  showYear,
  showResolution,
  showHdr,
  showIconicScenes,
  nowMs,
  programTitleFontSize,
  guideColors,
  scrollLeft,
  onProgramClick,
}: GuideProgramCellProps) {
  const isIconicNow = showIconicScenes && isAiring && isIconicSceneActive(prog, nowMs);
  const progStart = prog.start_ms!;
  const progEnd = prog.end_ms!;

  const visibleStart = Math.max(progStart, rangeStartMs);
  const visibleEnd = Math.min(progEnd, rangeEndMs);
  const left = ((visibleStart - rangeStartMs) / SLOT_MS) * timeSlotWidth + PROGRAM_CELL_GAP / 2;
  const width = Math.max(((visibleEnd - visibleStart) / SLOT_MS) * timeSlotWidth - PROGRAM_CELL_GAP, 2);

  const isCurrentlyAiring = isAiring;
  const subtitleThreshold = isMobile ? 120 : 150;
  const showSubtitle = width > subtitleThreshold && prog.subtitle && prog.type !== 'interstitial';
  const cellShowArtwork = showArtwork && prog.type !== 'interstitial' && prog.thumbnail_url && width > artworkThreshold;
  const artworkSpace = cellShowArtwork ? artworkSize + 6 : 0;

  const padding = 8;
  // Compute scroll position from time rather than DOM scrollLeft to avoid
  // iOS momentum-scroll desync that causes text to pop right then snap back.
  const computedScrollLeft = ((Date.now() - rangeStartMs) / SLOT_MS) * timeSlotWidth;
  const scrollPastCell = computedScrollLeft - left;
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
      <div className="guide-program-content" style={{ transform: `translate3d(${titleOffset}px,0,0)` }}>
        {continuationArrow && <span className="guide-continuation-arrow">{continuationArrow}</span>}
        {cellShowArtwork && (
          <ArtworkThumbnail itemId={prog.media_item_id} size={artworkSize} />
        )}
        <div className="guide-program-text">
          <span className="guide-program-title" style={{ fontSize: programTitleFontSize }}>
            {prog.title}
            {prog.type !== 'interstitial' && (showRatings || showYear || showResolution || showHdr || isIconicNow) && (
              <>
                {showRatings && prog.rating && (
                  <span className="guide-rating-badge">{prog.rating}</span>
                )}
                {showYear && prog.year && (
                  <span className="guide-year-badge">{prog.year}</span>
                )}
                {showResolution && prog.resolution && (
                  <span className="guide-resolution-badge">{prog.resolution}</span>
                )}
                {showHdr && prog.is_hdr && (
                  <span className="guide-hdr-badge">HDR</span>
                )}
                {isIconicNow && (
                  <span className="guide-iconic-badge">ICONIC</span>
                )}
              </>
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
  airingKeys: Set<string>;
  rangeStartMs: number;
  rangeEndMs: number;
  timeSlotWidth: number;
  totalSlotsWidth: number;
  isMobile: boolean;
  showArtwork: boolean;
  artworkThreshold: number;
  artworkSize: number;
  showRatings: boolean;
  showYear: boolean;
  showResolution: boolean;
  showHdr: boolean;
  showIconicScenes: boolean;
  nowMs: number;
  programTitleFontSize: number;
  guideColors: { enabled: boolean; movie: string; episode: string };
  scrollLeft: number;
  channelNumFontSize: number;
  channelNameFontSize: number;
  channelColor?: string;
  programStartOffset: number;
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
  airingKeys,
  rangeStartMs,
  rangeEndMs,
  timeSlotWidth,
  totalSlotsWidth,
  isMobile,
  showArtwork,
  artworkThreshold,
  artworkSize,
  showRatings,
  showYear,
  showResolution,
  showHdr,
  showIconicScenes,
  nowMs,
  programTitleFontSize,
  guideColors,
  scrollLeft,
  channelNumFontSize,
  channelNameFontSize,
  channelColor,
  programStartOffset,
  onChannelClick,
  onProgramClick,
}: GuideRowProps) {
  const channelColStyle: React.CSSProperties = channelColor
    ? { background: isFocusedRow ? `linear-gradient(rgba(255,255,255,0.18), rgba(255,255,255,0.18)), ${channelColor}` : channelColor }
    : {};

  return (
    <div className={`guide-row ${isFocusedRow ? 'guide-row-focused' : ''}`} style={{ height: rowHeight }}>
      <div className="guide-channel-col" onClick={() => onChannelClick(chIdx)} style={channelColStyle}>
        <span className="guide-channel-num" style={{ fontSize: channelNumFontSize }}>{channel.number}</span>
        <span className="guide-channel-name" style={{ fontSize: channelNameFontSize }}>{channel.name}</span>
      </div>

      <div className="guide-programs-row" style={{ minWidth: totalSlotsWidth }}>
        {programs.map((prog, visIdx) => {
          const progIdx = visIdx + programStartOffset;
          return (
          <GuideProgramCell
            key={`${prog.start_time}-${progIdx}`}
            prog={prog}
            progIdx={progIdx}
            chIdx={chIdx}
            isFocused={isFocusedRow && progIdx === focusedProgramIdx}
            isAiring={airingKeys.has(`${channel.id}-${prog.start_time}`)}
            rangeStartMs={rangeStartMs}
            rangeEndMs={rangeEndMs}
            timeSlotWidth={timeSlotWidth}
            isMobile={isMobile}
            showArtwork={showArtwork}
            artworkThreshold={artworkThreshold}
            artworkSize={artworkSize}
            showRatings={showRatings}
            showYear={showYear}
            showResolution={showResolution}
            showHdr={showHdr}
            showIconicScenes={showIconicScenes}
            nowMs={nowMs}
            programTitleFontSize={programTitleFontSize}
            guideColors={guideColors}
            scrollLeft={scrollLeft}
            onProgramClick={onProgramClick}
          />
          );
        })}
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
  hideDividers = false,
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
  const [showYear, setShowYear] = useState(getGuideYear);
  const [showResolution, setShowResolution] = useState(getGuideResolution);
  const [showHdr, setShowHdr] = useState(getGuideHdr);
  const [showArtwork, setShowArtwork] = useState(getGuideArtwork);
  const [showIconicScenes, setShowIconicScenes] = useState(getIconicScenesEnabled);
  const [clockFormat, setClockFormatState] = useState<ClockFormat>(getClockFormat);

  // Channel colors & dividers from localStorage
  const [channelColorMap, setChannelColorMap] = useState<Record<number, string>>(() => getChannelColors());
  const [guideDividers, setGuideDividers] = useState<GuideDivider[]>(() => getGuideDividers());

  useEffect(() => {
    const refreshGuideColors = () => {
      setGuideColors({
        enabled: getGuideColorsEnabled(),
        movie: getGuideColorMovie(),
        episode: getGuideColorEpisode(),
      });
    };
    const refreshBadges = () => {
      setShowRatings(getGuideRatings());
      setShowYear(getGuideYear());
      setShowResolution(getGuideResolution());
      setShowHdr(getGuideHdr());
    };
    const refreshArtwork = () => setShowArtwork(getGuideArtwork());
    const refreshClockFormat = () => setClockFormatState(getClockFormat());
    const refreshChannelColors = () => setChannelColorMap(getChannelColors());
    const refreshDividers = () => setGuideDividers(getGuideDividers());
    const refreshIconicScenes = () => setShowIconicScenes(getIconicScenesEnabled());

    window.addEventListener('guidecolorschange', refreshGuideColors);
    window.addEventListener('guidebadgeschange', refreshBadges);
    window.addEventListener('guideartworkchange', refreshArtwork);
    window.addEventListener('clockformatchange', refreshClockFormat);
    window.addEventListener('channelcolorschange', refreshChannelColors);
    window.addEventListener('guidedividerschange', refreshDividers);
    window.addEventListener('iconicsceneschange', refreshIconicScenes);

    return () => {
      window.removeEventListener('guidecolorschange', refreshGuideColors);
      window.removeEventListener('guidebadgeschange', refreshBadges);
      window.removeEventListener('guideartworkchange', refreshArtwork);
      window.removeEventListener('clockformatchange', refreshClockFormat);
      window.removeEventListener('channelcolorschange', refreshChannelColors);
      window.removeEventListener('guidedividerschange', refreshDividers);
      window.removeEventListener('iconicsceneschange', refreshIconicScenes);
    };
  }, []);

  // Hydrate dividers & channel colors from server on mount.
  // If server has data, use it. If server is empty but localStorage has data, push it up.
  useEffect(() => {
    getSettings().then((settings: Record<string, unknown>) => {
      // Dividers
      if (Array.isArray(settings['guide_dividers']) && (settings['guide_dividers'] as GuideDivider[]).length > 0) {
        hydrateDividersFromServer(settings['guide_dividers'] as GuideDivider[]);
        setGuideDividers(settings['guide_dividers'] as GuideDivider[]);
      } else {
        const local = getGuideDividers();
        if (local.length > 0) persistDividers(local);
      }
      // Channel colors
      if (settings['channel_colors'] && typeof settings['channel_colors'] === 'object' && !Array.isArray(settings['channel_colors']) && Object.keys(settings['channel_colors'] as object).length > 0) {
        hydrateChannelColorsFromServer(settings['channel_colors'] as Record<number, string>);
        setChannelColorMap(settings['channel_colors'] as Record<number, string>);
      } else {
        const local = getChannelColors();
        if (Object.keys(local).length > 0) persistChannelColors(local);
      }
    }).catch(() => { /* use localStorage fallback */ });
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
  const timeHeaderClockFontSize = Math.max(Math.round(10 * baseFontScale), isMobile ? 8 : 9);
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

  const rangeStartMs = timeRange.start.getTime();
  const rangeEndMs = timeRange.end.getTime();

  // Compute set of currently-airing program keys so cells get a stable boolean prop
  const airingKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [channelId, programs] of scheduleByChannel) {
      for (const prog of programs) {
        if (nowMs >= prog.start_ms! && nowMs < prog.end_ms!) {
          keys.add(`${channelId}-${prog.start_time}`);
        }
      }
    }
    return keys;
  }, [nowMs, scheduleByChannel]);

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

  // Scroll-to-channel effects moved below guideItems/itemOffsets declarations

  const handleGridScroll = useCallback(() => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setScrollTop(gridRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || availableWidth <= 0 || timeSlotWidth <= 0) return;

    let rafId: number;
    let lastScroll = -1;
    const tick = () => {
      const elapsedMs = Date.now() - rangeStartMs;
      const scrollPosition = (elapsedMs / SLOT_MS) * timeSlotWidth;
      const scroll = Math.round(Math.max(0, Math.min(maxScroll, scrollPosition)));
      if (scroll !== lastScroll) {
        // Use CSS custom property + transforms instead of scrollLeft to avoid
        // iOS momentum-scroll desync that causes text to pop right then snap back.
        container.style.setProperty('--guide-scroll-x', `-${scroll}px`);
        scrollLeftRef.current = scroll;
        lastScroll = scroll;
      }
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

  // Build merged guide rows: channels + dividers sorted by sort_order
  type GuideItem =
    | { kind: 'channel'; channel: ChannelWithProgram; chIdx: number }
    | { kind: 'divider'; divider: GuideDivider };

  const guideItems = useMemo<GuideItem[]>(() => {
    const items: GuideItem[] = [];
    let chIdx = 0;
    // Build separate lists
    const chList = channels.map(c => ({ sort: c.sort_order, kind: 'channel' as const, channel: c }));
    const divList = hideDividers ? [] : guideDividers.map(d => ({ sort: d.sort_order, kind: 'divider' as const, divider: d }));
    const all = [...chList, ...divList].sort((a, b) => a.sort - b.sort);
    for (const entry of all) {
      if (entry.kind === 'channel') {
        items.push({ kind: 'channel', channel: entry.channel, chIdx });
        chIdx++;
      } else {
        items.push({ kind: 'divider', divider: entry.divider });
      }
    }
    return items;
  }, [channels, guideDividers, hideDividers]);

  // Compute cumulative top offsets for mixed row heights
  const itemOffsets = useMemo(() => {
    const offsets: number[] = [];
    let top = 0;
    for (const item of guideItems) {
      offsets.push(top);
      top += rowHeight;
    }
    return { offsets, totalHeight: top };
  }, [guideItems, rowHeight]);

  // Helper: find the top offset for a channel by its chIdx in the merged guide items
  const getChannelTop = useCallback((chIdx: number) => {
    const guideIdx = guideItems.findIndex(g => g.kind === 'channel' && g.chIdx === chIdx);
    if (guideIdx >= 0 && itemOffsets.offsets[guideIdx] !== undefined) return itemOffsets.offsets[guideIdx];
    return chIdx * rowHeight; // fallback
  }, [guideItems, itemOffsets, rowHeight]);

  useEffect(() => {
    if (!isAutoScrolling) return;
    animateVerticalScroll(Math.max(0, getChannelTop(effectiveScrollIdx)), smoothScroll);
  }, [isAutoScrolling, effectiveScrollIdx, smoothScroll, animateVerticalScroll, getChannelTop]);

  useEffect(() => {
    if (scrollToChannelIdx !== undefined) return;
    const container = gridRef.current;
    if (!container) return;
    const centeredTop = Math.max(0, getChannelTop(focusedChannelIdx) - (container.clientHeight - rowHeight) / 2);
    animateVerticalScroll(centeredTop, true);
  }, [focusedChannelIdx, rowHeight, scrollToChannelIdx, animateVerticalScroll, getChannelTop]);

  // Virtual scrolling: find visible range based on scroll position
  let virtualStart = 0;
  let virtualEnd = guideItems.length;
  if (guideItems.length > 0) {
    const viewTop = scrollTop - VIRTUAL_OVERSCAN_ROWS * rowHeight;
    const viewBottom = scrollTop + gridHeight + VIRTUAL_OVERSCAN_ROWS * rowHeight;
    virtualStart = Math.max(0, itemOffsets.offsets.findIndex(o => o + rowHeight > viewTop));
    virtualEnd = guideItems.length;
    for (let i = virtualStart; i < guideItems.length; i++) {
      if (itemOffsets.offsets[i] > viewBottom) { virtualEnd = i; break; }
    }
    // Ensure focused channel is included
    const focusedGuideIdx = guideItems.findIndex(g => g.kind === 'channel' && g.chIdx === focusedChannelIdx);
    if (focusedGuideIdx >= 0) {
      virtualStart = Math.min(virtualStart, focusedGuideIdx);
      virtualEnd = Math.max(virtualEnd, focusedGuideIdx + 1);
    }
  }

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
        <div className="guide-rows-virtualizer" style={{ height: itemOffsets.totalHeight }}>
          {guideItems.slice(virtualStart, virtualEnd).map((item, offset) => {
            const idx = virtualStart + offset;
            const top = itemOffsets.offsets[idx];

            if (item.kind === 'divider') {
              return (
                <div key={`div-${item.divider.id}`} className="guide-row-virtual-item" style={{ top }}>
                  <div className="guide-divider-row" style={{ height: rowHeight, minWidth: channelColWidth + totalSlotsWidth }}>
                    {item.divider.label && (
                      <span className="guide-divider-label" style={{ fontSize: channelNameFontSize }}>
                        {item.divider.label}
                      </span>
                    )}
                  </div>
                </div>
              );
            }

            const { channel, chIdx } = item;
            const allPrograms = scheduleByChannel.get(channel.id) || EMPTY_PROGRAMS;
            const { programs, startOffset } = getVisiblePrograms(allPrograms, rangeStartMs, rangeEndMs);
            return (
              <div key={channel.id} className="guide-row-virtual-item" style={{ top }}>
                <GuideRow
                  channel={channel}
                  chIdx={chIdx}
                  programs={programs}
                  rowHeight={rowHeight}
                  isFocusedRow={chIdx === focusedChannelIdx}
                  focusedProgramIdx={focusedProgramIdx}
                  airingKeys={airingKeys}
                  rangeStartMs={rangeStartMs}
                  rangeEndMs={rangeEndMs}
                  timeSlotWidth={timeSlotWidth}
                  totalSlotsWidth={totalSlotsWidth}
                  isMobile={isMobile}
                  showArtwork={showArtwork}
                  artworkThreshold={artworkThreshold}
                  artworkSize={artworkSize}
                  showRatings={showRatings}
                  showYear={showYear}
                  showResolution={showResolution}
                  showHdr={showHdr}
                  showIconicScenes={showIconicScenes}
                  nowMs={nowMs}
                  programTitleFontSize={programTitleFontSize}
                  guideColors={guideColors}
                  scrollLeft={scrollLeftRef.current}
                  channelNumFontSize={channelNumFontSize}
                  channelNameFontSize={channelNameFontSize}
                  channelColor={channelColorMap[channel.id]}
                  programStartOffset={startOffset}
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