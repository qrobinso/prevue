import { Router } from 'express';
import type { Request, Response } from 'express';
import dgram from 'node:dgram';
import os from 'node:os';
import * as queries from '../db/queries.js';
import type { JellyfinClient } from '../services/JellyfinClient.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { broadcast } from '../websocket/index.js';

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
    const { db, jellyfinClient, channelManager, scheduleEngine, wss } = req.app.locals;
    const { name, url, username, password } = req.body;

    if (!name || !url || !username || password === undefined) {
      res.status(400).json({ error: 'name, url, username, and password are required' });
      return;
    }

    const jf = jellyfinClient as JellyfinClient;

    // Test connection first (public endpoint, no auth needed)
    const connected = await jf.testConnection(url);
    if (!connected) {
      res.status(400).json({ error: 'Could not connect to Jellyfin server' });
      return;
    }

    // Authenticate with username/password to get access token
    let accessToken: string;
    let userId: string;
    try {
      const authResult = await jf.authenticate(url, username, password);
      accessToken = authResult.accessToken;
      userId = authResult.userId;
    } catch (authErr) {
      res.status(401).json({ error: (authErr as Error).message });
      return;
    }

    // Store server with access token
    const server = queries.createServer(db, name, url, username, accessToken, userId);

    // Reset API to pick up new credentials
    jf.resetApi();

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
          
          await jf.syncLibrary((message) => {
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
          broadcast(wss, { type: 'library:synced', payload: { item_count: jf.getLibraryItems().length } });
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
    const { db, jellyfinClient } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
    const { name, url, username, password } = req.body;

    const existing = queries.getServerById(db, id);
    if (!existing) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    const jf = jellyfinClient as JellyfinClient;
    const updateData: Parameters<typeof queries.updateServer>[2] = {};

    if (name !== undefined) updateData.name = name;
    if (url !== undefined) updateData.url = url;
    if (username !== undefined) updateData.username = username;

    // If password is provided, re-authenticate to get new access token
    if (password !== undefined) {
      const serverUrl = url || existing.url;
      const serverUsername = username || existing.username;

      try {
        const authResult = await jf.authenticate(serverUrl, serverUsername, password);
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
      jf.resetApi();
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
    const { db, jellyfinClient, wss } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);

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
      (jellyfinClient as JellyfinClient).resetApi();
      (jellyfinClient as JellyfinClient).clearLibrary();
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
    const { db, jellyfinClient } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);

    const server = queries.getServerById(db, id);
    if (!server) {
      res.status(404).json({ error: 'Server not found' });
      return;
    }

    const jf = jellyfinClient as JellyfinClient;
    // Test basic connectivity (uses public endpoint)
    const connected = await jf.testConnection(server.url);

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
    const { db, jellyfinClient } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);
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

    const jf = jellyfinClient as JellyfinClient;

    try {
      const authResult = await jf.authenticate(server.url, server.username, password);
      queries.updateServer(db, id, {
        access_token: authResult.accessToken,
        user_id: authResult.userId,
      });

      // Reset API to pick up new credentials if this is the active server
      if (server.is_active) {
        jf.resetApi();
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
    const { db, jellyfinClient, channelManager, scheduleEngine, wss } = req.app.locals;
    const id = parseInt(req.params.id as string, 10);

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

    // Reset API and re-sync with new active server
    const jf = jellyfinClient as JellyfinClient;
    jf.resetApi();
    await jf.syncLibrary();
    await (channelManager as ChannelManager).autoGenerateChannels();
    await (scheduleEngine as ScheduleEngine).generateAllSchedules();
    broadcast(wss, { type: 'library:synced', payload: { item_count: jf.getLibraryItems().length } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
