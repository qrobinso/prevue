import type Database from 'better-sqlite3';
import type { WebSocketServer } from 'ws';
import type { MediaProvider } from '../services/MediaProvider.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { broadcast } from '../websocket/index.js';
import * as queries from '../db/queries.js';

/**
 * Run the standard server setup sequence in the background after a new server is added:
 * sync library → generate default channels → build schedules → broadcast completion.
 *
 * Returns immediately; all work is fire-and-forget inside an async IIFE.
 */
export function runServerSetup(
  provider: MediaProvider,
  channelManager: ChannelManager,
  scheduleEngine: ScheduleEngine,
  wss: WebSocketServer,
  db: Database.Database,
  providerLabel: string,
): void {
  (async () => {
    try {
      console.log(`[Servers] Starting background sync for new ${providerLabel} server...`);
      broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message: `Syncing library from ${providerLabel}...` } });

      await provider.syncLibrary((message) => {
        broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message } });
      });
      queries.setSetting(db, 'last_library_sync', new Date().toISOString());

      broadcast(wss, { type: 'generation:progress', payload: { step: 'generating', message: 'Generating default channels...' } });
      const defaultPresets = ['auto-genres'];
      queries.setSetting(db, 'selected_presets', defaultPresets);
      await channelManager.generateChannelsFromPresets(defaultPresets);

      broadcast(wss, { type: 'generation:progress', payload: { step: 'scheduling', message: 'Building schedules...' } });
      await scheduleEngine.generateAllSchedules();

      broadcast(wss, { type: 'generation:progress', payload: { step: 'complete', message: 'Setup complete!' } });
      broadcast(wss, { type: 'library:synced', payload: { item_count: provider.getLibraryItems().length } });
      broadcast(wss, { type: 'channels:regenerated', payload: {} });
      console.log(`[Servers] ${providerLabel} background sync complete`);
    } catch (err) {
      console.error(`[Servers] ${providerLabel} background sync failed:`, err);
      broadcast(wss, { type: 'generation:progress', payload: { step: 'error', message: (err as Error).message } });
    }
  })();
}
