import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createTestDb, createMockMovieLibrary } from '../helpers/setup.js';
import express from 'express';
import { channelRoutes } from '../../src/routes/channels.js';
import { scheduleRoutes } from '../../src/routes/schedule.js';
import { settingsRoutes } from '../../src/routes/settings.js';
import { serverRoutes } from '../../src/routes/servers.js';
import { ScheduleEngine } from '../../src/services/ScheduleEngine.js';
import { ChannelManager } from '../../src/services/ChannelManager.js';
import * as queries from '../../src/db/queries.js';
import type { JellyfinItem } from '../../src/types/index.js';

function createApiApp(mockItems: JellyfinItem[] = []) {
  const db = createTestDb();
  const app = express();
  app.use(express.json());

  const itemMap = new Map<string, JellyfinItem>();
  for (const item of mockItems) itemMap.set(item.Id, item);

  const mockJellyfin = {
    getActiveServer: () => undefined,
    testConnection: async () => true,
    syncLibrary: async () => mockItems,
    getLibraryItems: () => mockItems,
    getItem: (id: string) => itemMap.get(id),
    getItemsByGenre: (genre: string) =>
      mockItems.filter(i => i.Genres?.some(g => g.toLowerCase() === genre.toLowerCase())),
    getGenres: () => {
      const genres = new Map<string, JellyfinItem[]>();
      for (const item of mockItems) {
        for (const genre of item.Genres || []) {
          const existing = genres.get(genre) || [];
          existing.push(item);
          genres.set(genre, existing);
        }
      }
      return genres;
    },
    getItemDurationMs: (item: JellyfinItem) =>
      item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : 0,
    getBaseUrl: () => 'http://mock:8096',
    getProxyHeaders: () => ({ 'X-Emby-Token': 'mock' }),
  } as any;

  const scheduleEngine = new ScheduleEngine(db, mockJellyfin);
  const channelManager = new ChannelManager(db, mockJellyfin, scheduleEngine);

  app.locals.db = db;
  app.locals.jellyfinClient = mockJellyfin;
  app.locals.scheduleEngine = scheduleEngine;
  app.locals.channelManager = channelManager;
  app.locals.wss = { clients: new Set() };

  app.use('/api/channels', channelRoutes);
  app.use('/api/schedule', scheduleRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/servers', serverRoutes);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return { app, db };
}

describe('API Routes', () => {
  describe('GET /api/health', () => {
    it('should return 200 with status ok', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('Channels API', () => {
    it('GET /api/channels should return empty array initially', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/channels');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('POST /api/channels should create a custom channel', async () => {
      const movies = createMockMovieLibrary(3, 'Action');
      const { app } = createApiApp(movies);

      const res = await request(app)
        .post('/api/channels')
        .send({ name: 'My Channel', item_ids: movies.map(m => m.Id) });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Channel');
      expect(res.body.type).toBe('custom');
      expect(res.body.item_ids).toHaveLength(3);
    });

    it('POST /api/channels should reject missing fields', async () => {
      const { app } = createApiApp();
      const res = await request(app).post('/api/channels').send({});
      expect(res.status).toBe(400);
    });

    it('GET /api/channels should list created channels', async () => {
      const movies = createMockMovieLibrary(3, 'Action');
      const { app, db } = createApiApp(movies);

      queries.createChannel(db, { name: 'Action', type: 'auto', item_ids: movies.map(m => m.Id) });

      const res = await request(app).get('/api/channels');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe('Action');
    });

    it('PUT /api/channels/:id should update a channel', async () => {
      const movies = createMockMovieLibrary(3, 'Action');
      const { app, db } = createApiApp(movies);

      const ch = queries.createChannel(db, { name: 'Old', type: 'custom', item_ids: [] });

      const res = await request(app)
        .put(`/api/channels/${ch.id}`)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated');
    });

    it('DELETE /api/channels/:id should delete a custom channel', async () => {
      const { app, db } = createApiApp();
      const ch = queries.createChannel(db, { name: 'Custom', type: 'custom', item_ids: [] });

      const res = await request(app).delete(`/api/channels/${ch.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('DELETE /api/channels/:id should reject deleting auto channels', async () => {
      const { app, db } = createApiApp();
      const ch = queries.createChannel(db, { name: 'Auto', type: 'auto', item_ids: [] });

      const res = await request(app).delete(`/api/channels/${ch.id}`);
      expect(res.status).toBe(400);
    });

    it('POST /api/channels/regenerate should regenerate auto channels', async () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const { app } = createApiApp(movies);

      const res = await request(app).post('/api/channels/regenerate');
      expect(res.status).toBe(200);
      expect(res.body.channels_created).toBe(1);
    });

    it('GET /api/channels/ai/status should report AI unavailable', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/channels/ai/status');
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
    });
  });

  describe('Schedule API', () => {
    it('GET /api/schedule should return schedule data', async () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const { app, db } = createApiApp(movies);

      const ch = queries.createChannel(db, { name: 'Action', type: 'auto', item_ids: movies.map(m => m.Id) });

      // Generate a schedule block
      const scheduleEngine = app.locals.scheduleEngine as ScheduleEngine;
      await scheduleEngine.ensureSchedule(ch);

      const res = await request(app).get('/api/schedule');
      expect(res.status).toBe(200);
      expect(res.body[ch.id]).toBeDefined();
    });

    it('GET /api/schedule/:channelId should return blocks for a channel', async () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const { app, db } = createApiApp(movies);

      const ch = queries.createChannel(db, { name: 'Action', type: 'auto', item_ids: movies.map(m => m.Id) });
      const scheduleEngine = app.locals.scheduleEngine as ScheduleEngine;
      await scheduleEngine.ensureSchedule(ch);

      const res = await request(app).get(`/api/schedule/${ch.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('POST /api/schedule/regenerate should regenerate all schedules', async () => {
      const { app } = createApiApp();
      const res = await request(app).post('/api/schedule/regenerate');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('Settings API', () => {
    it('GET /api/settings should return default settings', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/settings');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('genre_filter');
      expect(res.body).toHaveProperty('content_types');
    });

    it('PUT /api/settings should update settings', async () => {
      const { app } = createApiApp();
      const res = await request(app)
        .put('/api/settings')
        .send({ theme: 'dark', custom_key: 42 });

      expect(res.status).toBe(200);
      expect(res.body.theme).toBe('dark');
      expect(res.body.custom_key).toBe(42);
    });

    it('PUT /api/settings should reject non-object body', async () => {
      const { app } = createApiApp();
      const res = await request(app).put('/api/settings').send('not-object');
      expect(res.status).toBe(400);
    });

    it('GET /api/settings/:key should get a specific setting', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/settings/genre_filter');
      expect(res.status).toBe(200);
      expect(res.body.key).toBe('genre_filter');
    });

    it('GET /api/settings/:key should return 404 for missing key', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/settings/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('Servers API', () => {
    it('GET /api/servers should return empty array initially', async () => {
      const { app } = createApiApp();
      const res = await request(app).get('/api/servers');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('POST /api/servers should reject missing fields', async () => {
      const { app } = createApiApp();
      const res = await request(app).post('/api/servers').send({ name: 'Test' });
      expect(res.status).toBe(400);
    });

    it('GET /api/servers should mask API keys', async () => {
      const { app, db } = createApiApp();
      queries.createServer(db, 'Test', 'http://test:8096', 'my-secret-key-123');

      const res = await request(app).get('/api/servers');
      expect(res.status).toBe(200);
      expect(res.body[0].api_key).not.toContain('my-secret');
      expect(res.body[0].api_key).toMatch(/^\*{4}/);
    });

    it('DELETE /api/servers/:id should delete a server', async () => {
      const { app, db } = createApiApp();
      const server = queries.createServer(db, 'Test', 'http://test:8096', 'key');

      const res = await request(app).delete(`/api/servers/${server.id}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('DELETE /api/servers/:id should return 404 for missing server', async () => {
      const { app } = createApiApp();
      const res = await request(app).delete('/api/servers/999');
      expect(res.status).toBe(404);
    });
  });
});
