import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import { getRatingMinAge } from '../utils/ratingCeiling.js';

export const profileRoutes = Router();

/** Parse an :id path param, returning null when it is not a positive integer. */
function parseId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * A ceiling must be a recognized rating code with a defined minimum age.
 * A code like "NR" (no minAge) would make isRatingWithinCeiling reject
 * everything, silently producing an empty guide with no error. `null` (no
 * ceiling / unrestricted) is always valid and bypasses this check.
 */
function isValidCeiling(maxRating: string): boolean {
  return getRatingMinAge(maxRating) !== null;
}

// GET /api/profiles - List all profiles
profileRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    res.json(queries.getAllProfiles(db));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/profiles - Create a profile
profileRoutes.post('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const { name, avatar_glyph, avatar_color, is_kids, max_rating } = req.body;

    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (typeof max_rating === 'string' && !isValidCeiling(max_rating)) {
      res.status(400).json({ error: `Unknown or age-less rating code: ${max_rating}` });
      return;
    }

    const profile = queries.createProfile(db, {
      name: name.trim(),
      avatar_glyph: typeof avatar_glyph === 'string' ? avatar_glyph : undefined,
      avatar_color: typeof avatar_color === 'string' ? avatar_color : undefined,
      is_kids: is_kids === true,
      max_rating: typeof max_rating === 'string' ? max_rating : null,
    });

    res.status(201).json(profile);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/profiles/:id - Update a profile
profileRoutes.put('/:id', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    const { name, avatar_glyph, avatar_color, is_kids, max_rating } = req.body;
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '')) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }

    if (typeof max_rating === 'string' && !isValidCeiling(max_rating)) {
      res.status(400).json({ error: `Unknown or age-less rating code: ${max_rating}` });
      return;
    }

    const updated = queries.updateProfile(db, id, {
      name: typeof name === 'string' ? name.trim() : undefined,
      avatar_glyph: typeof avatar_glyph === 'string' ? avatar_glyph : undefined,
      avatar_color: typeof avatar_color === 'string' ? avatar_color : undefined,
      is_kids: typeof is_kids === 'boolean' ? is_kids : undefined,
      max_rating:
        max_rating === undefined ? undefined : typeof max_rating === 'string' ? max_rating : null,
    });

    if (!updated) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/profiles/:id - Delete a profile (never the last one)
profileRoutes.delete('/:id', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    if (!queries.getProfile(db, id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    if (queries.countProfiles(db) <= 1) {
      res.status(400).json({ error: 'Cannot delete the last profile' });
      return;
    }

    queries.deleteProfile(db, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/profiles/:id/prefs - Read a profile's preference blob
profileRoutes.get('/:id/prefs', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    const prefs = queries.getProfilePrefs(db, id);
    if (prefs === undefined) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/profiles/:id/prefs - Merge-patch a profile's preference blob
profileRoutes.put('/:id/prefs', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }

    const patch: unknown = req.body;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      res.status(400).json({ error: 'Request body must be an object' });
      return;
    }

    const merged = queries.patchProfilePrefs(db, id, patch as Record<string, unknown>);
    if (merged === undefined) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/profiles/:id/lineup - Read a profile's channel lineup overrides
profileRoutes.get('/:id/lineup', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }
    if (!queries.getProfile(db, id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    res.json(queries.getProfileLineup(db, id));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/profiles/:id/lineup - Replace a profile's channel lineup overrides
profileRoutes.put('/:id/lineup', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: 'Invalid profile id' });
      return;
    }
    if (!queries.getProfile(db, id)) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const body: unknown = req.body;
    if (!Array.isArray(body)) {
      res.status(400).json({ error: 'Request body must be an array of lineup entries' });
      return;
    }

    const entries: queries.LineupOverride[] = [];
    for (const raw of body) {
      if (!raw || typeof raw !== 'object') {
        res.status(400).json({ error: 'Each lineup entry must be an object' });
        return;
      }
      const entry = raw as { channel_id?: unknown; hidden?: unknown; sort_order?: unknown };
      if (!Number.isInteger(entry.channel_id)) {
        res.status(400).json({ error: 'Each lineup entry needs an integer channel_id' });
        return;
      }
      entries.push({
        channel_id: entry.channel_id as number,
        hidden: entry.hidden === true,
        sort_order: Number.isInteger(entry.sort_order) ? (entry.sort_order as number) : null,
      });
    }

    res.json(queries.setProfileLineup(db, id, entries));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
