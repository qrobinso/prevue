/** Detect iOS (Safari on iPhone/iPad) */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** Detect iOS running as installed PWA (standalone). Use CSS fullscreen instead of Fullscreen API to avoid toolbar. */
export function isIOSPWA(): boolean {
  if (typeof window === 'undefined') return false;
  if (!isIOS()) return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
