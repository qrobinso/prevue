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
  const server = getServerById(db, id);
  if (!server) return false;

  const wasActive = !!server.is_active;

  const txn = db.transaction(() => {
    // When deleting the active server, remove all channels and schedules (they were built from that server's library)
    if (wasActive) {
      db.prepare('DELETE FROM schedule_blocks').run();
      db.prepare('DELETE FROM channels').run();
    }
    db.prepare('DELETE FROM library_cache WHERE server_id = ?').run(id);
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

export function getChannelByNumber(db: Database.Database, number: number): ChannelParsed | undefined {
  const row = db.prepare('SELECT * FROM channels WHERE number = ?').get(number) as Channel | undefined;
  return row ? parseChannel(row) : undefined;
}

export function getChannelNames(db: Database.Database): string[] {
  const rows = db.prepare('SELECT name FROM channels').all() as { name: string }[];
  return rows.map((r) => r.name);
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

// ─── Channel Schedule Metadata ────────────────────────────

export interface ChannelScheduleMeta {
  channel_id: number;
  schedule_generated_at: string | null;
  schedule_updated_at: string | null;
  block_count: number;
}

/**
 * Get schedule metadata for all channels: earliest and latest created_at
 * from schedule_blocks. "generated_at" = earliest block created_at (first generation),
 * "updated_at" = latest block created_at (most recent regeneration).
 */
export function getScheduleMetaForAllChannels(db: Database.Database): Map<number, ChannelScheduleMeta> {
  const rows = db.prepare(
    `SELECT
       channel_id,
       MIN(created_at) as schedule_generated_at,
       MAX(created_at) as schedule_updated_at,
       COUNT(*) as block_count
     FROM schedule_blocks
     GROUP BY channel_id`
  ).all() as ChannelScheduleMeta[];

  const map = new Map<number, ChannelScheduleMeta>();
  for (const row of rows) {
    map.set(row.channel_id, row);
  }
  return map;
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

/**
 * Get item IDs scheduled for a channel in blocks overlapping a time range.
 * Used to avoid reusing the same programs within a 24-hour period.
 */
export function getItemIdsScheduledInRangeForChannel(
  db: Database.Database,
  channelId: number,
  rangeStart: string,
  rangeEnd: string
): Set<string> {
  const blocks = db.prepare(
    `SELECT * FROM schedule_blocks 
     WHERE channel_id = ? AND block_start < ? AND block_end > ?`
  ).all(channelId, rangeEnd, rangeStart) as ScheduleBlock[];

  const itemIds = new Set<string>();
  for (const block of blocks) {
    const parsed = parseScheduleBlock(block);
    for (const prog of parsed.programs) {
      if (prog.jellyfin_item_id && prog.type !== 'interstitial') {
        itemIds.add(prog.jellyfin_item_id);
      }
    }
  }
  return itemIds;
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

// ─── Metrics: Watch Sessions ──────────────────────────────

export interface WatchSession {
  id: number;
  client_id: string;
  channel_id: number | null;
  channel_name: string | null;
  item_id: string | null;
  title: string | null;
  series_name: string | null;
  content_type: string | null;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number;
  user_agent: string | null;
}

export function createWatchSession(
  db: Database.Database,
  data: {
    client_id: string;
    channel_id?: number;
    channel_name?: string;
    item_id?: string;
    title?: string;
    series_name?: string;
    content_type?: string;
    user_agent?: string;
  }
): WatchSession {
  const result = db.prepare(
    `INSERT INTO watch_sessions (client_id, channel_id, channel_name, item_id, title, series_name, content_type, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.client_id,
    data.channel_id ?? null,
    data.channel_name ?? null,
    data.item_id ?? null,
    data.title ?? null,
    data.series_name ?? null,
    data.content_type ?? null,
    data.user_agent ?? null
  );
  return db.prepare('SELECT * FROM watch_sessions WHERE id = ?').get(result.lastInsertRowid) as WatchSession;
}

export function endWatchSession(db: Database.Database, sessionId: number): void {
  db.prepare(
    `UPDATE watch_sessions
     SET ended_at = datetime('now'),
         duration_seconds = ROUND((julianday(datetime('now')) - julianday(started_at)) * 86400, 1)
     WHERE id = ? AND ended_at IS NULL`
  ).run(sessionId);
}

export function getActiveSessionForClient(
  db: Database.Database,
  clientId: string
): WatchSession | undefined {
  return db.prepare(
    'SELECT * FROM watch_sessions WHERE client_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(clientId) as WatchSession | undefined;
}

export interface WatchEvent {
  id: number;
  client_id: string;
  event_type: string;
  channel_id: number | null;
  channel_name: string | null;
  item_id: string | null;
  title: string | null;
  metadata: string | null;
  created_at: string;
}

export function insertWatchEvent(
  db: Database.Database,
  data: {
    client_id: string;
    event_type: string;
    channel_id?: number;
    channel_name?: string;
    item_id?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  db.prepare(
    `INSERT INTO watch_events (client_id, event_type, channel_id, channel_name, item_id, title, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    data.client_id,
    data.event_type,
    data.channel_id ?? null,
    data.channel_name ?? null,
    data.item_id ?? null,
    data.title ?? null,
    data.metadata ? JSON.stringify(data.metadata) : null
  );
}

export function upsertClient(
  db: Database.Database,
  clientId: string,
  userAgent?: string
): void {
  db.prepare(
    `INSERT INTO client_registry (client_id, user_agent, first_seen, last_seen)
     VALUES (?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(client_id) DO UPDATE SET
       last_seen = datetime('now'),
       user_agent = COALESCE(excluded.user_agent, client_registry.user_agent)`
  ).run(clientId, userAgent ?? null);
}

// ─── Metrics: Aggregated Reads ────────────────────────────

export interface MetricsSummary {
  total_watch_seconds: number;
  total_sessions: number;
  active_clients: number;
}

export function getMetricsSummary(db: Database.Database, since: string): MetricsSummary {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(duration_seconds), 0) as total_watch_seconds,
      COUNT(*) as total_sessions,
      COUNT(DISTINCT client_id) as active_clients
    FROM watch_sessions
    WHERE started_at >= ?
  `).get(since) as MetricsSummary;
  return row;
}

export interface TopChannel {
  channel_id: number;
  channel_name: string;
  total_seconds: number;
  session_count: number;
}

export function getTopChannels(db: Database.Database, since: string, limit: number = 10): TopChannel[] {
  return db.prepare(`
    SELECT
      channel_id,
      channel_name,
      COALESCE(SUM(duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count
    FROM watch_sessions
    WHERE started_at >= ? AND channel_id IS NOT NULL
    GROUP BY channel_id
    ORDER BY total_seconds DESC
    LIMIT ?
  `).all(since, limit) as TopChannel[];
}

export interface TopShow {
  item_id: string;
  title: string;
  content_type: string | null;
  total_seconds: number;
  session_count: number;
}

export function getTopShows(db: Database.Database, since: string, limit: number = 10): TopShow[] {
  return db.prepare(`
    SELECT
      item_id,
      title,
      content_type,
      COALESCE(SUM(duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count
    FROM watch_sessions
    WHERE started_at >= ? AND item_id IS NOT NULL
    GROUP BY item_id
    ORDER BY total_seconds DESC
    LIMIT ?
  `).all(since, limit) as TopShow[];
}

export interface TopSeries {
  series_name: string;
  total_seconds: number;
  session_count: number;
  episode_count: number;
}

export function getTopSeries(db: Database.Database, since: string, limit: number = 10): TopSeries[] {
  return db.prepare(`
    SELECT
      series_name,
      COALESCE(SUM(duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count,
      COUNT(DISTINCT item_id) as episode_count
    FROM watch_sessions
    WHERE started_at >= ? AND series_name IS NOT NULL AND series_name != ''
    GROUP BY series_name
    ORDER BY total_seconds DESC
    LIMIT ?
  `).all(since, limit) as TopSeries[];
}

export interface TopClient {
  client_id: string;
  user_agent: string | null;
  total_seconds: number;
  session_count: number;
  last_seen: string | null;
}

export function getTopClients(db: Database.Database, since: string, limit: number = 10): TopClient[] {
  return db.prepare(`
    SELECT
      ws.client_id,
      cr.user_agent,
      COALESCE(SUM(ws.duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count,
      cr.last_seen
    FROM watch_sessions ws
    LEFT JOIN client_registry cr ON ws.client_id = cr.client_id
    WHERE ws.started_at >= ?
    GROUP BY ws.client_id
    ORDER BY total_seconds DESC
    LIMIT ?
  `).all(since, limit) as TopClient[];
}

export interface HourlyActivity {
  hour: number;
  total_seconds: number;
  session_count: number;
}

export function getHourlyActivity(db: Database.Database, since: string): HourlyActivity[] {
  return db.prepare(`
    SELECT
      CAST(strftime('%H', started_at) AS INTEGER) as hour,
      COALESCE(SUM(duration_seconds), 0) as total_seconds,
      COUNT(*) as session_count
    FROM watch_sessions
    WHERE started_at >= ?
    GROUP BY hour
    ORDER BY hour
  `).all(since) as HourlyActivity[];
}

export function getRecentSessions(db: Database.Database, limit: number = 20): WatchSession[] {
  return db.prepare(
    'SELECT * FROM watch_sessions ORDER BY started_at DESC LIMIT ?'
  ).all(limit) as WatchSession[];
}

export function clearMetricsData(db: Database.Database): void {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM watch_sessions').run();
    db.prepare('DELETE FROM watch_events').run();
    db.prepare('DELETE FROM client_registry').run();
  });
  txn();
}

// ─── Factory Reset ─────────────────────────────────────────

export function factoryReset(db: Database.Database): void {
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM schedule_blocks').run();
    db.prepare('DELETE FROM channels').run();
    db.prepare('DELETE FROM library_cache').run();
    db.prepare('DELETE FROM servers').run();
    db.prepare('DELETE FROM settings').run();
    db.prepare('DELETE FROM watch_sessions').run();
    db.prepare('DELETE FROM watch_events').run();
    db.prepare('DELETE FROM client_registry').run();

    // Re-insert default settings
    const insertSetting = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?)'
    );
    insertSetting.run('genre_filter', JSON.stringify({ mode: 'allow', genres: [] }));
    insertSetting.run('content_types', JSON.stringify({ movies: true, tv_shows: true }));
    insertSetting.run('schedule_block_hours', JSON.stringify(8));
    insertSetting.run('schedule_auto_update_enabled', JSON.stringify(true));
    insertSetting.run('schedule_auto_update_hours', JSON.stringify(4));
    insertSetting.run('share_playback_progress', JSON.stringify(false));
    insertSetting.run('metrics_enabled', JSON.stringify(true));
  });
  txn();
}
