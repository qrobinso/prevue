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

describe('max_rating validation on POST/PUT /api/profiles', () => {
  let app: Express;

  beforeEach(() => {
    ({ app } = createProfileApp());
  });

  it('rejects an unknown rating code on create', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Kid', max_rating: 'NotAThing' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('NotAThing');
  });

  it('rejects an age-less rating code (NR) on create', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Kid', max_rating: 'NR' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid rating code on create', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Kid', max_rating: 'TV-Y7' });
    expect(res.status).toBe(201);
    expect(res.body.max_rating).toBe('TV-Y7');
  });

  it('accepts null (unrestricted) on create', async () => {
    const res = await request(app).post('/api/profiles').send({ name: 'Grown Up', max_rating: null });
    expect(res.status).toBe(201);
    expect(res.body.max_rating).toBeNull();
  });

  it('rejects an unknown rating code on update', async () => {
    const created = await request(app).post('/api/profiles').send({ name: 'Joey' });
    const res = await request(app)
      .put(`/api/profiles/${created.body.id}`)
      .send({ max_rating: 'NotAThing' });
    expect(res.status).toBe(400);
  });

  it('rejects an age-less rating code (Unrated) on update', async () => {
    const created = await request(app).post('/api/profiles').send({ name: 'Joey' });
    const res = await request(app)
      .put(`/api/profiles/${created.body.id}`)
      .send({ max_rating: 'Unrated' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid rating code on update', async () => {
    const created = await request(app).post('/api/profiles').send({ name: 'Joey' });
    const res = await request(app)
      .put(`/api/profiles/${created.body.id}`)
      .send({ max_rating: 'PG-13' });
    expect(res.status).toBe(200);
    expect(res.body.max_rating).toBe('PG-13');
  });

  it('accepts null on update to clear a ceiling', async () => {
    const created = await request(app).post('/api/profiles').send({ name: 'Joey', max_rating: 'PG' });
    const res = await request(app)
      .put(`/api/profiles/${created.body.id}`)
      .send({ max_rating: null });
    expect(res.status).toBe(200);
    expect(res.body.max_rating).toBeNull();
  });
});
