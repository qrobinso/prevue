import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import { scheduleRoutes } from '../../src/routes/schedule.js';
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

describe('GET /api/schedule — lineup and rating ceiling', () => {
  let app: Express;
  let db: Database.Database;
  let kidsChannel: number;
  let adultChannel: number;
  let kidsId: number;
  let adultId: number;

  beforeEach(() => {
    db = createTestDb();

    const insert = db.prepare(
      `INSERT INTO channels (number, name, type, sort_order) VALUES (?, ?, 'auto', ?)`
    );
    kidsChannel = Number(insert.run(1, 'Cartoons', 0).lastInsertRowid);
    adultChannel = Number(insert.run(2, 'Late Night', 1).lastInsertRowid);

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

    const scheduleEngine = {
      getCurrentProgram: (channelId: number) => {
        if (channelId === adultChannel) {
          return {
            program: makeProgram({ media_item_id: 'slasher-1', title: 'Slasher Movie', rating: 'TV-MA' }),
            next: null,
          };
        }
        return {
          program: makeProgram({ media_item_id: 'cartoon-1', title: 'Cartoon Show', rating: 'TV-Y' }),
          next: null,
        };
      },
    };

    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.locals.scheduleEngine = scheduleEngine;
    app.use('/api', profileResolver);
    app.use('/api/schedule', scheduleRoutes);
  });

  it('applies a profile lineup override (hidden channel dropped from the schedule)', async () => {
    // Set lineup via the query layer directly (the route under test is /api/schedule,
    // not /api/profiles/:id/lineup, which is exercised separately).
    queries.setProfileLineup(db, adultId, [{ channel_id: kidsChannel, hidden: true, sort_order: null }]);

    const res = await request(app).get('/api/schedule').set('X-Profile-Id', String(adultId));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).not.toContain(String(kidsChannel));
    expect(Object.keys(res.body)).toContain(String(adultChannel));
  });

  it('does not return a channel whose current program is above a kids ceiling', async () => {
    const res = await request(app).get('/api/schedule').set('X-Profile-Id', String(kidsId));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).not.toContain(String(adultChannel));
    expect(Object.keys(res.body)).toContain(String(kidsChannel));
  });

  it('produces byte-identical output for a profile with no overrides and no ceiling', async () => {
    const withoutProfile = await request(app).get('/api/schedule');
    const withProfile = await request(app).get('/api/schedule').set('X-Profile-Id', String(adultId));
    expect(withProfile.body).toEqual(withoutProfile.body);
  });
});
