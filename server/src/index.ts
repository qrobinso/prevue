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
import { createProvider } from './services/providerFactory.js';
import type { MediaProvider } from './services/MediaProvider.js';
import { ScheduleEngine } from './services/ScheduleEngine.js';
import { ChannelManager } from './services/ChannelManager.js';
import { MetricsService } from './services/MetricsService.js';
import { AIService } from './services/AIService.js';
import { IconicSceneService } from './services/IconicSceneService.js';
import { authMiddleware, isAuthEnabled } from './middleware/auth.js';
import { decrypt } from './utils/crypto.js';
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

function isRateLimitExemptPath(pathname: string): boolean {
  return pathname.startsWith('/stream') || pathname.startsWith('/images') || pathname.startsWith('/iptv/channel/');
}

// Global rate limiter: 600 requests per 15 minutes per IP
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => isRateLimitExemptPath(req.path),
}));

// Stricter rate limit on sensitive/admin endpoints
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  // Exempt Plex PIN polling from rate limiting (high-frequency polling during auth)
  skip: (req) => req.path.includes('/plex/pin/') && req.path.endsWith('/check'),
});
app.use('/api/servers', strictLimiter);
app.use('/api/settings/factory-reset', strictLimiter);
app.use('/api/settings/restart', strictLimiter);

// ─── Auth middleware ──────────────────────────────────
// When PREVUE_API_KEY is set, all /api/* routes require it
// (except /api/health and /api/auth/status which are public)
app.use('/api', authMiddleware);

// Initialize database
const db = initDatabase();

// Initialize services
let mediaProvider: MediaProvider = createProvider(db);
const scheduleEngine = new ScheduleEngine(db, mediaProvider);
const channelManager = new ChannelManager(db, mediaProvider, scheduleEngine);
const metricsService = new MetricsService(db);
const aiService = new AIService();
const iconicSceneService = new IconicSceneService(db, aiService);

// Initialize WebSocket
const wss = initWebSocket(server);

// Make services available to routes
app.locals.db = db;
app.locals.mediaProvider = mediaProvider;
app.locals.scheduleEngine = scheduleEngine;
app.locals.channelManager = channelManager;

// Allow routes to swap the provider when the active server type changes
app.locals.swapProvider = () => {
  mediaProvider = createProvider(db);
  app.locals.mediaProvider = mediaProvider;
  scheduleEngine.setProvider(mediaProvider);
  channelManager.setProvider(mediaProvider);
};
app.locals.metricsService = metricsService;
app.locals.iconicSceneService = iconicSceneService;
app.locals.wss = wss;
// Expose iconic scene generation trigger so routes can call it after schedule changes
app.locals.triggerIconicSceneGeneration = () => triggerIconicSceneGeneration().catch(() => {});

// ─── API Documentation (Swagger UI) ──────────────────
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './openapi.js';
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Prevue API Docs',
}));

// ─── Public endpoints ─────────────────────────────────

// Auth status (public: exempt from auth middleware)
app.get('/api/auth/status', (_req, res) => {
  res.json({ required: isAuthEnabled() });
});

