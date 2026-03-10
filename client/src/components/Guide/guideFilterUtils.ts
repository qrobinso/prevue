import type { ScheduleProgram } from '../../types';
import type { ChannelWithProgram } from '../../services/api';
import { getIconicScenesEnabled } from '../Settings/GeneralSettings';

export type GuideFilterId =
  | 'movies'
  | 'tv-shows'
  | 'recently-started'
  | 'starting-soon'
  | 'hd-4k'
  | 'kids-family'
  | 'action'
  | 'comedy'
  | 'drama'
  | 'sci-fi'
  | 'almost-done'
  | 'near-ending'
  | 'iconic-scene';

export interface GuideFilterPreset {
  id: GuideFilterId;
  label: string;
}

const STORAGE_KEY = 'prevue_guide_filter';
const EVENT_NAME = 'guidefilterchange';

const FIFTEEN_MIN = 15 * 60 * 1000;

const KIDS_RATINGS = new Set(['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG']);

const ICONIC_EARLY_START = 1; // Show 1 minute before scene starts

const BASE_FILTER_PRESETS: GuideFilterPreset[] = [
  { id: 'movies', label: 'Movies On Now' },
  { id: 'tv-shows', label: 'TV Shows On Now' },
  { id: 'recently-started', label: 'Recently Started' },
  { id: 'starting-soon', label: 'Starting Soon' },
  { id: 'hd-4k', label: 'HD & 4K' },
  { id: 'kids-family', label: 'Kids & Family' },
  { id: 'action', label: 'Action & Adventure' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'drama', label: 'Drama' },
  { id: 'almost-done', label: 'Almost Done' },
  { id: 'near-ending', label: 'Near the Ending' },
  { id: 'sci-fi', label: 'Sci-Fi & Fantasy' },
];

/** Returns available filter presets, conditionally including AI filters. */
export function getAvailableFilters(): GuideFilterPreset[] {
  const filters = [...BASE_FILTER_PRESETS];
  if (getIconicScenesEnabled()) {
    filters.push({ id: 'iconic-scene', label: 'Iconic Scene Now' });
  }
  return filters;
}

// Keep a static reference for backwards compatibility (non-AI filters)
export const GUIDE_FILTER_PRESETS = BASE_FILTER_PRESETS;

/** Check if a program is currently playing an iconic scene. */
export function isIconicSceneActive(program: ScheduleProgram, nowMs: number): boolean {
  if (program.content_type !== 'movie' || !program.iconic_scenes?.length) return false;
  const startMs = program.start_ms ?? new Date(program.start_time).getTime();
  const elapsedMinutes = (nowMs - startMs) / 60000;
  return program.iconic_scenes.some(scene => {
    const effectiveEnd = scene.end_minutes ?? scene.timestamp_minutes + 3; // fallback for legacy data
    return elapsedMinutes >= scene.timestamp_minutes - ICONIC_EARLY_START && elapsedMinutes <= effectiveEnd;
  });
}

export function getGuideFilters(): GuideFilterId[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed]; // migrate single-value format
  } catch {
    return raw ? [raw as GuideFilterId] : []; // migrate single-value format
  }
}

export function setGuideFilters(filterIds: GuideFilterId[]): void {
  if (filterIds.length > 0) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filterIds));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { filterIds } }));
}

function findCurrentProgram(programs: ScheduleProgram[], now: number): ScheduleProgram | null {
  for (const p of programs) {
    const start = p.start_ms ?? new Date(p.start_time).getTime();
    const end = p.end_ms ?? new Date(p.end_time).getTime();
    if (now >= start && now < end && p.type === 'program') return p;
  }
  return null;
}

function matchesGenre(program: ScheduleProgram, ...keywords: string[]): boolean {
  const genres = program.genres;
  if (!genres) return false;
  return genres.some(g => {
    const lower = g.toLowerCase();
    return keywords.some(k => lower.includes(k));
  });
}

