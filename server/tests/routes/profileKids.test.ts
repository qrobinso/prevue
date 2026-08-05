import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import { channelRoutes } from '../../src/routes/channels.js';
import * as queries from '../../src/db/queries.js';

describe('kids rating ceiling on /api/channels', () => {
  let app: Express;
  let db: Database.Database;
  let kidsId: number;
  let adultId: number;

  beforeEach(() => {
    db = createTestDb();

    const insert = db.prepare(
      `INSERT INTO channels (number, name, type, sort_order) VALUES (?, ?, 'auto', ?)`
    );
    const kidsChannel = Number(insert.run(1, 'Cartoons', 0).lastInsertRowid);
    const adultChannel = Number(insert.run(2, 'Late Night', 1).lastInsertRowid);

    adultId = queries.createProfile(db, { name: 'Grown Up' }).id;
    kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const scheduleEngine = {
      getCurrentProgram: (channelId: number) => ({
        program:
          channelId === kidsChannel
            ? { type: 'episode', rating: 'TV-Y', title: 'Cartoon' }
            : { type: 'movie', rating: 'TV-MA', title: 'Slasher' },
        next: null,
      }),
    };

    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.scheduleEngine = scheduleEngine;
    app.use('/api', profileResolver);
    app.use('/api/channels', channelRoutes);
  });

  it('hides channels airing content above the ceiling', async () => {
    const res = await request(app).get('/api/channels').set('X-Profile-Id', String(kidsId));
    expect(res.status).toBe(200);
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Cartoons']);
  });

  it('leaves an unrestricted profile unaffected', async () => {
    const res = await request(app).get('/api/channels').set('X-Profile-Id', String(adultId));
    expect(res.body.map((c: { name: string }) => c.name)).toEqual(['Cartoons', 'Late Night']);
  });

  it('blocks content with no rating for a kids profile', async () => {
    db.prepare('UPDATE channels SET name = ? WHERE number = 1').run('Unrated');
    const res = await request(app).get('/api/channels').set('X-Profile-Id', String(kidsId));
    expect(res.body).toHaveLength(1);
  });
});