// Health check (public: exempt from auth middleware)
app.get('/api/health', (_req, res) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch { /* db unreachable */ }

  const wsClients = wss.clients.size;
  const jellyfinConfigured = !!mediaProvider.getActiveServer();
  const status = dbOk ? 'ok' : 'degraded';

  res.status(dbOk ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    db: dbOk,
    jellyfin_configured: jellyfinConfigured,
    websocket_clients: wsClients,
    active_streams: activeSessions.size,
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

// ─── API Routes ───────────────────────────────────────
app.use('/api/channels', channelRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/playback', playbackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/servers', serverRoutes);
app.use('/api/metrics', metricsRoutes);

import { tickerRoutes } from './routes/ticker.js';
app.use('/api/ticker', tickerRoutes);

// Proxy routes for Jellyfin streams and images (mounted at /api root)
import { streamRoutes, startTranscodeIdleCleanup, activeSessions, lastActivityByItemId } from './routes/stream.js';
import { iptvRoutes } from './routes/iptv.js';
app.use('/api', streamRoutes);
app.use('/api/iptv', iptvRoutes);
startTranscodeIdleCleanup(app);

// Serve background music assets and list available tracks
import fs from 'fs';
// Resolve assets path for both dev (src/) and production (dist/) layouts
const bgMusicPath = fs.existsSync(path.join(__dirname, '../src/assets/backgroundMusic'))
  ? path.join(__dirname, '../src/assets/backgroundMusic')   // dev: running from src/
  : path.join(__dirname, '../assets/backgroundMusic');       // prod: assets copied alongside dist/
app.use('/api/assets/music', express.static(bgMusicPath));
app.get('/api/assets/music-list', (_req, res) => {
  try {
    if (!fs.existsSync(bgMusicPath)) {
      res.json([]);
      return;
    }
    const files = fs.readdirSync(bgMusicPath)
      .filter(f => /\.(mp3|ogg|wav|m4a|aac)$/i.test(f))
      .map(f => `/api/assets/music/${encodeURIComponent(f)}`);
    res.json(files);
  } catch {
    res.json([]);
  }
});

// Serve video assets (interstitial background video, etc.)
const bgVideoPath = fs.existsSync(path.join(__dirname, '../src/assets/video'))
  ? path.join(__dirname, '../src/assets/video')   // dev: running from src/
  : path.join(__dirname, '../assets/video');       // prod: assets copied alongside dist/
app.use('/api/assets/video', express.static(bgVideoPath));

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
    const hasServer = mediaProvider.getActiveServer();
    if (!hasServer) {
      console.log('[Prevue] No media server configured. Waiting for setup...');
      return;
    }

    const providerName = mediaProvider.providerType.charAt(0).toUpperCase() + mediaProvider.providerType.slice(1);
    console.log(`[Prevue] Testing ${providerName} connection...`);
    const connected = await mediaProvider.testConnection();
    if (!connected) {
      console.log(`[Prevue] Could not connect to ${providerName}. Will retry when accessed.`);
      return;
    }

    console.log(`[Prevue] Syncing ${providerName} library...`);
    await mediaProvider.syncLibrary();

    // Only auto-generate channels if none exist (preserve user's preset selections)
    const existingChannels = db.prepare('SELECT COUNT(*) as count FROM channels').get() as { count: number };
    if (existingChannels.count === 0) {
      console.log('[Prevue] No channels found, auto-generating...');
      await channelManager.autoGenerateChannels();
    } else {
      console.log(`[Prevue] Found ${existingChannels.count} existing channels, keeping them.`);
    }

    // Check if schedule blocks exist; if not, do a full regeneration
    const existingBlocks = db.prepare('SELECT COUNT(*) as count FROM schedule_blocks').get() as { count: number };
    if (existingBlocks.count === 0) {
      console.log('[Prevue] No schedule blocks found, generating full schedule...');
      await scheduleEngine.generateAllSchedules();
    } else {
      // Extend schedules to ensure 24 hours of content
      console.log('[Prevue] Extending schedules (ensuring 24h of content)...');
      await scheduleEngine.extendSchedules();
    }

    console.log('[Prevue] Boot sequence complete!');

    // Trigger iconic scene generation in background (non-blocking)
    triggerIconicSceneGeneration().catch(() => {});
  } catch (err) {
    console.error('[Prevue] Boot error:', err);
  }

  // Schedule maintenance: quick check every 15 minutes
  let maintenanceRunning = false;
  const maintenanceId = setInterval(async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      await scheduleEngine.maintainSchedules();
    } catch (err) {
      console.error('[Prevue] Schedule maintenance error:', err);
    } finally {
      maintenanceRunning = false;
    }
  }, 15 * 60 * 1000);
  activeIntervals.push(maintenanceId);

  // Metrics retention: prune old watch data daily (check every 15 min, run once/day)
  let lastRetentionRun = 0;
  const RETENTION_DAYS = 90;
  const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const retentionId = setInterval(() => {
    if (Date.now() - lastRetentionRun < RETENTION_INTERVAL_MS) return;
    lastRetentionRun = Date.now();
    try {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const eventsDeleted = db.prepare('DELETE FROM watch_events WHERE timestamp < ?').run(cutoff);
      const sessionsDeleted = db.prepare('DELETE FROM watch_sessions WHERE started_at < ?').run(cutoff);
      if (eventsDeleted.changes || sessionsDeleted.changes) {
        console.log(`[Prevue] Metrics retention: pruned ${eventsDeleted.changes} events, ${sessionsDeleted.changes} sessions older than ${RETENTION_DAYS} days`);
      }
    } catch (err) {
      console.error('[Prevue] Metrics retention error:', err);
    }
  }, 15 * 60 * 1000);
  activeIntervals.push(retentionId);

  startScheduleAutoUpdateJob();
}

