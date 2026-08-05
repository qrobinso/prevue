import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';

export const profileRoutes = Router();

/** Parse an :id path param, returning null when it is not a positive integer. */
function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
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
