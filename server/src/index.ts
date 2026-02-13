import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { initDatabase } from './db/index.js';
import { initWebSocket } from './websocket/index.js';
import { channelRoutes } from './routes/channels.js';
import { scheduleRoutes } from './routes/schedule.js';
import { playbackRoutes } from './routes/playback.js';
import { settingsRoutes } from './routes/settings.js';
import { serverRoutes } from './routes/servers.js';
import { JellyfinClient } from './services/JellyfinClient.js';
import { ScheduleEngine } from './services/ScheduleEngine.js';
import { ChannelManager } from './services/ChannelManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.PORT || '3080', 10);

// Middleware
app.use(cors());
app.use(express.json());

// Initialize database
const db = initDatabase();

// Initialize services
const jellyfinClient = new JellyfinClient(db);
const scheduleEngine = new ScheduleEngine(db, jellyfinClient);
const channelManager = new ChannelManager(db, jellyfinClient, scheduleEngine);

// Initialize WebSocket
const wss = initWebSocket(server);

// Make services available to routes
app.locals.db = db;
app.locals.jellyfinClient = jellyfinClient;
app.locals.scheduleEngine = scheduleEngine;
app.locals.channelManager = channelManager;
app.locals.wss = wss;

// API Routes
app.use('/api/channels', channelRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/playback', playbackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/servers', serverRoutes);

// Proxy routes for Jellyfin streams and images (mounted at /api root)
import { streamRoutes, startTranscodeIdleCleanup } from './routes/stream.js';
app.use('/api', streamRoutes);
startTranscodeIdleCleanup(app);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static client build in production
const clientDistPath = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Start server on all interfaces so other devices on the network can connect
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Prevue] Server running on http://0.0.0.0:${PORT}`);

  // Boot sequence: sync library and generate channels/schedules
  bootSequence().catch(err => {
    console.error('[Prevue] Boot sequence error:', err);
  });
});

async function bootSequence() {
  try {
    const hasServer = jellyfinClient.getActiveServer();
    if (!hasServer) {
      console.log('[Prevue] No Jellyfin server configured. Waiting for setup...');
      return;
    }

    console.log('[Prevue] Testing Jellyfin connection...');
    const connected = await jellyfinClient.testConnection();
    if (!connected) {
      console.log('[Prevue] Could not connect to Jellyfin. Will retry when accessed.');
      return;
    }

    console.log('[Prevue] Syncing Jellyfin library...');
    await jellyfinClient.syncLibrary();

    // Only auto-generate channels if none exist (preserve user's preset selections)
    const existingChannels = db.prepare('SELECT COUNT(*) as count FROM channels').get() as { count: number };
    if (existingChannels.count === 0) {
      console.log('[Prevue] No channels found, auto-generating...');
      await channelManager.autoGenerateChannels();
    } else {
      console.log(`[Prevue] Found ${existingChannels.count} existing channels, keeping them.`);
    }

    // Extend schedules to ensure 24 hours of content
    console.log('[Prevue] Extending schedules (ensuring 24h of content)...');
    await scheduleEngine.extendSchedules();

    console.log('[Prevue] Boot sequence complete!');
  } catch (err) {
    console.error('[Prevue] Boot error:', err);
  }

  // Schedule maintenance: quick check every 15 minutes
  setInterval(async () => {
    try {
      await scheduleEngine.maintainSchedules();
    } catch (err) {
      console.error('[Prevue] Schedule maintenance error:', err);
    }
  }, 15 * 60 * 1000);

  // Schedule extension: ensure 24h of content every 4 hours
  setInterval(async () => {
    try {
      const hasServer = jellyfinClient.getActiveServer();
      if (!hasServer) return;
      console.log('[Prevue] Running 4-hour schedule extension...');
      await scheduleEngine.extendSchedules();
    } catch (err) {
      console.error('[Prevue] Schedule extension error:', err);
    }
  }, 4 * 60 * 60 * 1000);
}
