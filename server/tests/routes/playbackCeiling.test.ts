import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import { playbackRoutes } from '../../src/routes/playback.js';
import * as queries from '../../src/db/queries.js';

const ITEM_ID = 'a'.repeat(32);
const SEEK_MS = 600_000;

function createApp(rating: string | null): { app: Express; db: Database.Database } {
  const db = createTestDb();
  const app = express();
  app.use(express.json());

  const scheduleEngine = {
    getCurrentProgram: () => ({
      program: {
        id: 1,
        channel_id: 1,
        media_item_id: ITEM_ID,
        type: 'program',
        content_type: 'movie',
        title: 'Test Movie',
        rating,
        start_time: new Date(Date.now() - SEEK_MS).toISOString(),
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
      },
      next: null,
      seekMs: SEEK_MS,
    }),
  };

  app.locals.db = db;
  app.locals.mediaProvider = {
    providerType: 'jellyfin',
    getPlaybackInfo: vi.fn(async () => ({ PlaySessionId: 'sess-1', MediaSources: [{ Id: 'src-1', MediaStreams: [] }] })),
    getMediaSegments: vi.fn(async () => ({ outroStartMs: null })),
    getBaseUrl: () => 'http://mock:8096',
    getProxyHeaders: () => ({ 'X-Emby-Token': 'mock' }),
    getDeviceId: () => 'device-1',
    deleteTranscodingJob: vi.fn(async () => {}),
  };
  app.locals.scheduleEngine = scheduleEngine;

  db.prepare(
    `INSERT INTO channels (id, number, name, type, item_ids, sort_order) VALUES (1, 100, 'Test', 'auto', '[]', 0)`
  ).run();

  app.use('/api', profileResolver);
  app.use('/api/playback', playbackRoutes);
  return { app, db };
}

describe('kids rating ceiling on GET /api/playback/:channelId', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('#EXTM3U'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('refuses a kids profile a stream for a program above its ceiling', async () => {
    const { app, db } = createApp('R');
    const kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const res = await request(app).get('/api/playback/1').set('X-Profile-Id', String(kidsId));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No program currently airing');
    expect(res.body.stream_url).toBeUndefined();
  });

  it('leaves an unrestricted profile unaffected', async () => {
    const { app, db } = createApp('R');
    const adultId = queries.createProfile(db, { name: 'Grown Up' }).id;

    const res = await request(app).get('/api/playback/1').set('X-Profile-Id', String(adultId));

    expect(res.status).toBe(200);
    expect(res.body.stream_url).toContain(ITEM_ID);
  });

  it('allows a kids profile a program within its ceiling', async () => {
    const { app, db } = createApp('TV-Y');
    const kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const res = await request(app).get('/api/playback/1').set('X-Profile-Id', String(kidsId));

    expect(res.status).toBe(200);
    expect(res.body.stream_url).toContain(ITEM_ID);
  });
});
