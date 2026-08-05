import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import { profileResolver } from '../../src/middleware/profileResolver.js';
import { streamRoutes } from '../../src/routes/stream.js';
import * as queries from '../../src/db/queries.js';

const ITEM_ID = 'a'.repeat(32);

function createApp(officialRating: string | undefined): { app: Express; db: Database.Database } {
  const db = createTestDb();
  const app = express();
  app.use(express.json());

  app.locals.db = db;
  app.locals.mediaProvider = {
    providerType: 'jellyfin',
    getItem: (id: string) => (id === ITEM_ID ? { Id: ITEM_ID, OfficialRating: officialRating } : undefined),
    getBaseUrl: () => 'http://mock:8096',
    getProxyHeaders: () => ({ 'X-Emby-Token': 'mock' }),
    getDeviceId: () => 'device-1',
    stopPlaybackSession: vi.fn(async () => {}),
    deleteTranscodingJob: vi.fn(async () => {}),
    getHlsStreamUrl: vi.fn(async () => ({
      url: 'http://mock:8096/Videos/x/master.m3u8',
      playSessionId: 'sess-1',
      isHdrSource: false,
      mediaSourceId: 'src-1',
    })),
  };

  app.use('/api', profileResolver);
  app.use('/api', streamRoutes);
  return { app, db };
}

describe('kids rating ceiling on GET /api/stream/:itemId', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('#EXTM3U'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('refuses a kids profile a direct stream request for an R-rated item', async () => {
    const { app, db } = createApp('R');
    const kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const res = await request(app).get(`/api/stream/${ITEM_ID}`).set('X-Profile-Id', String(kidsId));

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves an unrestricted profile unaffected', async () => {
    const { app, db } = createApp('R');
    const adultId = queries.createProfile(db, { name: 'Grown Up' }).id;

    const res = await request(app).get(`/api/stream/${ITEM_ID}`).set('X-Profile-Id', String(adultId));

    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('fails closed for a kids profile when the item rating cannot be determined', async () => {
    const { app, db } = createApp(undefined);
    const kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const res = await request(app).get(`/api/stream/${ITEM_ID}`).set('X-Profile-Id', String(kidsId));

    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows a kids profile a stream for an item within its ceiling', async () => {
    const { app, db } = createApp('TV-Y');
    const kidsId = queries.createProfile(db, { name: 'Kid', is_kids: true, max_rating: 'TV-Y7' }).id;

    const res = await request(app).get(`/api/stream/${ITEM_ID}`).set('X-Profile-Id', String(kidsId));

    expect(res.status).toBe(200);
  });
});
