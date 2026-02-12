import type Database from 'better-sqlite3';
import type { ServerConfig, Channel, ChannelParsed, ChannelFilter, ScheduleBlock, ScheduleBlockParsed } from '../types/index.js';

// ─── Servers ──────────────────────────────────────────────

export function getAllServers(db: Database.Database): ServerConfig[] {
  return db.prepare('SELECT * FROM servers ORDER BY id').all() as ServerConfig[];
}

export function getActiveServer(db: Database.Database): ServerConfig | undefined {
  return db.prepare('SELECT * FROM servers WHERE is_active = 1 LIMIT 1').get() as ServerConfig | undefined;
}

export function getServerById(db: Database.Database, id: number): ServerConfig | undefined {
  return db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as ServerConfig | undefined;
}

export function createServer(
  db: Database.Database,
  name: string,
  url: string,
  username: string,
  accessToken: string,
  userId: string
): ServerConfig {
  // If this is the first server, make it active
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM servers').get() as { cnt: number }).cnt;
  const isActive = count === 0 ? 1 : 0;

  const result = db.prepare(
    'INSERT INTO servers (name, url, username, access_token, user_id, is_active) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(name, url, username, accessToken, userId, isActive);

  return getServerById(db, result.lastInsertRowid as number)!;
}

export function updateServer(
  db: Database.Database,
  id: number,
  data: Partial<Pick<ServerConfig, 'name' | 'url' | 'username' | 'access_token' | 'user_id'>>
): ServerConfig | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.url !== undefined) { fields.push('url = ?'); values.push(data.url); }
  if (data.username !== undefined) { fields.push('username = ?'); values.push(data.username); }
  if (data.access_token !== undefined) { fields.push('access_token = ?'); values.push(data.access_token); }
  if (data.user_id !== undefined) { fields.push('user_id = ?'); values.push(data.user_id); }

  if (fields.length === 0) return getServerById(db, id);

  values.push(id);
  db.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getServerById(db, id);
}

export function deleteServer(db: Database.Database, id: number): boolean {
  // Delete all related data in a transaction
  const txn = db.transaction(() => {
    // Delete schedule blocks (will cascade from channels, but explicit is clearer)
    db.prepare('DELETE FROM schedule_blocks').run();
    // Delete all channels (item_ids reference items from any server)
    db.prepare('DELETE FROM channels').run();
    // library_cache has ON DELETE CASCADE, but we can be explicit
    db.prepare('DELETE FROM library_cache WHERE server_id = ?').run(id);
    // Finally delete the server
    const result = db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    return result.changes > 0;
  });
  return txn();
}

export function setActiveServer(db: Database.Database, id: number): void {
  const txn = db.transaction(() => {
    db.prepare('UPDATE servers SET is_active = 0').run();
    db.prepare('UPDATE servers SET is_active = 1 WHERE id = ?').run(id);
  });
  txn();
}

// ─── Channels ─────────────────────────────────────────────

function parseChannel(ch: Channel): ChannelParsed {
  return { 
    ...ch, 
    item_ids: JSON.parse(ch.item_ids),
    filter: ch.filter ? JSON.parse(ch.filter) : null,
  };
}

export function getAllChannels(db: Database.Database): ChannelParsed[] {
  const rows = db.prepare('SELECT * FROM channels ORDER BY sort_order, number').all() as Channel[];
  return rows.map(parseChannel);
}

export function getChannelById(db: Database.Database, id: number): ChannelParsed | undefined {
  const row = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Channel | undefined;
  return row ? parseChannel(row) : undefined;
}

export function getNextChannelNumber(db: Database.Database): number {
  const result = db.prepare('SELECT MAX(number) as max_num FROM channels').get() as { max_num: number | null };
  return (result.max_num ?? 0) + 1;
}

