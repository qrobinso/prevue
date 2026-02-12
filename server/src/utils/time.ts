/**
 * Time utilities for schedule block alignment
 */

const DEFAULT_BLOCK_HOURS = 8;

export function getBlockHours(): number {
  return parseInt(process.env.SCHEDULE_BLOCK_HOURS || '', 10) || DEFAULT_BLOCK_HOURS;
}

/**
 * Get the block boundary times (e.g., 00:00, 08:00, 16:00 for 8-hour blocks)
 * Uses LOCAL time for block boundaries so schedules align with user's timezone
 */
export function getBlockStart(date: Date): Date {
  const blockHours = getBlockHours();
  const d = new Date(date);
  // Use local hours for block boundaries (getHours returns local time)
  const hour = d.getHours();
  const blockIndex = Math.floor(hour / blockHours);
  d.setHours(blockIndex * blockHours, 0, 0, 0);
  return d;
}

export function getBlockEnd(blockStart: Date): Date {
  const blockHours = getBlockHours();
  const end = new Date(blockStart);
  end.setHours(end.getHours() + blockHours);
  return end;
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
