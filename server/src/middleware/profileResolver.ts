import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type Database from 'better-sqlite3';
import * as queries from '../db/queries.js';
import type { ProfileParsed } from '../types/index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      activeProfile?: ProfileParsed;
    }
  }
}

/**
 * Resolve the caller's active profile.
 *
 * Order: X-Profile-Id header, then ?profile_id=, then the first profile by
 * sort_order. Returns undefined only when no profiles exist at all. This must
 * never throw — the app auto-tunes into video on launch and cannot block on
 * profile resolution.
 */
export function resolveProfile(
  req: Request,
  db: Database.Database
): ProfileParsed | undefined {
  const header = req.get('X-Profile-Id');
  const query = typeof req.query.profile_id === 'string' ? req.query.profile_id : undefined;
  const raw = header ?? query;

  if (raw !== undefined) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) {
      const profile = queries.getProfile(db, id);
      if (profile) return profile;
    }
  }

  return queries.getAllProfiles(db)[0];
}

export const profileResolver: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const { db } = req.app.locals;
    if (db) req.activeProfile = resolveProfile(req, db);
  } catch {
    // Resolution is best-effort; downstream handlers treat undefined as unrestricted.
  }
  next();
};
