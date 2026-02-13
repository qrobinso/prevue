/**
 * Fullscreen utility with iOS Safari support (iPad, iPhone).
 * - Tries standard + webkit-prefixed Fullscreen API
 * - On Player: when container fails, tries video.webkitEnterFullscreen() for native iOS video fullscreen
 * - Falls back to CSS-based "fake" fullscreen when APIs fail
 */

import { isIOS } from './platform';

type DocWithFullscreen = Document & {
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  msFullscreenElement?: Element | null;
};

type ElWithFullscreen = HTMLElement & {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: (options?: FullscreenOptions) => void;
  webkitRequestFullScreen?: (options?: FullscreenOptions) => void;
  msRequestFullscreen?: () => void;
};

type VideoWithFullscreen = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitEnterFullScreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitExitFullScreen?: () => void;
};

export type FullscreenMode = 'native' | 'fake' | 'video';

export function getFullscreenElement(): Element | null {
  const doc = document as DocWithFullscreen;
  return (
    doc.fullscreenElement ??
    doc.webkitFullscreenElement ??
    doc.msFullscreenElement ??
    null
  );
}

export function isFullscreenElement(el: Element | null): boolean {
  if (!el) return false;
  return getFullscreenElement() === el;
}

/**
 * Attempt to enter fullscreen. Returns 'native' if the Fullscreen API succeeded,
 * 'video' if video.webkitEnterFullscreen succeeded (iOS), 'fake' if both failed.
 */
export async function enterFullscreen(
  el: HTMLElement,
  options?: { video?: HTMLVideoElement | null }
): Promise<FullscreenMode> {
  // 1. Try container fullscreen (standard + webkit for iPad Safari 16.4+)
  const req =
    (el as ElWithFullscreen).requestFullscreen ??
    (el as ElWithFullscreen).webkitRequestFullscreen ??
    (el as ElWithFullscreen).webkitRequestFullScreen ??
    (el as ElWithFullscreen).msRequestFullscreen;

  if (req) {
    try {
      const result = req.call(el);
      if (result && typeof (result as Promise<void>).then === 'function') {
        await (result as Promise<void>);
      }
      return 'native';
    } catch {
      /* API failed, try video fullscreen on iOS or fall through to fake */
    }
  }

  // 2. On iOS, try video.webkitEnterFullscreen for native video fullscreen (Player only)
  const video = options?.video;
  if (isIOS() && video) {
    const videoReq =
      (video as VideoWithFullscreen).webkitEnterFullscreen ??
      (video as VideoWithFullscreen).webkitEnterFullScreen;
    if (videoReq) {
      try {
        videoReq.call(video);
        return 'video';
      } catch {
        /* Fall through to fake */
      }
    }
  }

  return 'fake';
}

/**
 * Exit fullscreen. Pass the mode returned from enterFullscreen.
 * For 'fake' mode, caller must remove the fake-fullscreen class.
 */
export function exitFullscreen(
  mode: FullscreenMode,
  options?: { video?: HTMLVideoElement | null }
): void {
  if (mode === 'native') {
    const doc = document as DocWithFullscreen;
    if (doc.exitFullscreen) doc.exitFullscreen();
    else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
  } else if (mode === 'video' && options?.video) {
    const v = options.video as VideoWithFullscreen;
    if (v.webkitExitFullscreen) v.webkitExitFullscreen();
    else if (v.webkitExitFullScreen) v.webkitExitFullScreen();
  }
}
