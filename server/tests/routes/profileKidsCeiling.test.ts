import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import { tickerRoutes } from '../../src/routes/ticker.js';
import { channelRoutes } from '../../src/routes/channels.js';
import * as queries from '../../src/db/queries.js';
import type { ScheduleProgram } from '../../src/types/index.js';

function makeProgram(overrides: Partial<ScheduleProgram> & { media_item_id: string; title: string; rating: string | null }): ScheduleProgram {
  const now = Date.now();
  return {
    media_item_id: overrides.media_item_id,
    title: overrides.title,
    subtitle: null,
    start_time: new Date(now - 5 * 60 * 1000).toISOString(),
    end_time: new Date(now + 55 * 60 * 1000).toISOString(),
    duration_ms: 60 * 60 * 1000,
    type: 'program',
    content_type: 'movie',
    thumbnail_url: null,
    banner_url: null,
    year: 2020,
    rating: overrides.rating,
    resolution: null,
    is_hdr: null,
    genres: [],
    description: null,
    ...overrides,
  };
}

describe('kids rating ceiling on /api/ticker', () => {
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

    const blockStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const blockEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    queries.upsertScheduleBlock(
      db,
      kidsChannel,
      blockStart,
      blockEnd,
      [makeProgram({ media_item_id: 'cartoon-1', title: 'Cartoon Show', rating: 'TV-Y' })],
      'seed-kids'
    );
    queries.upsertScheduleBlock(
      db,
      adultChannel,
      blockStart,
      blockEnd,
      [makeProgram({ media_item_id: 'slasher-1', title: 'Slasher Movie', rating: 'TV-MA' })],
      'seed-adult'
    );

    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.scheduleEngine = { getCurrentProgram: () => null };
    app.locals.mediaProvider = { getLibraryItems: () => [] };
    app.use('/api', profileResolver);
    app.use('/api/ticker', tickerRoutes);
    app.use('/api/channels', channelRoutes);
  });

  it('excludes blocked titles from a kids profile ticker', async () => {
    const res = await request(app).get('/api/ticker').set('X-Profile-Id', String(kidsId));
    expect(res.status).toBe(200);
    const text = res.body.items.map((i: { text: string }) => i.text).join(' | ');
    expect(text).toContain('Cartoon Show');
    expect(text).not.toContain('Slasher Movie');
  });

  it('leaves an unrestricted profile ticker unchanged', async () => {
    const res = await request(app).get('/api/ticker').set('X-Profile-Id', String(adultId));
    expect(res.status).toBe(200);
    const text = res.body.items.map((i: { text: string }) => i.text).join(' | ');
    expect(text).toContain('Cartoon Show');
    expect(text).toContain('Slasher Movie');
  });
});

describe('kids rating ceiling on /api/channels/recommend', () => {
  let app: Express;
  let db: Database.Database;
  let kidsId: number;
  let blockedChannel: number;
  let allowedChannel: number;

  beforeEach(() => {
    db = createTestDb();

    const insert = db.prepare(
      `INSERT INTO channels (number, name, type, sort_order) VALUES (?, ?, 'auto', ?)`
    );
    blockedChannel = Number(insert.run(1, 'Late Night', 0).lastInsertRowid);
    allowedChannel = Number(insert.run(2, 'Cartoons', 1).lastInsertRowid);

    kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const now = Date.now();
    const scheduleEngine = {
      getCurrentProgram: (channelId: number) => {
        if (channelId === blockedChannel) {
          return {
            program: makeProgram({
              media_item_id: 'slasher-1',
              title: 'Slasher Movie',
              rating: 'TV-MA',
              start_time: new Date(now - 5 * 60 * 1000).toISOString(),
              end_time: new Date(now + 55 * 60 * 1000).toISOString(),
            }),
            next: null,
          };
        }
        return {
          program: makeProgram({
            media_item_id: 'cartoon-1',
            title: 'Cartoon Show',
            rating: 'TV-Y',
            content_type: 'episode',
            start_time: new Date(now - 5 * 60 * 1000).toISOString(),
            end_time: new Date(now + 55 * 60 * 1000).toISOString(),
          }),
          next: null,
        };
      },
    };

    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.scheduleEngine = scheduleEngine;
    app.use('/api', profileResolver);
    app.use('/api/channels', channelRoutes);
  });

  it('never recommends a channel airing content above the ceiling', async () => {
    const res = await request(app).get('/api/channels/recommend').set('X-Profile-Id', String(kidsId));
    expect(res.status).toBe(200);
    expect(res.body.channel_number).not.toBe(1);
  });

  it('returns no recommendation when every channel is blocked', async () => {
    db.prepare('DELETE FROM channels WHERE number = 2').run();
    const res = await request(app).get('/api/channels/recommend').set('X-Profile-Id', String(kidsId));
    expect(res.status).toBe(200);
    expect(res.body.channel_number).toBeNull();
  });
});
