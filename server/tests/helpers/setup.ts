import Database from 'better-sqlite3';
import express from 'express';
import type { JellyfinItem } from '../../src/types/index.js';

/**
 * Create an in-memory SQLite database with the Prevue schema applied.
 * Each test gets a fresh isolated database.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('auto', 'custom')),
      genre TEXT,
      item_ids TEXT NOT NULL DEFAULT '[]',
      ai_prompt TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedule_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      block_start TEXT NOT NULL,
      block_end TEXT NOT NULL,
      programs TEXT NOT NULL DEFAULT '[]',
      seed TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
      UNIQUE(channel_id, block_start)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS library_cache (
      id TEXT PRIMARY KEY,
      server_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_channel
      ON schedule_blocks(channel_id, block_start);
    CREATE INDEX IF NOT EXISTS idx_channels_number
      ON channels(number);
    CREATE INDEX IF NOT EXISTS idx_library_server
      ON library_cache(server_id);
  `);

  // Insert default settings
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
  );
  insertSetting.run('genre_filter', JSON.stringify({ mode: 'allow', genres: [] }));
  insertSetting.run('content_types', JSON.stringify({ movies: true, tv_shows: true }));
  insertSetting.run('schedule_block_hours', JSON.stringify(8));

  return db;
}

/**
 * Factory functions for creating mock Jellyfin media items
 */
export function createMockMovie(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  const id = overrides.Id || `movie-${Math.random().toString(36).slice(2, 8)}`;
  return {
    Id: id,
    Name: overrides.Name || `Test Movie ${id.slice(-4)}`,
    Type: 'Movie',
    Genres: overrides.Genres || ['Action'],
    RunTimeTicks: overrides.RunTimeTicks || 72000000000, // 2 hours in ticks
    ProductionYear: overrides.ProductionYear || 2020,
    Overview: overrides.Overview || 'A test movie',
    ImageTags: { Primary: 'abc123' },
    ...overrides,
  };
}

export function createMockEpisode(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  const id = overrides.Id || `episode-${Math.random().toString(36).slice(2, 8)}`;
  return {
    Id: id,
    Name: overrides.Name || `Episode ${id.slice(-4)}`,
    Type: 'Episode',
    SeriesId: overrides.SeriesId || 'series-001',
    SeriesName: overrides.SeriesName || 'Test Series',
    SeasonName: overrides.SeasonName || 'Season 1',
    ParentIndexNumber: overrides.ParentIndexNumber || 1,
    IndexNumber: overrides.IndexNumber || 1,
    Genres: overrides.Genres || ['Drama'],
    RunTimeTicks: overrides.RunTimeTicks || 27000000000, // 45 min in ticks
    ImageTags: { Primary: 'def456' },
    ...overrides,
  };
}

/**
 * Create a set of mock movies with enough duration for channel generation (>4 hours)
 */
export function createMockMovieLibrary(count: number = 5, genre: string = 'Action'): JellyfinItem[] {
  return Array.from({ length: count }, (_, i) =>
    createMockMovie({
      Id: `movie-${genre.toLowerCase()}-${i}`,
      Name: `${genre} Movie ${i + 1}`,
      Genres: [genre],
      RunTimeTicks: 72000000000, // 2 hours each = 10 hours total for 5 movies
    })
  );
}

/**
 * Create a set of mock episodes for a series
 */
export function createMockEpisodeSeries(
  seriesId: string,
  seriesName: string,
  episodeCount: number = 10,
  genre: string = 'Drama'
): JellyfinItem[] {
  return Array.from({ length: episodeCount }, (_, i) =>
    createMockEpisode({
      Id: `${seriesId}-ep-${i + 1}`,
      SeriesId: seriesId,
      SeriesName: seriesName,
      ParentIndexNumber: Math.floor(i / 5) + 1,  // 5 episodes per season
      IndexNumber: (i % 5) + 1,
      Name: `${seriesName} Episode ${i + 1}`,
      Genres: [genre],
      RunTimeTicks: 27000000000, // 45 min each
    })
  );
}

/**
 * Create a mock Express app with services wired up for route testing.
 * Uses an in-memory DB and mock Jellyfin items.
 */
export function createTestApp(mockItems: JellyfinItem[] = []) {
  const db = createTestDb();
  const app = express();
  app.use(express.json());

  // Create a mock JellyfinClient-like object
  const itemMap = new Map<string, JellyfinItem>();
  for (const item of mockItems) {
    itemMap.set(item.Id, item);
  }

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
    getStreamUrl: (itemId: string) => `/stream/${itemId}`,
    getHlsStreamUrl: (itemId: string) => `/hls/${itemId}`,
    getImageUrl: (itemId: string) => `/images/${itemId}`,
    getBaseUrl: () => 'http://mock-jellyfin:8096',
    getProxyHeaders: () => ({ 'X-Emby-Token': 'mock-token' }),
  };

  // Import and set up ScheduleEngine with the mock
  // We need a real ScheduleEngine that uses the mock jellyfin
  const { ScheduleEngine } = require('../../src/services/ScheduleEngine.js');
  const { ChannelManager } = require('../../src/services/ChannelManager.js');

  const scheduleEngine = new ScheduleEngine(db, mockJellyfin);
  const channelManager = new ChannelManager(db, mockJellyfin, scheduleEngine);

  app.locals.db = db;
  app.locals.jellyfinClient = mockJellyfin;
  app.locals.scheduleEngine = scheduleEngine;
  app.locals.channelManager = channelManager;
  app.locals.wss = { clients: new Set() }; // Mock WebSocket server

  return { app, db, mockJellyfin, scheduleEngine, channelManager };
}
