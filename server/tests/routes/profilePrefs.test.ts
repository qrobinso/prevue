import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileRoutes } from '../../src/routes/profiles.js';
import * as queries from '../../src/db/queries.js';

describe('profile prefs API', () => {
  let app: Express;
  let db: Database.Database;
  let profileId: number;

  beforeEach(() => {
    db = createTestDb();
    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api/profiles', profileRoutes);
    profileId = queries.createProfile(db, { name: 'Joey' }).id;
  });

  it('starts with empty prefs', async () => {
    const res = await request(app).get(`/api/profiles/${profileId}/prefs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('merges supplied keys and preserves omitted ones', async () => {
    await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send({ guide_hours: 2, color_theme: 'amber' });

    const res = await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send({ guide_hours: 4 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guide_hours: 4, color_theme: 'amber' });
  });

  it('passes unknown keys through without validation', async () => {
    const res = await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send({ some_future_pref: { nested: true } });
    expect(res.body.some_future_pref).toEqual({ nested: true });
  });

  it('persists prefs across requests', async () => {
    await request(app).put(`/api/profiles/${profileId}/prefs`).send({ ticker: false });
    const res = await request(app).get(`/api/profiles/${profileId}/prefs`);
    expect(res.body).toEqual({ ticker: false });
  });

  it('keeps prefs isolated between profiles', async () => {
    const other = queries.createProfile(db, { name: 'Other' }).id;
    await request(app).put(`/api/profiles/${profileId}/prefs`).send({ guide_hours: 3 });
    const res = await request(app).get(`/api/profiles/${other}/prefs`);
    expect(res.body).toEqual({});
  });

  it('tolerates a malformed stored blob', async () => {
    db.prepare('UPDATE profiles SET prefs = ? WHERE id = ?').run('{{{', profileId);
    const res = await request(app).get(`/api/profiles/${profileId}/prefs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it('rejects a non-object patch body', async () => {
    const res = await request(app)
      .put(`/api/profiles/${profileId}/prefs`)
      .send(['not', 'an', 'object']);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a missing profile', async () => {
    const res = await request(app).get('/api/profiles/999/prefs');
    expect(res.status).toBe(404);
  });
});
