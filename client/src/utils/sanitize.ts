/**
 * Sanitize a URL for use in CSS backgroundImage or <img> src.
 * Only allows same-origin paths starting with /api/images/ and http(s) URLs.
 * Returns null for anything suspicious.
 */
export function sanitizeImageUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;

  // Same-origin API image proxy paths are always safe
  if (url.startsWith('/api/images/')) return url;

  // Allow absolute http(s) URLs (e.g. from Jellyfin)
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch {
    // invalid URL
  }

  return null;
}

/**
 * Build a safe CSS backgroundImage value. Returns empty string if URL is invalid.
 */
export function safeBgImage(url: string | null | undefined): string {
  const safe = sanitizeImageUrl(url);
  return safe ? `url(${safe})` : '';
}
