import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, createMockMovieLibrary, createMockEpisodeSeries } from '../helpers/setup.js';
import { ChannelManager } from '../../src/services/ChannelManager.js';
import { ScheduleEngine } from '../../src/services/ScheduleEngine.js';
import * as queries from '../../src/db/queries.js';
import type { JellyfinItem } from '../../src/types/index.js';

function createMockJellyfin(items: JellyfinItem[]) {
  const itemMap = new Map<string, JellyfinItem>();
  for (const item of items) itemMap.set(item.Id, item);

  return {
    getItem: (id: string) => itemMap.get(id),
    getItemDurationMs: (item: JellyfinItem) =>
      item.RunTimeTicks ? Math.round(item.RunTimeTicks / 10000) : 0,
    getLibraryItems: () => items,
    getGenres: () => {
      const genres = new Map<string, JellyfinItem[]>();
      for (const item of items) {
        for (const genre of item.Genres || []) {
          const existing = genres.get(genre) || [];
          existing.push(item);
          genres.set(genre, existing);
        }
      }
      return genres;
    },
  } as any;
}

describe('ChannelManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  describe('autoGenerateChannels', () => {
    it('should create channels for genres with enough content', async () => {
      const movies = createMockMovieLibrary(5, 'Action'); // 5 * 2h = 10h > 4h minimum
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const channels = await manager.autoGenerateChannels();
      expect(channels.length).toBe(1);
      expect(channels[0].name).toBe('Action');
      expect(channels[0].type).toBe('auto');
      expect(channels[0].item_ids).toHaveLength(5);
    });

    it('should skip genres with insufficient content', async () => {
      // 1 movie = 2 hours, less than 4-hour minimum
      const movies = createMockMovieLibrary(1, 'Niche');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const channels = await manager.autoGenerateChannels();
      expect(channels.length).toBe(0);
    });

    it('should create multiple genre channels', async () => {
      const actionMovies = createMockMovieLibrary(5, 'Action');
      const comedyMovies = createMockMovieLibrary(5, 'Comedy');
      const allMovies = [...actionMovies, ...comedyMovies];

      const mockJf = createMockJellyfin(allMovies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const channels = await manager.autoGenerateChannels();
      expect(channels.length).toBe(2);
      const names = channels.map(c => c.name).sort();
      expect(names).toEqual(['Action', 'Comedy']);
    });

    it('should replace existing auto channels on regeneration', async () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      await manager.autoGenerateChannels();
      const first = queries.getAllChannels(db);
      expect(first.length).toBe(1);

      // Regenerate - should still have exactly 1
      await manager.autoGenerateChannels();
      const second = queries.getAllChannels(db);
      expect(second.length).toBe(1);
    });

    it('should not delete custom channels on auto-regeneration', async () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      // Create a custom channel first
      queries.createChannel(db, { name: 'My Custom', type: 'custom', item_ids: ['a'] });

      await manager.autoGenerateChannels();
      const all = queries.getAllChannels(db);
      expect(all.length).toBe(2); // 1 custom + 1 auto
      expect(all.some(c => c.name === 'My Custom' && c.type === 'custom')).toBe(true);
    });

    it('should respect genre deny filter', async () => {
      const action = createMockMovieLibrary(5, 'Action');
      const comedy = createMockMovieLibrary(5, 'Comedy');
      const mockJf = createMockJellyfin([...action, ...comedy]);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      // Set genre filter to deny Action
      queries.setSetting(db, 'genre_filter', { mode: 'deny', genres: ['Action'] });

      const channels = await manager.autoGenerateChannels();
      expect(channels.length).toBe(1);
      expect(channels[0].name).toBe('Comedy');
    });

    it('should respect content type filter', async () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const episodes = createMockEpisodeSeries('s1', 'Show', 20, 'Action');
      const mockJf = createMockJellyfin([...movies, ...episodes]);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      // Disable TV shows
      queries.setSetting(db, 'content_types', { movies: true, tv_shows: false });

      const channels = await manager.autoGenerateChannels();
      if (channels.length > 0) {
        // All items should be movies
        for (const ch of channels) {
          for (const itemId of ch.item_ids) {
            const item = mockJf.getItem(itemId);
            expect(item?.Type).toBe('Movie');
          }
        }
      }
    });
  });

  describe('createCustomChannel', () => {
    it('should create a custom channel with valid item IDs', () => {
      const movies = createMockMovieLibrary(3, 'Action');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const channel = manager.createCustomChannel('My Channel', movies.map(m => m.Id));
      expect(channel.name).toBe('My Channel');
      expect(channel.type).toBe('custom');
      expect(channel.item_ids).toHaveLength(3);
    });

    it('should filter out invalid item IDs', () => {
      const movies = createMockMovieLibrary(2, 'Action');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const channel = manager.createCustomChannel('Mixed', [
        movies[0].Id,
        'nonexistent-id',
        movies[1].Id,
      ]);
      expect(channel.item_ids).toHaveLength(2);
    });

    it('should throw if no valid items are found', () => {
      const mockJf = createMockJellyfin([]);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      expect(() => manager.createCustomChannel('Bad', ['fake-id'])).toThrow('No valid items');
    });

    it('should store AI prompt if provided', () => {
      const movies = createMockMovieLibrary(3, 'Action');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const channel = manager.createCustomChannel('AI Channel', movies.map(m => m.Id), 'Make a scary channel');
      expect(channel.ai_prompt).toBe('Make a scary channel');
    });
  });

  describe('searchLibrary', () => {
    it('should search by title', () => {
      const movies = createMockMovieLibrary(5, 'Action');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const results = manager.searchLibrary('Movie 3');
      expect(results.some(r => r.Name === 'Action Movie 3')).toBe(true);
    });

    it('should search by genre', () => {
      const movies = createMockMovieLibrary(3, 'SciFi');
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const results = manager.searchLibrary('scifi');
      expect(results.length).toBe(3);
    });

    it('should search by series name', () => {
      const episodes = createMockEpisodeSeries('s1', 'Breaking Bad', 10, 'Drama');
      const mockJf = createMockJellyfin(episodes);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const results = manager.searchLibrary('breaking');
      expect(results.length).toBe(10);
    });

    it('should limit results to 100', () => {
      const movies = Array.from({ length: 200 }, (_, i) =>
        createMockMovieLibrary(1, 'Action')[0]
      );
      // Give them all the same genre so they all match
      const mockJf = createMockJellyfin(movies);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const results = manager.searchLibrary('action');
      expect(results.length).toBeLessThanOrEqual(100);
    });
  });

  describe('getAvailableGenres', () => {
    it('should list genres sorted by count', () => {
      const action = createMockMovieLibrary(5, 'Action');
      const comedy = createMockMovieLibrary(3, 'Comedy');
      const mockJf = createMockJellyfin([...action, ...comedy]);
      const engine = new ScheduleEngine(db, mockJf);
      const manager = new ChannelManager(db, mockJf, engine);

      const genres = manager.getAvailableGenres();
      expect(genres[0].genre).toBe('Action'); // 5 items
      expect(genres[0].count).toBe(5);
      expect(genres[1].genre).toBe('Comedy'); // 3 items
      expect(genres[1].count).toBe(3);
    });
  });
});
