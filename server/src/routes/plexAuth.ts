import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as queries from '../db/queries.js';
import type { MediaProvider } from '../services/MediaProvider.js';
import type { ChannelManager } from '../services/ChannelManager.js';
import type { ScheduleEngine } from '../services/ScheduleEngine.js';
import { validateExternalUrl } from '../utils/urlValidation.js';
import { runServerSetup } from '../utils/serverSetup.js';

export const plexAuthRoutes = Router();

const PLEX_TV_URL = 'https://plex.tv';
export const PLEX_PRODUCT = 'Prevue';
export const PLEX_VERSION = '1.0.0';

// POST /plex/pin - Request a new Plex PIN for QR code auth
plexAuthRoutes.post('/pin', async (_req: Request, res: Response) => {
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

// POST /plex/pin/:pinId/check - Poll to check if PIN was authorized
plexAuthRoutes.post('/pin/:pinId/check', async (req: Request, res: Response) => {
  try {
    const pinIdRaw = parseInt(req.params.pinId as string, 10);
    if (!Number.isInteger(pinIdRaw) || pinIdRaw <= 0) {
      res.status(400).json({ error: 'Invalid pin ID' });
      return;
    }
    const pinId = String(pinIdRaw);
    const { client_id } = req.body;

    if (!client_id || typeof client_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(client_id)) {
      res.status(400).json({ error: 'Valid client_id (UUID) is required' });
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

// POST /plex/servers - List user's Plex servers after authentication
plexAuthRoutes.post('/servers', async (req: Request, res: Response) => {
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

// POST /plex/connect - Connect to a selected Plex server
plexAuthRoutes.post('/connect', async (req: Request, res: Response) => {
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
      const provider = req.app.locals.mediaProvider as MediaProvider;
      const { triggerIconicSceneGeneration: triggerIconic } = req.app.locals;
      runServerSetup(
        provider,
        channelManager as ChannelManager,
        scheduleEngine as ScheduleEngine,
        wss,
        db,
        'Plex',
        typeof triggerIconic === 'function' ? triggerIconic : undefined,
      );
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
