import { Router } from 'express';
import type { Request, Response } from 'express';
import * as queries from '../db/queries.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { broadcast } from '../websocket/index.js';
import { validateExternalUrl } from '../utils/urlValidation.js';
import { JellyfinClient } from '../services/JellyfinClient.js';
import { udpDiscover, httpDiscover } from '../services/JellyfinDiscovery.js';
import type { DiscoveredServer } from '../services/JellyfinDiscovery.js';
import { plexAuthRoutes } from './plexAuth.js';
import { runServerSetup } from '../utils/serverSetup.js';

export const serverRoutes = Router();

// ─── Plex auth sub-routes ─────────────────────────────
serverRoutes.use('/plex', plexAuthRoutes);

// GET /api/servers/discover - Discover Jellyfin servers on the local network
serverRoutes.get('/discover', async (_req: Request, res: Response) => {
  try {
    console.log('[Discovery] Starting network scan...');
    const [udpResults, httpResults] = await Promise.all([
      udpDiscover(),
      httpDiscover(),
    ]);

    // Merge and deduplicate by server ID, then by address
    const seen = new Set<string>();
    const discovered: DiscoveredServer[] = [];

    for (const server of [...udpResults, ...httpResults]) {
      const key = server.id || server.address;
      if (!seen.has(key)) {
        seen.add(key);
        discovered.push(server);
      }
    }

    console.log(`[Discovery] Found ${discovered.length} server(s)`);
    res.json(discovered);
  } catch (err) {
    console.error('[Discovery] Error:', (err as Error).message);
    res.json([]);
  }
});

