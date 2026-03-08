import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

const API_KEY = process.env.PREVUE_API_KEY;

/** Returns true when the PREVUE_API_KEY env var is set. */
export function isAuthEnabled(): boolean {
  return !!API_KEY && API_KEY.length > 0;
}

/** Timing-safe comparison to prevent timing attacks on secret values. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Pad to equal length so timingSafeEqual doesn't throw, avoiding a length oracle
  const maxLen = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  return bufA.length === bufB.length && timingSafeEqual(paddedA, paddedB);
}

/** Validate a provided key against the configured API key (constant-time). */
export function validateApiKey(provided: string): boolean {
  if (!API_KEY) return false;
  return safeCompare(provided, API_KEY);
}

/** Returns the configured API key (for IPTV token embedding in URLs). */
export function getApiKey(): string | undefined {
  return API_KEY;
}

/**
 * Express middleware that gates /api/* routes behind an API key
 * when PREVUE_API_KEY is configured. Static file serving and
 * the public /auth/status endpoint are exempt.
 *
 * Mount on the /api path: `app.use('/api', authMiddleware)`
 * so req.path is relative to /api.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) {
    next();
    return;
  }

  // Public endpoints that never require auth
  // IPTV endpoints handle their own token-based auth internally
  // Assets (background music, etc.) are public static files
  if (req.path === '/health' || req.path === '/auth/status' || req.path.startsWith('/docs') || req.path.startsWith('/iptv/') || req.path.startsWith('/assets/')) {
    next();
    return;
  }

  const providedKey =
    (req.headers['x-api-key'] as string) ||
    (req.query.api_key as string) ||
    (req.query.token as string);

  if (providedKey && validateApiKey(providedKey)) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized. Provide a valid API key via X-API-Key header.' });
}
