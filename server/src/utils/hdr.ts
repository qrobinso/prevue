/**
 * Shared HDR detection utilities.
 *
 * Uses Jellyfin SDK enums for precise comparisons where possible,
 * with fallback string matching for Plex and non-standard metadata.
 */
import { VideoRange, VideoRangeType } from '@jellyfin/sdk/lib/generated-client/models/index.js';

// All VideoRangeType values that indicate HDR (anything that isn't Unknown or SDR).
const HDR_RANGE_TYPES = new Set<string>([
  VideoRangeType.Hdr10,
  VideoRangeType.Hlg,
  VideoRangeType.Dovi,
  VideoRangeType.DoviWithHdr10,
  VideoRangeType.DoviWithHlg,
  VideoRangeType.DoviWithSdr,
  VideoRangeType.DoviWithEl,
  VideoRangeType.DoviWithHdr10Plus,
  VideoRangeType.DoviWithElhdr10Plus,
  VideoRangeType.Hdr10Plus,
]);

// Fallback keywords for string-based detection (Plex, display titles, etc.).
const HDR_KEYWORDS = ['hdr', 'hlg', 'pq', 'smpte2084', 'bt2020', 'dovi', 'dolby vision', 'hdr10', 'hdr10+'];

// Transfer functions that indicate HDR.
const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67'];

/**
 * Detect whether a single video stream carries HDR content.
 * Accepts a loosely-typed record to support both Jellyfin and Plex stream shapes.
 */
export function isHdrStream(stream: Record<string, unknown>): boolean {
  // Skip non-video streams.
  if (String(stream.Type ?? '').toLowerCase() !== 'video') return false;

  // 1. SDK-typed enum check (Jellyfin).
  if (stream.VideoRange === VideoRange.Hdr) return true;
  if (typeof stream.VideoRangeType === 'string' && HDR_RANGE_TYPES.has(stream.VideoRangeType)) return true;

  // 2. Boolean flags (Jellyfin server may set these on some versions).
  if (stream.IsHdr === true || stream.IsDolbyVision === true) return true;

  // 3. Plex-specific fields.
  if (stream.DOVIPresent === true) return true;

  // 4. Bit-depth + color signal analysis.
  const bitDepth = Number(stream.BitDepth ?? 0);
  const transfer = String(stream.ColorTransfer ?? stream.ColorTrc ?? '').toLowerCase();
  const primaries = String(stream.ColorPrimaries ?? '').toLowerCase();

  if (bitDepth >= 10 && (HDR_TRANSFERS.some(t => transfer.includes(t)) || primaries.includes('bt2020'))) {
    return true;
  }

  // 5. Fallback: keyword search on metadata string fields.
  const combined = [
    stream.VideoRange,
    stream.VideoRangeType,
    stream.ColorTransfer,
    stream.ColorTrc,
    stream.ColorPrimaries,
    stream.DisplayTitle,
  ]
    .map(v => String(v ?? '').toLowerCase())
    .join(' ');

  return HDR_KEYWORDS.some(kw => combined.includes(kw));
}

/**
 * Detect HDR across all MediaSources/MediaStreams on a media source object.
 * Works with Jellyfin MediaSourceInfo, Plex media items, or any shape
 * that carries a `MediaStreams` array.
 */
export function isHdrMediaSource(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  const src = source as Record<string, unknown>;

  // Check source-level metadata (some Jellyfin versions surface these at the source level).
  const sourceMeta = [
    src.VideoRange,
    src.VideoRangeType,
    src.ColorTransfer,
    src.ColorPrimaries,
    src.VideoDynamicRange,
    src.VideoDynamicRangeType,
    src.HdrType,
    src.VideoProfile,
    src.CodecTag,
    src.DisplayTitle,
    src.Name,
  ]
    .map(v => String(v ?? '').toLowerCase())
    .join(' ');

  if (HDR_KEYWORDS.some(kw => sourceMeta.includes(kw))) return true;

  // Check individual streams.
  const streams = Array.isArray(src.MediaStreams) ? src.MediaStreams : [];
  return streams.some(s => isHdrStream(s as Record<string, unknown>));
}

/**
 * Detect HDR across a MediaItem that has a `MediaSources` array.
 * Used by ScheduleEngine for both Jellyfin and Plex items.
 */
export function getHdrFlag(item: { MediaSources?: unknown[] }): boolean {
  if (!Array.isArray(item.MediaSources) || item.MediaSources.length === 0) return false;
  return item.MediaSources.some(source => isHdrMediaSource(source));
}
