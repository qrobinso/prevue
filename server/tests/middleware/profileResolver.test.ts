import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import * as queries from '../../src/db/queries.js';

function createApp(db: Database.Database): Express {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use(profileResolver);
  app.get('/probe', (req, res) => {
    res.json({ id: req.activeProfile?.id ?? null, name: req.activeProfile?.name ?? null });
  });
  return app;
}

describe('profileResolver', () => {
  let db: Database.Database;
  let app: Express;
  let first: number;
  let second: number;

  beforeEach(() => {
    db = createTestDb();
    first = queries.createProfile(db, { name: 'First' }).id;
    second = queries.createProfile(db, { name: 'Second' }).id;
    app = createApp(db);
  });

  it('resolves the profile named by the X-Profile-Id header', async () => {
    const res = await request(app).get('/probe').set('X-Profile-Id', String(second));
    expect(res.body.id).toBe(second);
  });

  it('falls back to the first profile when the header is absent', async () => {
    const res = await request(app).get('/probe');
    expect(res.body.id).toBe(first);
  });

  it('falls back to the first profile when the header is malformed', async () => {
    const res = await request(app).get('/probe').set('X-Profile-Id', 'not-a-number');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first);
  });

  it('falls back to the first profile when the id refers to a deleted profile', async () => {
    queries.deleteProfile(db, second);
    const res = await request(app).get('/probe').set('X-Profile-Id', String(second));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first);
  });

  it('accepts a profile_id query param', async () => {
    const res = await request(app).get(`/probe?profile_id=${second}`);
    expect(res.body.id).toBe(second);
  });

  it('prefers the header over the query param', async () => {
    const res = await request(app).get(`/probe?profile_id=${first}`).set('X-Profile-Id', String(second));
    expect(res.body.id).toBe(second);
  });

  it('leaves activeProfile undefined when no profiles exist, without erroring', async () => {
    queries.deleteProfile(db, first);
    queries.deleteProfile(db, second);
    const res = await request(app).get('/probe');
    expect(res.status).toBe(200);
    expect(res.body.id).toBeNull();
  });
});
