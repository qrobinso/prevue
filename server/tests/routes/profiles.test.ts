import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileRoutes } from '../../src/routes/profiles.js';

function createProfileApp(): { app: Express; db: Database.Database } {
  const db = createTestDb();
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/profiles', profileRoutes);
  return { app, db };
}

describe('profiles API', () => {
  let app: Express;

  beforeEach(() => {
    ({ app } = createProfileApp());
  });

  it('returns an empty list initially', async () => {
    const res = await request(app).get('/api/profiles');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('creates a profile', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Joey' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Joey');
    expect(res.body.is_kids).toBe(false);
  });

  it('rejects a profile with no name', async () => {
    const res = await request(app).post('/api/profiles').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  it('rejects a blank name', async () => {
    const res = await request(app).post('/api/profiles').send({ name: '   ' });
    expect(res.status).toBe(400);
  });

  it('updates a profile', async () => {
    const created = await request(app).post('/api/profiles').send({ name: 'Joey' });
    const res = await request(app)
      .put(`/api/profiles/${created.body.id}`)
      .send({ name: 'Joseph', is_kids: true, max_rating: 'TV-Y7' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Joseph');
    expect(res.body.is_kids).toBe(true);
    expect(res.body.max_rating).toBe('TV-Y7');
  });

  it('returns 404 when updating a missing profile', async () => {
    const res = await request(app).put('/api/profiles/999').send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('deletes a profile when others remain', async () => {
    await request(app).post('/api/profiles').send({ name: 'Keep' });
    const doomed = await request(app).post('/api/profiles').send({ name: 'Doomed' });
    const res = await request(app).delete(`/api/profiles/${doomed.body.id}`);
    expect(res.status).toBe(200);

    const list = await request(app).get('/api/profiles');
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(['Keep']);
  });

  it('refuses to delete the last profile', async () => {
    const only = await request(app).post('/api/profiles').send({ name: 'Only' });
    const res = await request(app).delete(`/api/profiles/${only.body.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('last');

    const list = await request(app).get('/api/profiles');
    expect(list.body).toHaveLength(1);
  });

  it('returns 404 when deleting a missing profile', async () => {
    await request(app).post('/api/profiles').send({ name: 'A' });
    await request(app).post('/api/profiles').send({ name: 'B' });
    const res = await request(app).delete('/api/profiles/999');
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id', async () => {
    const res = await request(app).put('/api/profiles/abc').send({ name: 'X' });
    expect(res.status).toBe(400);
  });
});