// GET /api/servers/stats - Library statistics for the active server
serverRoutes.get('/stats', (req: Request, res: Response) => {
  try {
    const { db, mediaProvider } = req.app.locals;
    const provider = mediaProvider as MediaProvider;
    const items = provider.getLibraryItems();
    const movies = items.filter(i => i.Type === 'Movie').length;
    const episodes = items.filter(i => i.Type === 'Episode').length;
    const lastSync = (queries.getSetting(db, 'last_library_sync') as string) || null;
    res.json({ movies, episodes, last_sync: lastSync });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/servers - List all servers
serverRoutes.get('/', (req: Request, res: Response) => {
  try {
    const { db } = req.app.locals;
    const servers = queries.getAllServers(db);
    // Don't expose access tokens - only return safe info
    const safe = servers.map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      server_type: s.server_type || 'jellyfin',
      username: s.username,
      is_active: s.is_active,
      is_authenticated: !!s.access_token,
      created_at: s.created_at,
    }));
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers - Add a server with username/password authentication
serverRoutes.post('/', async (req: Request, res: Response) => {
  try {
    const { db, channelManager, scheduleEngine, wss } = req.app.locals;
    const { name, url, username, password } = req.body;

    if (!name || !url || !username || password === undefined) {
      res.status(400).json({ error: 'name, url, username, and password are required' });
      return;
    }

    // SSRF protection: validate the user-provided URL
    const urlCheck = validateExternalUrl(url);
    if (!urlCheck.valid) {
      res.status(400).json({ error: urlCheck.error });
      return;
    }

    // Use a dedicated JellyfinClient for test/auth — the active provider may be Plex
    const jfTemp = new JellyfinClient(db);

    // Test connection first (public endpoint, no auth needed)
    const connected = await jfTemp.testConnection(url);
    if (!connected) {
      res.status(400).json({ error: 'Could not connect to Jellyfin server' });
      return;
    }

    // Authenticate with username/password to get access token
    let accessToken: string;
    let userId: string;
    try {
      const authResult = await jfTemp.authenticate(url, username, password);
      accessToken = authResult.accessToken;
      userId = authResult.userId;
    } catch (authErr) {
      res.status(401).json({ error: (authErr as Error).message });
      return;
    }

    // Store server with access token
    const server = queries.createServer(db, name, url, username, accessToken, userId);

    // Swap provider so app uses the correct type for the new active server
    const swapProvider = req.app.locals.swapProvider as (() => void) | undefined;
    if (swapProvider) swapProvider();
    const provider = req.app.locals.mediaProvider as MediaProvider;

    // Respond immediately with the server info
    res.status(201).json({
      id: server.id,
      name: server.name,
      url: server.url,
      username: server.username,
      is_active: server.is_active,
      is_authenticated: true,
      created_at: server.created_at,
    });

    // If this is the first/active server, sync and generate in background
    if (server.is_active) {
      runServerSetup(
        provider,
        channelManager as ChannelManager,
        scheduleEngine as ScheduleEngine,
        wss,
        db,
        'Jellyfin',
      );
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/servers/:id - Update server (re-authenticate if password provided)
serverRoutes.put('/:id', async (req: Request, res: Response) => {
  try {
    const { db, mediaProvider } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid server id' }); return; }
    const { name, url, username, password } = req.body;

    const existing = queries.getServerById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    // SSRF protection: validate URL if being updated
    if (url !== undefined) {
      const urlCheck = validateExternalUrl(url);
      if (!urlCheck.valid) {
        res.status(400).json({ error: urlCheck.error });
        return;
      }
    }

    const provider = mediaProvider as MediaProvider;
    const updateData: Parameters<typeof queries.updateServer>[2] = {};

    if (name !== undefined) updateData.name = name;
    if (url !== undefined) updateData.url = url;
    if (username !== undefined) updateData.username = username;

    // If password is provided, re-authenticate to get new access token (Jellyfin only)
    if (password !== undefined) {
      const serverUrl = url || existing.url;
      const serverUsername = username || existing.username;

      try {
        const jfTemp = new JellyfinClient(db);
        const authResult = await jfTemp.authenticate(serverUrl, serverUsername, password);
        updateData.access_token = authResult.accessToken;
        updateData.user_id = authResult.userId;
      } catch (authErr) {
        res.status(401).json({ error: (authErr as Error).message });
        return;
      }
    }

    const server = queries.updateServer(db, id, updateData);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    // Reset API to pick up new credentials if this is the active server
    if (server.is_active) {
      provider.resetApi();
    }

    res.json({
      id: server.id,
      name: server.name,
      url: server.url,
      username: server.username,
      is_active: server.is_active,
      is_authenticated: !!server.access_token,
      created_at: server.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/servers/:id - Remove server and all related data (channels, schedules, library cache)
serverRoutes.delete('/:id', (req: Request, res: Response) => {
  try {
    const { db, mediaProvider, wss } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid server id' }); return; }

    const server = queries.getServerById(db, id);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    const wasActive = !!server.is_active;
    const deleted = queries.deleteServer(db, id);
    if (!deleted) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    if (wasActive) {
      (mediaProvider as MediaProvider).resetApi();
      (mediaProvider as MediaProvider).clearLibrary();
      broadcast(wss, { type: 'channels:regenerated', payload: { count: 0 } });
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/:id/test - Test connection
serverRoutes.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const { db, mediaProvider } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid server id' }); return; }

    const server = queries.getServerById(db, id);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    const provider = mediaProvider as MediaProvider;
    // Test basic connectivity (uses public endpoint)
    const connected = await provider.testConnection(server.url);

    res.json({ 
      connected,
      authenticated: !!server.access_token,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/:id/reauthenticate - Re-authenticate with password (for expired tokens)
serverRoutes.post('/:id/reauthenticate', async (req: Request, res: Response) => {
  try {
    const { db, mediaProvider } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid server id' }); return; }
    const { password } = req.body;

    if (password === undefined) {
      res.status(400).json({ error: 'password is required' });
      return;
    }

    const server = queries.getServerById(db, id);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    const provider = mediaProvider as MediaProvider;

    try {
      const jfTemp = new JellyfinClient(db);
      const authResult = await jfTemp.authenticate(server.url, server.username, password);
      queries.updateServer(db, id, {
        access_token: authResult.accessToken,
        user_id: authResult.userId,
      });

      // Reset API to pick up new credentials if this is the active server
      if (server.is_active) {
        provider.resetApi();
      }

      res.json({ success: true, authenticated: true });
    } catch (authErr) {
      res.status(401).json({ error: (authErr as Error).message });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/:id/activate - Set active server
serverRoutes.post('/:id/activate', async (req: Request, res: Response) => {
  try {
    const { db, mediaProvider, channelManager, scheduleEngine, wss } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid server id' }); return; }

    const server = queries.getServerById(db, id);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    if (!server.access_token) {
      res.status(400).json({ error: 'Server needs re-authentication before activation' });
      return;
    }

    queries.setActiveServer(db, id);

    // Swap provider if server type changed
    const swapProvider = req.app.locals.swapProvider as (() => void) | undefined;
    if (swapProvider) swapProvider();

    // Reset API and re-sync with new active server
    const provider = req.app.locals.mediaProvider as MediaProvider;
    provider.resetApi();
    await provider.syncLibrary();
    queries.setSetting(db, 'last_library_sync', new Date().toISOString());
    await (channelManager as ChannelManager).autoGenerateChannels();
    await (scheduleEngine as ScheduleEngine).generateAllSchedules();
    broadcast(wss, { type: 'library:synced', payload: { item_count: provider.getLibraryItems().length } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/:id/resync - Re-sync active server library and refresh schedules
serverRoutes.post('/:id/resync', async (req: Request, res: Response) => {
  try {
    const { db, mediaProvider, scheduleEngine, wss } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    if (Number.isNaN(id) || id < 1) { res.status(400).json({ error: 'Invalid server id' }); return; }

    const server = queries.getServerById(db, id);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    if (!server.is_active) {
      res.status(400).json({ error: 'Only the active server can be re-synced. Activate this server first.' });
      return;
    }

    if (!server.access_token) {
      res.status(400).json({ error: 'Server needs re-authentication before re-sync' });
      return;
    }

    const provider = mediaProvider as MediaProvider;
    provider.resetApi();

    broadcast(wss, {
      type: 'generation:progress',
      payload: { step: 'syncing', message: 'Re-syncing library from Jellyfin...' },
    });

    await provider.syncLibrary((message) => {
      broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message } });
    });
    queries.setSetting(db, 'last_library_sync', new Date().toISOString());

    broadcast(wss, {
      type: 'generation:progress',
      payload: { step: 'scheduling', message: 'Refreshing schedules...' },
    });
    await (scheduleEngine as ScheduleEngine).generateAllSchedules();

    broadcast(wss, {
      type: 'generation:progress',
      payload: { step: 'complete', message: 'Re-sync complete!' },
    });
    broadcast(wss, { type: 'library:synced', payload: { item_count: provider.getLibraryItems().length } });

    res.json({ success: true, item_count: provider.getLibraryItems().length });
  } catch (err) {
    broadcast(req.app.locals.wss, {
      type: 'generation:progress',
      payload: { step: 'error', message: (err as Error).message },
    });
    res.status(500).json({ error: (err as Error).message });
  }
});

