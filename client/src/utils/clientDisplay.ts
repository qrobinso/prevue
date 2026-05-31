import { isIOS, isTablet } from './platform';

/** Parse User-Agent into a short browser label. */
export function parseUserAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('Chrome/') && !ua.includes('Edg/')) return 'Chrome';
  if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
  if (ua.includes('Mobile')) return 'Mobile Browser';
  return 'Browser';
}

/** Short platform label for metrics (iPhone, Android Tablet, TV, Desktop, etc.). */
export function getClientPlatform(): string {
  if (typeof navigator === 'undefined') return 'Unknown';
  const ua = navigator.userAgent;
  if (isIOS()) return isTablet() ? 'iPad' : 'iPhone';
  if (/Android/i.test(ua)) return isTablet() ? 'Android Tablet' : 'Android';
  if (/CrKey|Chromecast/i.test(ua)) return 'Chromecast';
  if (/Smart-TV|Tizen|Web0S|web0s|BRAVIA|AppleTV/i.test(ua)) return 'TV';
  return 'Desktop';
}

/** Human-friendly device label sent with metrics registration. */
export function getClientDisplayName(): string {
  if (typeof navigator === 'undefined') return 'Unknown Device';
  const browser = parseUserAgent(navigator.userAgent);
  const platform = getClientPlatform();
  if (platform === 'Desktop') return browser;
  return `${platform} · ${browser}`;
}

/** Truncate UUID for display (last 8 chars). */
export function formatClientIdShort(clientId: string): string {
  const compact = clientId.replace(/-/g, '');
  if (compact.length <= 8) return compact;
  return compact.slice(-8);
}
