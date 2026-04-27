/**
 * Shared Video Element Singleton
 *
 * Owns a single <video> DOM element and tracks the current HLS.js instance.
 * Both PreviewPanel and Player reparent this video into their containers
 * so transitions between guide and fullscreen reuse the same stream —
 * no re-buffering, no TUNING screen.
 */
import type Hls from 'hls.js';

// Module-level singleton state
let videoEl: HTMLVideoElement | null = null;
let hlsInstance: Hls | null = null;
let currentItemId: string | null = null;
let currentOwner: 'guide' | 'player' | null = null;
// Most recently completed item — guards against the same item being marked
// played twice if the video happens to fire 'ended' more than once (HLS quirks,
// user replay, etc.).
let lastCompletedItemId: string | null = null;

export function getVideoElement(): HTMLVideoElement {
  if (!videoEl) {
    videoEl = document.createElement('video');
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    // Tell the media server this item finished. Plex/Jellyfin's progress
    // endpoints alone don't reliably increment Played/viewCount on natural
    // end-of-video, so the "Unwatched only" filter needs this signal to update.
    videoEl.addEventListener('ended', () => {
      const itemId = currentItemId;
      if (!itemId || itemId === lastCompletedItemId) return;
      lastCompletedItemId = itemId;
      fetch('/api/stream/completed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
        keepalive: true, // survives navigation away from the page
      }).catch(() => {});
    });
  }
  return videoEl;
}

export function reparentVideo(container: HTMLElement): void {
  const video = getVideoElement();
  if (video.parentElement !== container) {
    container.appendChild(video);
  }
}

export function getSharedHls(): Hls | null {
  return hlsInstance;
}

export function setSharedHls(hls: Hls | null): void {
  hlsInstance = hls;
}

export function getSharedItemId(): string | null {
  return currentItemId;
}

export function setSharedItemId(id: string | null): void {
  // When the item changes, allow the new item to be marked completed when it ends.
  if (id !== currentItemId) lastCompletedItemId = null;
  currentItemId = id;
}

export function getSharedOwner(): 'guide' | 'player' | null {
  return currentOwner;
}

export function setSharedOwner(owner: 'guide' | 'player' | null): void {
  currentOwner = owner;
}

export function isStreamActive(itemId?: string | null): boolean {
  if (hlsInstance === null || (hlsInstance as unknown as { destroyed?: boolean }).destroyed) {
    return false;
  }
  // If itemId is provided, check it matches; otherwise just check HLS is alive
  if (itemId != null) {
    return currentItemId === itemId;
  }
  return true;
}

/**
 * Reconfigure HLS buffer limits at runtime without destroying the instance.
 * Used when transitioning from preview (small buffers) to player (large buffers).
 */
export function reconfigureBuffers(maxBufferLength: number, maxMaxBufferLength: number): void {
  if (!hlsInstance) return;
  hlsInstance.config.maxBufferLength = maxBufferLength;
  hlsInstance.config.maxMaxBufferLength = maxMaxBufferLength;
}

export function destroySharedStream(): void {
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch { /* already destroyed */ }
  }
  hlsInstance = null;
  currentItemId = null;
  currentOwner = null;
  const video = getVideoElement();
  video.removeAttribute('src');
  video.load();
}
