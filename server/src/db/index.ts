import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let db: Database.Database;

export function initDatabase(): Database.Database {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');

  // Ensure data directory exists
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, 'prevue.db');
  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

function runMigrations(db: Database.Database): void {
  // Create tables with new schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      access_token TEXT,
      user_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_schedule_channel
      ON schedule_blocks(channel_id, block_start);

    CREATE INDEX IF NOT EXISTS idx_channels_number
      ON channels(number);

    CREATE INDEX IF NOT EXISTS idx_library_server
      ON library_cache(server_id);
  `);

  // Insert default settings if not present
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
  );

  insertSetting.run('genre_filter', JSON.stringify({ mode: 'allow', genres: [] }));
  insertSetting.run('content_types', JSON.stringify({ movies: true, tv_shows: true }));
  insertSetting.run('schedule_block_hours', JSON.stringify(8));

  // Migration: Add new columns for username/password auth if they don't exist
  // This handles upgrading from the old api_key-based schema
  migrateServersTable(db);

  // Migration: Add new columns for channel presets if they don't exist
  migrateChannelsTable(db);

  // Cleanup: Remove orphaned library cache entries (where server_id doesn't exist)
  cleanupOrphanedData(db);
}

function cleanupOrphanedData(db: Database.Database): void {
  // Clean up library_cache entries where server_id doesn't exist
  const orphanedCount = db.prepare(`
    DELETE FROM library_cache 
    WHERE server_id NOT IN (SELECT id FROM servers)
  `).run().changes;

  if (orphanedCount > 0) {
    console.log(`[Database] Cleaned up ${orphanedCount} orphaned library cache entries`);
  }
}

function migrateServersTable(db: Database.Database): void {
  // Check if the servers table has the old schema (api_key column)
  const tableInfo = db.prepare("PRAGMA table_info('servers')").all() as { name: string }[];
  const columnNames = tableInfo.map(col => col.name);

  const hasApiKey = columnNames.includes('api_key');
  const hasUsername = columnNames.includes('username');

  // If we have the old api_key column, we need to recreate the table
  // SQLite doesn't support DROP COLUMN, so we recreate the table
  if (hasApiKey) {
    console.log('[Database] Migrating servers table from api_key to username/password auth...');
    console.log('[Database] Old servers will be removed - they need to be re-added with username/password');

    db.exec(`
      -- Disable foreign keys temporarily for migration
      PRAGMA foreign_keys = OFF;

      -- Drop the old table and recreate with new schema
      DROP TABLE IF EXISTS servers;

      CREATE TABLE servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        username TEXT NOT NULL DEFAULT '',
        access_token TEXT,
        user_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Re-enable foreign keys
      PRAGMA foreign_keys = ON;
    `);

    console.log('[Database] Migration complete');
  } else if (!hasUsername) {
    // Table exists but missing username column - add missing columns
    try {
      db.exec("ALTER TABLE servers ADD COLUMN username TEXT NOT NULL DEFAULT ''");
    } catch { /* column may already exist */ }
    try {
      db.exec('ALTER TABLE servers ADD COLUMN access_token TEXT');
    } catch { /* column may already exist */ }
    try {
      db.exec('ALTER TABLE servers ADD COLUMN user_id TEXT');
    } catch { /* column may already exist */ }
  }
}

function migrateChannelsTable(db: Database.Database): void {
  // Check if the channels table has the new columns and correct CHECK constraint
  const tableInfo = db.prepare("PRAGMA table_info('channels')").all() as { name: string }[];
  const columnNames = tableInfo.map(col => col.name);

  const hasPresetId = columnNames.includes('preset_id');
  const hasFilter = columnNames.includes('filter');

  // Also check if the CHECK constraint includes 'preset' by inspecting table schema
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='channels'").get() as { sql: string } | undefined;
  const hasPresetInConstraint = tableSql?.sql?.includes("'preset'") ?? false;

  // If we're missing the new columns OR the CHECK constraint doesn't include 'preset', recreate the table
  // SQLite doesn't allow modifying CHECK constraints, so we recreate
  if (!hasPresetId || !hasFilter || !hasPresetInConstraint) {
    console.log('[Database] Migrating channels table to support presets...');
    
    db.exec(`
      -- Disable foreign keys temporarily for migration
      PRAGMA foreign_keys = OFF;
      
      -- First, delete schedule_blocks that reference channels (will be regenerated)
      DELETE FROM schedule_blocks;

      -- Rename old table
      ALTER TABLE channels RENAME TO channels_old;

      -- Create new table with updated schema
      CREATE TABLE channels (
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

      -- Copy data from old table (if columns exist)
      INSERT INTO channels (id, number, name, type, genre, item_ids, ai_prompt, sort_order, created_at)
      SELECT id, number, name, type, genre, item_ids, ai_prompt, sort_order, created_at FROM channels_old;

      -- Drop old table
      DROP TABLE channels_old;

      -- Recreate indexes
      CREATE INDEX IF NOT EXISTS idx_channels_number ON channels(number);

      -- Re-enable foreign keys
      PRAGMA foreign_keys = ON;
    `);

    console.log('[Database] Channels table migration complete');
  }
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}
