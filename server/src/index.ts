import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import { metricsRoutes } from './routes/metrics.js';
import { JellyfinClient } from './services/JellyfinClient.js';
import { ScheduleEngine } from './services/ScheduleEngine.js';
import { ChannelManager } from './services/ChannelManager.js';
import { MetricsService } from './services/MetricsService.js';
import { authMiddleware, isAuthEnabled } from './middleware/auth.js';
import * as queries from './db/queries.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.PORT || '3080', 10);

// ─── Security middleware ──────────────────────────────

// Trust proxy when behind reverse proxy (nginx, Caddy, etc.)
if (process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Security headers (relaxed CSP for self-hosted media app)
app.use(helmet({
  contentSecurityPolicy: false, // SPA serves its own assets; CSP managed at proxy layer
  crossOriginEmbedderPolicy: false, // required for HLS video playback
}));

// CORS: restrict to configured origins, or allow all in dev/LAN mode
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : undefined;
app.use(cors(allowedOrigins ? { origin: allowedOrigins } : undefined));

// Body size limit
app.use(express.json({ limit: '1mb' }));

// Global rate limiter: 200 requests per 15 minutes per IP
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

// Stricter rate limit on sensitive/admin endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/servers', strictLimiter);
app.use('/api/settings/factory-reset', strictLimiter);

// ─── Auth middleware ──────────────────────────────────
// When PREVUE_API_KEY is set, all /api/* routes require it
// (except /api/health and /api/auth/status which are public)
app.use('/api', authMiddleware);

// Initialize database
const db = initDatabase();

// Initialize services
const jellyfinClient = new JellyfinClient(db);
const scheduleEngine = new ScheduleEngine(db, jellyfinClient);
const channelManager = new ChannelManager(db, jellyfinClient, scheduleEngine);
const metricsService = new MetricsService(db);

// Initialize WebSocket
const wss = initWebSocket(server);

// Make services available to routes
app.locals.db = db;
app.locals.jellyfinClient = jellyfinClient;
app.locals.scheduleEngine = scheduleEngine;
app.locals.channelManager = channelManager;
app.locals.metricsService = metricsService;
app.locals.wss = wss;

// ─── Public endpoints ─────────────────────────────────

// Auth status (public: exempt from auth middleware)
app.get('/api/auth/status', (_req, res) => {
  res.json({ required: isAuthEnabled() });
});

// Health check (public: exempt from auth middleware)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── API Routes ───────────────────────────────────────
app.use('/api/channels', channelRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/playback', playbackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/metrics', metricsRoutes);

// Proxy routes for Jellyfin streams and images (mounted at /api root)
import { streamRoutes, startTranscodeIdleCleanup } from './routes/stream.js';
app.use('/api', streamRoutes);
startTranscodeIdleCleanup(app);

// Serve static client build in production
const clientDistPath = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDistPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDistPath, 'index.html'));
});

// Start server on all interfaces so other devices on the network can connect
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Prevue] Server running on http://0.0.0.0:${PORT}`);
  if (isAuthEnabled()) {
    console.log('[Prevue] API key authentication is ENABLED');
  } else {
    console.log('[Prevue] API key authentication is DISABLED (set PREVUE_API_KEY to enable)');
  }

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

  startScheduleAutoUpdateJob();
}

function getScheduleAutoUpdateConfig(): { enabled: boolean; hours: number } {
  const enabledRaw = queries.getSetting(db, 'schedule_auto_update_enabled');
  const hoursRaw = queries.getSetting(db, 'schedule_auto_update_hours');

  const enabled = enabledRaw !== false;
  const parsedHours = typeof hoursRaw === 'number' && Number.isFinite(hoursRaw)
    ? Math.floor(hoursRaw)
    : 4;
  const hours = Math.max(1, Math.min(168, parsedHours));

  return { enabled, hours };
}

function startScheduleAutoUpdateJob(): void {
  const pollMs = 60 * 1000; // check config once per minute
  let lastRunAt = Date.now();
  let previousEnabled: boolean | null = null;
  let previousHours: number | null = null;

  setInterval(async () => {
    try {
      const hasServer = jellyfinClient.getActiveServer();
      if (!hasServer) return;

      const { enabled, hours } = getScheduleAutoUpdateConfig();

      // If config changed, log and make next run start from "now"
      if (enabled !== previousEnabled || hours !== previousHours) {
        previousEnabled = enabled;
        previousHours = hours;
        lastRunAt = Date.now();
        console.log(`[Prevue] Schedule auto-update ${enabled ? 'enabled' : 'disabled'} (${hours}h interval)`);
      }

      if (!enabled) return;

      const intervalMs = hours * 60 * 60 * 1000;
      if (Date.now() - lastRunAt < intervalMs) return;

      console.log(`[Prevue] Running scheduled extension (${hours}h interval)...`);
      await scheduleEngine.extendSchedules();
      lastRunAt = Date.now();
    } catch (err) {
      console.error('[Prevue] Schedule extension error:', err);
    }
  }, pollMs);
}
