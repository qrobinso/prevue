import type { Request, Response, NextFunction } from 'express';

const API_KEY = process.env.PREVUE_API_KEY;

/** Returns true when the PREVUE_API_KEY env var is set. */
export function isAuthEnabled(): boolean {
  return !!API_KEY && API_KEY.length > 0;
}

/** Returns the configured API key (for WebSocket auth checks). */
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
  if (req.path === '/health' || req.path === '/auth/status') {
    next();
    return;
  }

  const providedKey =
    (req.headers['x-api-key'] as string) ||
    (req.query.api_key as string);

  if (providedKey && providedKey === API_KEY) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized. Provide a valid API key via X-API-Key header.' });
}
