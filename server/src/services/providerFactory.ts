import type Database from 'better-sqlite3';
import type { MediaProvider } from './MediaProvider.js';
import { JellyfinClient } from './JellyfinClient.js';
import { PlexClient } from './PlexClient.js';
import { getActiveServer } from '../db/queries.js';

/**
 * Create the correct MediaProvider based on the active server's type.
 * Falls back to JellyfinClient if no server is configured yet.
 */
export function createProvider(db: Database.Database): MediaProvider {
  const server = getActiveServer(db);
  if (server?.server_type === 'plex') {
    return new PlexClient(db);
  }
  return new JellyfinClient(db);
}
