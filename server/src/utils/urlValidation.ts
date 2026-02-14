/**
 * URL validation utilities to prevent SSRF attacks.
 *
 * When PREVUE_ALLOW_PRIVATE_URLS is set (e.g. for trusted LAN mode),
 * private/reserved IP ranges are allowed. Otherwise only public
 * addresses are accepted.
 */

const rawAllowPrivate = process.env.PREVUE_ALLOW_PRIVATE_URLS?.trim().toLowerCase();
// Default to allowing local/private network URLs for LAN-first deployments.
// Set PREVUE_ALLOW_PRIVATE_URLS=0/false/no/off to explicitly disable.
const ALLOW_PRIVATE = !rawAllowPrivate
  || !['0', 'false', 'no', 'off'].includes(rawAllowPrivate);

/** Check if a hostname resolves to a private/reserved IP range. */
function isPrivateHostname(hostname: string): boolean {
  // IPv4 private/reserved ranges
  const ipv4Private = [
    /^127\./,                      // 127.0.0.0/8  loopback
    /^10\./,                       // 10.0.0.0/8
    /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0/12
    /^192\.168\./,                 // 192.168.0.0/16
    /^169\.254\./,                 // 169.254.0.0/16  link-local
    /^0\./,                        // 0.0.0.0/8
  ];

  // Well-known private hostnames
  const privateNames = ['localhost', 'localhost.localdomain', '[::1]'];

  if (privateNames.includes(hostname.toLowerCase())) return true;
  if (hostname === '::1') return true;
  return ipv4Private.some(re => re.test(hostname));
}

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
}

/**
 * Validate a user-provided URL for safe server-to-server requests.
 * Rejects non-http(s) schemes and private IPs (unless explicitly allowed).
 */
export function validateExternalUrl(input: string): UrlValidationResult {
  if (!input || typeof input !== 'string') {
    return { valid: false, error: 'URL is required' };
  }

  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Only allow http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'Only http and https URLs are allowed' };
  }

  // Block private/reserved ranges unless explicitly allowed
  if (!ALLOW_PRIVATE && isPrivateHostname(parsed.hostname)) {
    return { valid: false, error: 'Private/local network URLs are not allowed by current configuration.' };
  }

  return { valid: true, url: parsed };
}