export function createChannel(
  db: Database.Database,
  data: { 
    name: string; 
    type: 'auto' | 'custom' | 'preset'; 
    genre?: string; 
    preset_id?: string;
    filter?: ChannelFilter;
    item_ids: string[]; 
    ai_prompt?: string 
  }
): ChannelParsed {
  const number = getNextChannelNumber(db);
  const result = db.prepare(
    `INSERT INTO channels (number, name, type, genre, preset_id, filter, item_ids, ai_prompt, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    number, 
    data.name, 
    data.type, 
    data.genre ?? null, 
    data.preset_id ?? null,
    data.filter ? JSON.stringify(data.filter) : null,
    JSON.stringify(data.item_ids), 
    data.ai_prompt ?? null, 
    number
  );

  return getChannelById(db, result.lastInsertRowid as number)!;
}

export function updateChannel(
  db: Database.Database,
  id: number,
  data: Partial<Pick<ChannelParsed, 'name' | 'item_ids' | 'sort_order' | 'number'>>
): ChannelParsed | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.item_ids !== undefined) { fields.push('item_ids = ?'); values.push(JSON.stringify(data.item_ids)); }
  if (data.sort_order !== undefined) { fields.push('sort_order = ?'); values.push(data.sort_order); }
  if (data.number !== undefined) { fields.push('number = ?'); values.push(data.number); }

  if (fields.length === 0) return getChannelById(db, id);

  values.push(id);
  db.prepare(`UPDATE channels SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getChannelById(db, id);
}

export function deleteChannel(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM channels WHERE id = ?').run(id);
  return result.changes > 0;
}

export function deleteAutoChannels(db: Database.Database): void {
  db.prepare("DELETE FROM channels WHERE type = 'auto'").run();
}

export function deletePresetChannels(db: Database.Database): void {
  db.prepare("DELETE FROM channels WHERE type = 'preset'").run();
}

export function deleteAutoAndPresetChannels(db: Database.Database): void {
  db.prepare("DELETE FROM channels WHERE type IN ('auto', 'preset')").run();
}

// ─── Schedule Blocks ──────────────────────────────────────

function parseScheduleBlock(block: ScheduleBlock): ScheduleBlockParsed {
  return { ...block, programs: JSON.parse(block.programs) };
}

export function getScheduleBlock(
  db: Database.Database,
  channelId: number,
  blockStart: string
): ScheduleBlockParsed | undefined {
  const row = db.prepare(
    'SELECT * FROM schedule_blocks WHERE channel_id = ? AND block_start = ?'
  ).get(channelId, blockStart) as ScheduleBlock | undefined;
  return row ? parseScheduleBlock(row) : undefined;
}

export function getCurrentAndNextBlocks(
  db: Database.Database,
  channelId: number,
  now: string
): ScheduleBlockParsed[] {
  const rows = db.prepare(
    `SELECT * FROM schedule_blocks
     WHERE channel_id = ? AND block_end > ?
     ORDER BY block_start
     LIMIT 2`
  ).all(channelId, now) as ScheduleBlock[];
  return rows.map(parseScheduleBlock);
}

export function getAllCurrentBlocks(db: Database.Database, now: string): ScheduleBlockParsed[] {
  const rows = db.prepare(
    `SELECT * FROM schedule_blocks
     WHERE block_start <= ? AND block_end > ?
     ORDER BY channel_id`
  ).all(now, now) as ScheduleBlock[];
  return rows.map(parseScheduleBlock);
}

export function upsertScheduleBlock(
  db: Database.Database,
  channelId: number,
  blockStart: string,
  blockEnd: string,
  programs: unknown[],
  seed: string
): ScheduleBlockParsed {
  db.prepare(
    `INSERT INTO schedule_blocks (channel_id, block_start, block_end, programs, seed)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, block_start) DO UPDATE SET
       block_end = excluded.block_end,
       programs = excluded.programs,
       seed = excluded.seed,
       created_at = datetime('now')`
  ).run(channelId, blockStart, blockEnd, JSON.stringify(programs), seed);

  return getScheduleBlock(db, channelId, blockStart)!;
}

export function deleteScheduleBlocksForChannel(db: Database.Database, channelId: number): void {
  db.prepare('DELETE FROM schedule_blocks WHERE channel_id = ?').run(channelId);
}

export function cleanOldScheduleBlocks(db: Database.Database, before: string): void {
  db.prepare('DELETE FROM schedule_blocks WHERE block_end < ?').run(before);
}

/**
 * Get all schedule blocks that overlap with a time range (for conflict detection)
 */
export function getAllScheduleBlocksInRange(
  db: Database.Database,
  rangeStart: string,
  rangeEnd: string
): ScheduleBlockParsed[] {
  const rows = db.prepare(
    `SELECT * FROM schedule_blocks 
     WHERE block_start < ? AND block_end > ?
     ORDER BY channel_id, block_start`
  ).all(rangeEnd, rangeStart) as ScheduleBlock[];
  return rows.map(parseScheduleBlock);
}

// ─── Settings ─────────────────────────────────────────────

export function getSetting(db: Database.Database, key: string): unknown {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

export function setSetting(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function getAllSettings(db: Database.Database): Record<string, unknown> {
  const rows = db.prepare('SELECT * FROM settings').all() as { key: string; value: string }[];
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    result[row.key] = JSON.parse(row.value);
  }
  return result;
}

// ─── Library Cache ────────────────────────────────────────

export function getCachedLibrary(db: Database.Database, serverId: number): unknown[] {
  const rows = db.prepare('SELECT data FROM library_cache WHERE server_id = ?').all(serverId) as { data: string }[];
  return rows.map(r => JSON.parse(r.data));
}

export function upsertLibraryItem(db: Database.Database, id: string, serverId: number, data: unknown): void {
  db.prepare(
    `INSERT INTO library_cache (id, server_id, data, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       data = excluded.data,
       updated_at = excluded.updated_at`
  ).run(id, serverId, JSON.stringify(data));
}

export function clearLibraryCache(db: Database.Database, serverId: number): void {
  db.prepare('DELETE FROM library_cache WHERE server_id = ?').run(serverId);
}

// ─── Factory Reset ─────────────────────────────────────────

export function factoryReset(db: Database.Database): void {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM schedule_blocks').run();
    db.prepare('DELETE FROM channels').run();
    db.prepare('DELETE FROM library_cache').run();
    db.prepare('DELETE FROM servers').run();
    db.prepare('DELETE FROM settings').run();

    // Re-insert default settings
    const insertSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?)'
    );
    insertSetting.run('genre_filter', JSON.stringify({ mode: 'allow', genres: [] }));
    insertSetting.run('content_types', JSON.stringify({ movies: true, tv_shows: true }));
    insertSetting.run('schedule_block_hours', JSON.stringify(8));
  });
  txn();
}
