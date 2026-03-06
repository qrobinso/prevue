import { Router } from 'express';
import type { Request, Response } from 'express';
import dgram from 'node:dgram';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as queries from '../db/queries.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { broadcast } from '../websocket/index.js';
import { validateExternalUrl } from '../utils/urlValidation.js';
import { JellyfinClient } from '../services/JellyfinClient.js';

export const serverRoutes = Router();

// ─── Discovery helpers ───────────────────────────────

interface DiscoveredServer {
  id: string;
  name: string;
  address: string;
}

/** Probe a single URL via Jellyfin's unauthenticated public info endpoint */
async function httpProbe(baseUrl: string): Promise<DiscoveredServer | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${baseUrl}/System/Info/Public`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json() as Record<string, unknown>;
    return {
      id: (data.Id as string) || '',
      name: (data.ServerName as string) || 'Jellyfin Server',
      address: baseUrl,
    };
  } catch {
    return null;
  }
}

/** Get local IPv4 subnet prefixes (e.g. ["192.168.1."]) */
function getLocalSubnets(): { prefix: string; ownIp: string }[] {
  const interfaces = os.networkInterfaces();
  const subnets: { prefix: string; ownIp: string }[] = [];
  const seenPrefixes = new Set<string>();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const parts = addr.address.split('.');
        const prefix = `${parts[0]}.${parts[1]}.${parts[2]}.`;
        if (!seenPrefixes.has(prefix)) {
          seenPrefixes.add(prefix);
          subnets.push({ prefix, ownIp: addr.address });
        }
      }
    }
  }
  return subnets;
}

/** Run UDP broadcast discovery (Jellyfin native protocol on port 7359) */
function udpDiscover(): Promise<DiscoveredServer[]> {
  return new Promise((resolve) => {
    const found: DiscoveredServer[] = [];
    const seen = new Set<string>();

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const message = Buffer.from('Who is JellyfinServer?');

    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        const key = data.Id || data.Address;
        if (data.Address && !seen.has(key)) {
          seen.add(key);
          found.push({
            id: data.Id || '',
            name: data.Name || 'Jellyfin Server',
            address: data.Address,
          });
        }
      } catch { /* ignore */ }
    });

    socket.on('error', () => {
      try { socket.close(); } catch { /* ignore */ }
      resolve(found);
    });

    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(message, 0, message.length, 7359, '255.255.255.255');
    });

    setTimeout(() => {
      try { socket.close(); } catch { /* ignore */ }
      resolve(found);
    }, 3000);
  });
}

/** Run HTTP-based discovery by probing known IPs on Jellyfin default ports */
async function httpDiscover(): Promise<DiscoveredServer[]> {
  const PORTS = [8096, 8920];
  const probes: Promise<DiscoveredServer | null>[] = [];

  // Always probe localhost
  for (const port of PORTS) {
    probes.push(httpProbe(`http://localhost:${port}`));
    probes.push(httpProbe(`http://127.0.0.1:${port}`));
  }

  // Probe all IPs on local subnets
  const subnets = getLocalSubnets();
  for (const { prefix } of subnets) {
    for (let i = 1; i <= 254; i++) {
      const ip = `${prefix}${i}`;
      for (const port of PORTS) {
        probes.push(httpProbe(`http://${ip}:${port}`));
      }
    }
  }

  const results = await Promise.allSettled(probes);
  return results
    .filter((r): r is PromiseFulfilledResult<DiscoveredServer> =>
      r.status === 'fulfilled' && r.value !== null
    )
    .map(r => r.value);
}

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
      // Do the heavy lifting in the background (don't block the response)
      (async () => {
        try {
          console.log('[Servers] Starting background sync for new server...');
          broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message: 'Syncing library from Jellyfin...' } });
          
          await provider.syncLibrary((message) => {
            broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message } });
          });
          
          // Auto-generate genre channels for new users by default
          broadcast(wss, { type: 'generation:progress', payload: { step: 'generating', message: 'Generating default channels...' } });
          const defaultPresets = ['auto-genres'];
          queries.setSetting(db, 'selected_presets', defaultPresets);
          await (channelManager as ChannelManager).generateChannelsFromPresets(defaultPresets);
          
          broadcast(wss, { type: 'generation:progress', payload: { step: 'scheduling', message: 'Building schedules...' } });
          await (scheduleEngine as ScheduleEngine).generateAllSchedules();
          
          broadcast(wss, { type: 'generation:progress', payload: { step: 'complete', message: 'Setup complete!' } });
          broadcast(wss, { type: 'library:synced', payload: { item_count: provider.getLibraryItems().length } });
          broadcast(wss, { type: 'channels:regenerated', payload: {} });
          console.log('[Servers] Background sync complete');
        } catch (bgErr) {
          console.error('[Servers] Background sync failed:', bgErr);
          broadcast(wss, { type: 'generation:progress', payload: { step: 'error', message: (bgErr as Error).message } });
        }
      })();
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
        const authResult = await (provider as JellyfinClient).authenticate(serverUrl, serverUsername, password);
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
      const authResult = await (provider as JellyfinClient).authenticate(server.url, server.username, password);
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

