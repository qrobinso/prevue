import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';

export const settingsRoutes = Router();

// GET /api/settings - Get all settings
settingsRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const settings = queries.getAllSettings(db);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings - Update settings
settingsRoutes.put('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const updates = req.body;

    if (typeof updates !== 'object' || updates === null) {
      res.status(400).json({ error: 'Request body must be an object' });
      return;
    }

    for (const [key, value] of Object.entries(updates)) {
      queries.setSetting(db, key, value);
    }

    const settings = queries.getAllSettings(db);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/settings/:key - Get a specific setting
settingsRoutes.get('/:key', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const value = queries.getSetting(db, req.params.key as string);
    if (value === undefined) {
      res.status(404).json({ error: 'Setting not found' });
      return;
    }
    res.json({ key: req.params.key, value });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/settings/factory-reset - Reset all data to factory defaults
settingsRoutes.post('/factory-reset', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    queries.factoryReset(db);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