/** Resolve AI API options from user settings (encrypted key + model). */
function getAIOptions(): { apiKey?: string; model?: string } {
  const encrypted = queries.getSetting(db, 'openrouter_api_key') as string | undefined;
  let apiKey: string | undefined;
  if (encrypted) {
    try { apiKey = decrypt(encrypted); } catch { /* ignore */ }
  }
  const model = (queries.getSetting(db, 'openrouter_model') as string) || undefined;
  return { apiKey, model };
}

/**
 * Scan current schedule blocks for movies and trigger iconic scene generation
 * for any uncached movies. Runs in background, non-blocking.
 */
async function triggerIconicSceneGeneration(): Promise<void> {
  const options = getAIOptions();
  if (!aiService.isAvailableWith(options.apiKey)) return;

  const channels = queries.getAllChannels(db);
  const now = new Date().toISOString();
  const movies: { mediaItemId: string; title: string; year: number | null; durationMinutes: number }[] = [];
  const seen = new Set<string>();

  for (const channel of channels) {
    const blocks = queries.getCurrentAndNextBlocks(db, channel.id, now);
    for (const block of blocks) {
      for (const prog of block.programs) {
        if (prog.content_type === 'movie' && !seen.has(prog.media_item_id)) {
          seen.add(prog.media_item_id);
          movies.push({
            mediaItemId: prog.media_item_id,
            title: prog.title,
            year: prog.year,
            durationMinutes: Math.round(prog.duration_ms / 60000),
          });
        }
      }
    }
  }

  if (movies.length > 0) {
    console.log(`[IconicScenes] Generating iconic scenes for ${movies.length} movies...`);
    await iconicSceneService.generateForMovies(movies, options);
    console.log('[IconicScenes] Generation complete.');
  }
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

// Track interval IDs so we can clear them on shutdown
const activeIntervals: ReturnType<typeof setInterval>[] = [];

function startScheduleAutoUpdateJob(): void {
  const pollMs = 60 * 1000; // check config once per minute
  let lastRunAt = Date.now();
  let previousEnabled: boolean | null = null;
  let previousHours: number | null = null;

  const id = setInterval(async () => {
    try {
      const hasServer = mediaProvider.getActiveServer();
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
      // Regenerate iconic scenes for any new movies in the extended schedule
      triggerIconicSceneGeneration().catch(() => {});
    } catch (err) {
      console.error('[Prevue] Schedule extension error:', err);
    }
  }, pollMs);
  activeIntervals.push(id);
}

// ─── Graceful shutdown ──────────────────────────────
async function gracefulShutdown(signal: string) {
  console.log(`[Prevue] ${signal} received — shutting down gracefully...`);

  // Clear all recurring intervals
  for (const id of activeIntervals) clearInterval(id);

  // Stop active Jellyfin transcoding sessions
  for (const [itemId, session] of activeSessions.entries()) {
    try {
      await mediaProvider.stopPlaybackSession(session.playSessionId);
      await mediaProvider.deleteTranscodingJob(session.playSessionId);
    } catch { /* best-effort */ }
    activeSessions.delete(itemId);
    lastActivityByItemId.delete(itemId);
  }

  // Close WebSocket server
  wss.close();

  // Close HTTP server
  server.close(() => {
    // Close database
    db.close();
    console.log('[Prevue] Shutdown complete.');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    console.error('[Prevue] Forced shutdown after timeout.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