function evaluateFilter(
  filterId: GuideFilterId,
  currentProgram: ScheduleProgram | null,
  schedule: ScheduleProgram[] | null,
  now: number,
): boolean {
  if (!currentProgram) return false;

  switch (filterId) {
    case 'movies':
      return currentProgram.content_type === 'movie';
    case 'tv-shows':
      return currentProgram.content_type === 'episode';
    case 'recently-started': {
      if (currentProgram.type !== 'program') return false;
      const start = currentProgram.start_ms ?? new Date(currentProgram.start_time).getTime();
      return now - start < FIFTEEN_MIN;
    }
    case 'starting-soon': {
      if (schedule) {
        return schedule.some(p => {
          if (p.type !== 'program') return false;
          const start = p.start_ms ?? new Date(p.start_time).getTime();
          return start > now && start - now < FIFTEEN_MIN;
        });
      }
      return false;
    }
    case 'hd-4k': {
      const res = currentProgram.resolution;
      if (!res) return false;
      const lower = res.toLowerCase();
      return lower.includes('1080') || lower.includes('4k') || lower.includes('2160');
    }
    case 'kids-family':
      return currentProgram.rating != null && KIDS_RATINGS.has(currentProgram.rating);
    case 'action':
      return matchesGenre(currentProgram, 'action', 'adventure');
    case 'comedy':
      return matchesGenre(currentProgram, 'comedy');
    case 'drama':
      return matchesGenre(currentProgram, 'drama');
    case 'almost-done': {
      if (currentProgram.type !== 'program') return false;
      const end = currentProgram.end_ms ?? new Date(currentProgram.end_time).getTime();
      return end > now && end - now < FIFTEEN_MIN;
    }
    case 'near-ending': {
      if (currentProgram.type !== 'program') return false;
      const end = currentProgram.end_ms ?? new Date(currentProgram.end_time).getTime();
      return end > now && end - now < 5 * 60 * 1000;
    }
    case 'sci-fi':
      return matchesGenre(currentProgram, 'sci-fi', 'science fiction', 'fantasy');
    case 'iconic-scene':
      return isIconicSceneActive(currentProgram, now);
    default:
      return true;
  }
}

/** Filter channels using full schedule data (for Guide). Channel must match ALL active filters.
 *  If `pinnedChannelId` is provided, that channel is always included regardless of filters,
 *  so the user's explicitly-selected channel doesn't disappear mid-viewing. */
export function applyGuideFilter(
  channels: ChannelWithProgram[],
  scheduleByChannel: Map<number, ScheduleProgram[]>,
  filterIds: GuideFilterId[],
  pinnedChannelId?: number | null,
): ChannelWithProgram[] {
  if (filterIds.length === 0) return channels;
  const now = Date.now();
  return channels.filter(ch => {
    if (pinnedChannelId != null && ch.id === pinnedChannelId) return true;
    const schedule = scheduleByChannel.get(ch.id) ?? [];
    const current = findCurrentProgram(schedule, now) ?? ch.current_program;
    return filterIds.every(id => evaluateFilter(id, current, schedule, now));
  });
}

/** Filter channels using only current_program/next_program (for App.tsx player nav).
 *  If `pinnedChannelId` is provided, that channel is always included. */
export function applyGuideFilterSimple(
  channels: ChannelWithProgram[],
  filterIds: GuideFilterId[],
  pinnedChannelId?: number | null,
): ChannelWithProgram[] {
  if (filterIds.length === 0) return channels;
  const now = Date.now();
  return channels.filter(ch => {
    if (pinnedChannelId != null && ch.id === pinnedChannelId) return true;
    return filterIds.every(filterId => {
      // For "starting-soon", check next_program since we don't have the full schedule
      if (filterId === 'starting-soon') {
        if (ch.next_program) {
          const start = new Date(ch.next_program.start_time).getTime();
          if (start > now && start - now < FIFTEEN_MIN) return true;
        }
        return false;
      }
      return evaluateFilter(filterId, ch.current_program, null, now);
    });
  });
}

/** Count how many channels match each filter (for dropdown display) */
export function countFilterMatches(
  channels: ChannelWithProgram[],
  scheduleByChannel: Map<number, ScheduleProgram[]>,
): Record<GuideFilterId, number> {
  const counts = {} as Record<GuideFilterId, number>;
  const now = Date.now();
  for (const preset of getAvailableFilters()) {
    counts[preset.id] = channels.filter(ch => {
      const schedule = scheduleByChannel.get(ch.id) ?? [];
      const current = findCurrentProgram(schedule, now) ?? ch.current_program;
      return evaluateFilter(preset.id, current, schedule, now);
    }).length;
  }
  return counts;
}
