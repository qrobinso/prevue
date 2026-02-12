import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/setup.js';
import * as queries from '../../src/db/queries.js';

describe('database queries', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // ─── Servers ────────────────────────────────────────

  describe('servers', () => {
    it('should create the first server as active', () => {
      const server = queries.createServer(db, 'Test', 'http://localhost:8096', 'key123');
      expect(server.name).toBe('Test');
      expect(server.is_active).toBeTruthy();
    });

    it('should create subsequent servers as inactive', () => {
      queries.createServer(db, 'First', 'http://first:8096', 'key1');
      const second = queries.createServer(db, 'Second', 'http://second:8096', 'key2');
      expect(second.is_active).toBeFalsy();
    });

    it('should list all servers', () => {
      queries.createServer(db, 'A', 'http://a:8096', 'key1');
      queries.createServer(db, 'B', 'http://b:8096', 'key2');
      const servers = queries.getAllServers(db);
      expect(servers).toHaveLength(2);
    });

    it('should get active server', () => {
      queries.createServer(db, 'Active', 'http://active:8096', 'key1');
      queries.createServer(db, 'Inactive', 'http://inactive:8096', 'key2');
      const active = queries.getActiveServer(db);
      expect(active?.name).toBe('Active');
    });

    it('should set a different server as active', () => {
      const s1 = queries.createServer(db, 'First', 'http://first:8096', 'key1');
      const s2 = queries.createServer(db, 'Second', 'http://second:8096', 'key2');
      queries.setActiveServer(db, s2.id);
      const active = queries.getActiveServer(db);
      expect(active?.name).toBe('Second');
    });

    it('should update server fields', () => {
      const server = queries.createServer(db, 'Old', 'http://old:8096', 'key');
      const updated = queries.updateServer(db, server.id, { name: 'New', url: 'http://new:8096' });
      expect(updated?.name).toBe('New');
      expect(updated?.url).toBe('http://new:8096');
      expect(updated?.api_key).toBe('key'); // unchanged
    });

    it('should delete a server', () => {
      const server = queries.createServer(db, 'ToDelete', 'http://del:8096', 'key');
      const deleted = queries.deleteServer(db, server.id);
      expect(deleted).toBe(true);
      expect(queries.getServerById(db, server.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent server', () => {
      expect(queries.deleteServer(db, 999)).toBe(false);
    });
  });

  // ─── Channels ───────────────────────────────────────

  describe('channels', () => {
    it('should create a channel with auto-incremented number', () => {
      const ch = queries.createChannel(db, { name: 'Action', type: 'auto', genre: 'Action', item_ids: ['a', 'b'] });
      expect(ch.number).toBe(1);
      expect(ch.name).toBe('Action');
      expect(ch.type).toBe('auto');
      expect(ch.item_ids).toEqual(['a', 'b']);
    });

    it('should increment channel numbers sequentially', () => {
      const ch1 = queries.createChannel(db, { name: 'Ch1', type: 'auto', item_ids: [] });
      const ch2 = queries.createChannel(db, { name: 'Ch2', type: 'auto', item_ids: [] });
      const ch3 = queries.createChannel(db, { name: 'Ch3', type: 'custom', item_ids: [] });
      expect(ch1.number).toBe(1);
      expect(ch2.number).toBe(2);
      expect(ch3.number).toBe(3);
    });

    it('should parse item_ids from JSON', () => {
      queries.createChannel(db, { name: 'Test', type: 'auto', item_ids: ['id1', 'id2', 'id3'] });
      const channels = queries.getAllChannels(db);
      expect(channels[0].item_ids).toEqual(['id1', 'id2', 'id3']);
    });

    it('should update channel name', () => {
      const ch = queries.createChannel(db, { name: 'Old', type: 'custom', item_ids: [] });
      const updated = queries.updateChannel(db, ch.id, { name: 'New' });
      expect(updated?.name).toBe('New');
    });

    it('should update channel item_ids', () => {
      const ch = queries.createChannel(db, { name: 'Test', type: 'custom', item_ids: ['a'] });
      const updated = queries.updateChannel(db, ch.id, { item_ids: ['a', 'b', 'c'] });
      expect(updated?.item_ids).toEqual(['a', 'b', 'c']);
    });

    it('should delete a channel', () => {
      const ch = queries.createChannel(db, { name: 'Del', type: 'custom', item_ids: [] });
      expect(queries.deleteChannel(db, ch.id)).toBe(true);
      expect(queries.getChannelById(db, ch.id)).toBeUndefined();
    });

    it('should delete only auto channels', () => {
      queries.createChannel(db, { name: 'Auto1', type: 'auto', item_ids: [] });
      queries.createChannel(db, { name: 'Custom1', type: 'custom', item_ids: [] });
      queries.createChannel(db, { name: 'Auto2', type: 'auto', item_ids: [] });

      queries.deleteAutoChannels(db);
      const remaining = queries.getAllChannels(db);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].name).toBe('Custom1');
    });
  });

  // ─── Schedule Blocks ────────────────────────────────

  describe('schedule blocks', () => {
    let channelId: number;

    beforeEach(() => {
      const ch = queries.createChannel(db, { name: 'Test', type: 'auto', item_ids: [] });
      channelId = ch.id;
    });

    it('should upsert and retrieve a schedule block', () => {
      const programs = [
        { jellyfin_item_id: 'x', title: 'Movie X', start_time: '2026-02-11T00:00:00Z', end_time: '2026-02-11T02:00:00Z', duration_ms: 7200000, type: 'program', subtitle: null, thumbnail_url: null },
      ];
      const block = queries.upsertScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z', '2026-02-11T08:00:00.000Z', programs, 'seed123');
      expect(block.channel_id).toBe(channelId);
      expect(block.programs).toHaveLength(1);
      expect(block.programs[0].title).toBe('Movie X');
      expect(block.seed).toBe('seed123');
    });

    it('should upsert (overwrite) an existing block', () => {
      const start = '2026-02-11T00:00:00.000Z';
      const end = '2026-02-11T08:00:00.000Z';
      queries.upsertScheduleBlock(db, channelId, start, end, [{ title: 'First' }], 'seed1');
      queries.upsertScheduleBlock(db, channelId, start, end, [{ title: 'Replaced' }], 'seed2');
      const block = queries.getScheduleBlock(db, channelId, start);
      expect(block?.programs).toHaveLength(1);
      expect((block?.programs[0] as { title: string }).title).toBe('Replaced');
      expect(block?.seed).toBe('seed2');
    });

    it('should get current and next blocks', () => {
      queries.upsertScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z', '2026-02-11T08:00:00.000Z', [], 's1');
      queries.upsertScheduleBlock(db, channelId, '2026-02-11T08:00:00.000Z', '2026-02-11T16:00:00.000Z', [], 's2');
      queries.upsertScheduleBlock(db, channelId, '2026-02-11T16:00:00.000Z', '2026-02-12T00:00:00.000Z', [], 's3');

      const blocks = queries.getCurrentAndNextBlocks(db, channelId, '2026-02-11T04:00:00.000Z');
      expect(blocks).toHaveLength(2);
      expect(blocks[0].block_start).toBe('2026-02-11T00:00:00.000Z');
      expect(blocks[1].block_start).toBe('2026-02-11T08:00:00.000Z');
    });

    it('should delete schedule blocks for a channel', () => {
      queries.upsertScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z', '2026-02-11T08:00:00.000Z', [], 's1');
      queries.deleteScheduleBlocksForChannel(db, channelId);
      const block = queries.getScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z');
      expect(block).toBeUndefined();
    });

    it('should clean old schedule blocks', () => {
      queries.upsertScheduleBlock(db, channelId, '2026-02-09T00:00:00.000Z', '2026-02-09T08:00:00.000Z', [], 's1'); // old
      queries.upsertScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z', '2026-02-11T08:00:00.000Z', [], 's2'); // current
      queries.cleanOldScheduleBlocks(db, '2026-02-10T00:00:00.000Z');

      expect(queries.getScheduleBlock(db, channelId, '2026-02-09T00:00:00.000Z')).toBeUndefined();
      expect(queries.getScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z')).toBeDefined();
    });

    it('should cascade delete blocks when channel is deleted', () => {
      queries.upsertScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z', '2026-02-11T08:00:00.000Z', [], 's1');
      queries.deleteChannel(db, channelId);
      const block = queries.getScheduleBlock(db, channelId, '2026-02-11T00:00:00.000Z');
      expect(block).toBeUndefined();
    });
  });

  // ─── Settings ───────────────────────────────────────

  describe('settings', () => {
    it('should read default settings', () => {
      const settings = queries.getAllSettings(db);
      expect(settings).toHaveProperty('genre_filter');
      expect(settings).toHaveProperty('content_types');
    });

    it('should set and get a setting', () => {
      queries.setSetting(db, 'test_key', { hello: 'world' });
      const value = queries.getSetting(db, 'test_key');
      expect(value).toEqual({ hello: 'world' });
    });

    it('should overwrite an existing setting', () => {
      queries.setSetting(db, 'counter', 1);
      queries.setSetting(db, 'counter', 2);
      expect(queries.getSetting(db, 'counter')).toBe(2);
    });

    it('should return undefined for missing setting', () => {
      expect(queries.getSetting(db, 'nonexistent')).toBeUndefined();
    });

    it('should handle complex nested objects', () => {
      const complex = { genres: ['Action', 'Comedy'], nested: { deep: true, arr: [1, 2, 3] } };
      queries.setSetting(db, 'complex', complex);
      expect(queries.getSetting(db, 'complex')).toEqual(complex);
    });
  });

  // ─── Library Cache ──────────────────────────────────

  describe('library cache', () => {
    let serverId: number;

    beforeEach(() => {
      const server = queries.createServer(db, 'Test', 'http://test:8096', 'key');
      serverId = server.id;
    });

    it('should cache and retrieve library items', () => {
      queries.upsertLibraryItem(db, 'item-1', serverId, { Id: 'item-1', Name: 'Movie 1' });
      queries.upsertLibraryItem(db, 'item-2', serverId, { Id: 'item-2', Name: 'Movie 2' });
      const cached = queries.getCachedLibrary(db, serverId);
      expect(cached).toHaveLength(2);
    });

    it('should update existing cached items', () => {
      queries.upsertLibraryItem(db, 'item-1', serverId, { Id: 'item-1', Name: 'Old Name' });
      queries.upsertLibraryItem(db, 'item-1', serverId, { Id: 'item-1', Name: 'New Name' });
      const cached = queries.getCachedLibrary(db, serverId);
      expect(cached).toHaveLength(1);
      expect((cached[0] as { Name: string }).Name).toBe('New Name');
    });

    it('should clear cache for a server', () => {
      queries.upsertLibraryItem(db, 'item-1', serverId, { Id: 'item-1' });
      queries.clearLibraryCache(db, serverId);
      expect(queries.getCachedLibrary(db, serverId)).toHaveLength(0);
    });
  });
});