// ═══════════════════════════════════════════════════════
// Plex PIN-based Authentication Routes
// ═══════════════════════════════════════════════════════

const PLEX_TV_URL = 'https://plex.tv';
const PLEX_PRODUCT = 'Prevue';
const PLEX_VERSION = '1.0.0';

// POST /api/servers/plex/pin - Request a new Plex PIN for QR code auth
serverRoutes.post('/plex/pin', async (_req: Request, res: Response) => {
  try {
    const clientId = randomUUID();
    const response = await fetch(`${PLEX_TV_URL}/api/v2/pins?strong=true`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Plex-Product': PLEX_PRODUCT,
        'X-Plex-Version': PLEX_VERSION,
        'X-Plex-Client-Identifier': clientId,
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: 'Failed to request PIN from Plex' });
      return;
    }

    const data = await response.json() as { id: number; code: string };
    const authUrl = `https://app.plex.tv/auth#?clientID=${clientId}&code=${data.code}&context%5Bdevice%5D%5Bproduct%5D=${PLEX_PRODUCT}`;

    res.json({
      pin_id: data.id,
      pin_code: data.code,
      client_id: clientId,
      auth_url: authUrl,
    });
  } catch (err) {
    console.error('[Plex] PIN request failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/plex/pin/:pinId/check - Poll to check if PIN was authorized
serverRoutes.post('/plex/pin/:pinId/check', async (req: Request, res: Response) => {
  try {
    const pinId = req.params.pinId;
    const { client_id } = req.body;

    if (!client_id) {
      res.status(400).json({ error: 'client_id is required' });
      return;
    }

    const response = await fetch(`${PLEX_TV_URL}/api/v2/pins/${pinId}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Plex-Product': PLEX_PRODUCT,
        'X-Plex-Version': PLEX_VERSION,
        'X-Plex-Client-Identifier': client_id,
      },
    });

    if (!response.ok) {
      console.error(`[Plex] PIN check returned ${response.status}`);
      res.status(502).json({ error: 'Failed to check PIN status' });
      return;
    }

    const data = await response.json() as Record<string, unknown>;
    // Plex API may return the token as "authToken" or "auth_token"
    const token = (data.authToken ?? data.auth_token ?? null) as string | null;

    if (token) {
      console.log('[Plex] PIN authorized, token received');
      res.json({ authorized: true, auth_token: token });
    } else {
      res.json({ authorized: false });
    }
  } catch (err) {
    console.error('[Plex] PIN check failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/plex/servers - List user's Plex servers after authentication
serverRoutes.post('/plex/servers', async (req: Request, res: Response) => {
  try {
    const { auth_token, client_id } = req.body;

    if (!auth_token || !client_id) {
      res.status(400).json({ error: 'auth_token and client_id are required' });
      return;
    }

    const response = await fetch(`${PLEX_TV_URL}/api/v2/resources?includeHttps=1&includeRelay=1`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Plex-Token': auth_token,
        'X-Plex-Client-Identifier': client_id,
      },
    });

    if (!response.ok) {
      res.status(502).json({ error: 'Failed to fetch Plex servers' });
      return;
    }

    const resources = await response.json() as Array<{
      name: string;
      provides: string;
      publicAddress?: string;
      connections: Array<{
        protocol: string;
        address: string;
        port: number;
        uri: string;
        local: boolean;
        relay: boolean;
      }>;
    }>;

    // Filter to only PMS (Plex Media Server) resources
    const servers = resources
      .filter(r => r.provides.includes('server'))
      .map(r => {
        // Pick the best connection: prefer local HTTPS, then local HTTP, then remote
        const connections = r.connections || [];
        const localHttps = connections.find(c => c.local && c.protocol === 'https');
        const localHttp = connections.find(c => c.local && c.protocol === 'http');
        const remoteHttps = connections.find(c => !c.local && !c.relay && c.protocol === 'https');
        const relay = connections.find(c => c.relay);
        const best = localHttps || localHttp || remoteHttps || relay || connections[0];

        return {
          name: r.name,
          url: best?.uri || '',
          is_local: best?.local ?? false,
          is_relay: best?.relay ?? false,
          connections: connections.map(c => ({
            uri: c.uri,
            local: c.local,
            relay: c.relay,
          })),
        };
      })
      .filter(s => s.url);

    res.json(servers);
  } catch (err) {
    console.error('[Plex] Server list failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/servers/plex/connect - Connect to a selected Plex server
serverRoutes.post('/plex/connect', async (req: Request, res: Response) => {
  try {
    const { db, channelManager, scheduleEngine, wss } = req.app.locals;
    const { name, url, auth_token, client_id } = req.body;

    if (!name || !url || !auth_token || !client_id) {
      res.status(400).json({ error: 'name, url, auth_token, and client_id are required' });
      return;
    }

    // SSRF protection
    const urlCheck = validateExternalUrl(url);
    if (!urlCheck.valid) {
      res.status(400).json({ error: urlCheck.error });
      return;
    }

    // Test connection to the Plex server
    try {
      const testResponse = await fetch(`${url.replace(/\/$/, '')}/identity`, {
        headers: {
          Accept: 'application/json',
          'X-Plex-Token': auth_token,
          'X-Plex-Client-Identifier': client_id,
        },
      });
      if (!testResponse.ok) {
        res.status(400).json({ error: 'Could not connect to Plex server' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Could not connect to Plex server' });
      return;
    }

    // Store server in DB
    const server = queries.createServer(
      db, name, url, '', auth_token, '', 'plex', client_id
    );

    // Swap provider to Plex
    const swapProvider = req.app.locals.swapProvider as (() => void) | undefined;
    if (swapProvider) swapProvider();

    res.status(201).json({
      id: server.id,
      name: server.name,
      url: server.url,
      server_type: 'plex',
      username: '',
      is_active: server.is_active,
      is_authenticated: true,
      created_at: server.created_at,
    });

    // Background sync if this is the active server
    if (server.is_active) {
      (async () => {
        try {
          const provider = req.app.locals.mediaProvider as MediaProvider;
          console.log('[Servers] Starting background sync for new Plex server...');
          broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message: 'Syncing library from Plex...' } });

          await provider.syncLibrary((message) => {
            broadcast(wss, { type: 'generation:progress', payload: { step: 'syncing', message } });
          });

          broadcast(wss, { type: 'generation:progress', payload: { step: 'generating', message: 'Generating default channels...' } });
          const defaultPresets = ['auto-genres'];
          queries.setSetting(db, 'selected_presets', defaultPresets);
          await (channelManager as ChannelManager).generateChannelsFromPresets(defaultPresets);

          broadcast(wss, { type: 'generation:progress', payload: { step: 'scheduling', message: 'Building schedules...' } });
          await (scheduleEngine as ScheduleEngine).generateAllSchedules();

          broadcast(wss, { type: 'generation:progress', payload: { step: 'complete', message: 'Setup complete!' } });
          broadcast(wss, { type: 'library:synced', payload: { item_count: provider.getLibraryItems().length } });
          broadcast(wss, { type: 'channels:regenerated', payload: {} });
          console.log('[Servers] Plex background sync complete');
        } catch (bgErr) {
          console.error('[Servers] Plex background sync failed:', bgErr);
          broadcast(wss, { type: 'generation:progress', payload: { step: 'error', message: (bgErr as Error).message } });
        }
      })();
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
