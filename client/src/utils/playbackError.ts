/**
 * Format playback errors for user display.
 * Handles HLS.js error data and generic Error/string messages.
 */
export function formatPlaybackError(
  error: string | Error | { type?: string; details?: string; reason?: string }
): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;

  const data = error as { type?: string; details?: string; reason?: string };
  const type = data.type ?? '';
  const details = data.details ?? data.reason ?? '';

  if (type === 'networkError') {
    if (details.includes('manifest') || details === 'manifestLoadError') return 'Failed to load stream. Check your connection.';
    if (details.includes('level') || details === 'levelLoadError') return 'Failed to load video quality. Try again.';
    if (details.includes('fragment') || details === 'fragLoadError') return 'Connection interrupted. Buffering failed.';
    return 'Network error. Check your connection and try again.';
  }
  if (type === 'mediaError') {
    if (details.includes('buffer') || details === 'bufferAppendError') return 'Video format error. Try a different quality.';
    if (details.includes('codec') || details === 'bufferCodecError') return 'Video codec not supported.';
    return 'Playback error. Try again or change quality.';
  }
  if (type === 'muxError') return 'Stream format error. Try again.';
  if (type === 'keySystemError') return 'DRM or encryption error.';

  if (details) return details;
  if (type) return type;
  return 'Playback failed. Please try again.';
}
