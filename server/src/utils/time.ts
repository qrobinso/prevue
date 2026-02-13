/**
 * Time utilities for schedule block alignment
 * Schedule "day" is 24 hours starting at 4am (cable-style reset).
 */

const DEFAULT_BLOCK_HOURS = 24;
/** Hour of day (0–23) when the schedule day starts; 4 = 4am. */
const DEFAULT_DAY_START_HOUR = 4;

export function getBlockHours(): number {
  return parseInt(process.env.SCHEDULE_BLOCK_HOURS || '', 10) || DEFAULT_BLOCK_HOURS;
}

export function getDayStartHour(): number {
  const parsed = parseInt(process.env.SCHEDULE_DAY_START_HOUR || '', 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 23) return DEFAULT_DAY_START_HOUR;
  return parsed;
}

/**
 * Get the start of the current 24-hour schedule block.
 * Blocks start at 4am (configurable) and run 24 hours, e.g. 4am–4am.
 * Uses local time so schedules align with the server's timezone.
 */
export function getBlockStart(date: Date): Date {
  const dayStartHour = getDayStartHour();
  const d = new Date(date);
  d.setHours(dayStartHour, 0, 0, 0);
  if (date.getTime() < d.getTime()) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

export function getBlockEnd(blockStart: Date): Date {
  const blockHours = getBlockHours();
  return new Date(blockStart.getTime() + blockHours * 60 * 60 * 1000);
}

export function getNextBlockStart(blockStart: Date): Date {
  return getBlockEnd(blockStart);
}

/**
 * Snap a time to the nearest 15-minute boundary
 */
export function snapTo15Min(date: Date): Date {
  const d = new Date(date);
  const minutes = d.getMinutes();
  const snapped = Math.round(minutes / 15) * 15;
  d.setMinutes(snapped, 0, 0);
  return d;
}

/**
 * Snap a time forward to the next 15-minute boundary
 */
export function snapForwardTo15Min(date: Date): Date {
  const d = new Date(date);
  const minutes = d.getMinutes();
  const snapped = Math.ceil(minutes / 15) * 15;
  d.setMinutes(snapped, 0, 0);
  return d;
}

/**
 * Convert Jellyfin RunTimeTicks (100ns units) to milliseconds
 */
export function ticksToMs(ticks: number): number {
  return Math.round(ticks / 10000);
}

/**
 * Convert milliseconds to Jellyfin ticks
 */
export function msToTicks(ms: number): number {
  return ms * 10000;
}

/**
 * Format duration in milliseconds to human-readable string
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
