import Database from 'better-sqlite3';
import express from 'express';
import type { MediaItem } from '../../src/types/index.js';

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
      username TEXT NOT NULL DEFAULT '',
      access_token TEXT,
      user_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      server_type TEXT NOT NULL DEFAULT 'jellyfin',
      plex_client_id TEXT
    );

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('auto', 'custom', 'preset')),
      genre TEXT,
      preset_id TEXT,
      filter TEXT,
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

    -- Metrics: watch sessions
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      channel_id INTEGER,
      channel_name TEXT,
      item_id TEXT,
      title TEXT,
      series_name TEXT,
      content_type TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      duration_seconds REAL DEFAULT 0,
      user_agent TEXT
    );

    -- Metrics: watch events (granular log)
    CREATE TABLE IF NOT EXISTS watch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel_id INTEGER,
      channel_name TEXT,
      item_id TEXT,
      title TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Metrics: client registry
    CREATE TABLE IF NOT EXISTS client_registry (
      client_id TEXT PRIMARY KEY,
      display_name TEXT,
      platform TEXT,
      user_agent TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- AI: iconic scene cache per movie
    CREATE TABLE IF NOT EXISTS iconic_scenes (
      media_item_id TEXT PRIMARY KEY,
      scenes TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- AI: program facts cache (movies by media_item_id, series by series:Name)
    CREATE TABLE IF NOT EXISTS program_facts (
      fact_key TEXT PRIMARY KEY,
      facts TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- AI: catch-up summary cache (keyed by movie + 10-min time bucket)
    CREATE TABLE IF NOT EXISTS catch_up_summaries (
      media_item_id TEXT NOT NULL,
      time_bucket INTEGER NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (media_item_id, time_bucket)
    );

    -- AI: hidden gems (AI-recommended underwatched items)
    CREATE TABLE IF NOT EXISTS hidden_gems (
      media_item_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content_type TEXT,
      reason TEXT NOT NULL,
      score INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_schedule_channel
      ON schedule_blocks(channel_id, block_start);

    CREATE INDEX IF NOT EXISTS idx_channels_number
      ON channels(number);

    CREATE INDEX IF NOT EXISTS idx_library_server
      ON library_cache(server_id);

    CREATE INDEX IF NOT EXISTS idx_watch_sessions_client
      ON watch_sessions(client_id);

    CREATE INDEX IF NOT EXISTS idx_watch_sessions_started
      ON watch_sessions(started_at);

    CREATE INDEX IF NOT EXISTS idx_watch_sessions_channel
      ON watch_sessions(channel_id);

    CREATE INDEX IF NOT EXISTS idx_watch_events_created
      ON watch_events(created_at);

    CREATE INDEX IF NOT EXISTS idx_watch_events_client
      ON watch_events(client_id);
  `);

  // Insert default settings
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
  );
  insertSetting.run('genre_filter', JSON.stringify({ mode: 'allow', genres: [] }));
  insertSetting.run('content_types', JSON.stringify({ movies: true, tv_shows: true }));
  insertSetting.run('schedule_block_hours', JSON.stringify(8));
  insertSetting.run('schedule_auto_update_enabled', JSON.stringify(true));
  insertSetting.run('schedule_auto_update_hours', JSON.stringify(4));
  insertSetting.run('share_playback_progress', JSON.stringify(false));
  insertSetting.run('metrics_enabled', JSON.stringify(true));

  return db;
}

/**
 * Factory functions for creating mock Jellyfin media items
 */
export function createMockMovie(overrides: Partial<MediaItem> = {}): MediaItem {
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

export function createMockEpisode(overrides: Partial<MediaItem> = {}): MediaItem {
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
export function createMockMovieLibrary(count: number = 5, genre: string = 'Action'): MediaItem[] {
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
): MediaItem[] {
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
export function createTestApp(mockItems: MediaItem[] = []) {
  const db = createTestDb();
  const app = express();
  app.use(express.json());

  // Create a mock JellyfinClient-like object
  const itemMap = new Map<string, MediaItem>();
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
      const genres = new Map<string, MediaItem[]>();
      for (const item of mockItems) {
        for (const genre of item.Genres || []) {
          const existing = genres.get(genre) || [];
          existing.push(item);
          genres.set(genre, existing);
        }
      }
      return genres;
    },
    getItemDurationMs: (item: MediaItem) =>
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
  app.locals.mediaProvider = mockJellyfin;
  app.locals.scheduleEngine = scheduleEngine;
  app.locals.channelManager = channelManager;
  app.locals.wss = { clients: new Set() }; // Mock WebSocket server

  return { app, db, mockJellyfin, scheduleEngine, channelManager };
}
