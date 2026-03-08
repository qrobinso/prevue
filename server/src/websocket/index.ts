import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { WSMessage } from '../types/index.js';
import { isAuthEnabled, validateApiKey } from '../middleware/auth.js';

let wssInstance: WebSocketServer | null = null;

export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wssInstance = wss;

  wss.on('connection', (ws, req: IncomingMessage) => {
    // Mark connection as alive for ping/pong zombie detection
    const wsExt = ws as WebSocket & { isAlive: boolean; authenticated: boolean };
    wsExt.isAlive = true;
    wsExt.authenticated = !isAuthEnabled(); // auto-authenticated when auth is disabled
    ws.on('pong', () => { wsExt.isAlive = true; });

    // When auth is enabled, require authentication via first message or query param.
    // First-message auth is preferred (avoids leaking key in URL/logs).
    // Query param auth is still supported for backwards compatibility with IPTV clients.
    if (isAuthEnabled()) {
      // Check query param for backwards compatibility
      try {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const key = url.searchParams.get('api_key');
        if (key && validateApiKey(key)) {
          wsExt.authenticated = true;
        }
      } catch { /* ignore parse errors */ }

      if (!wsExt.authenticated) {
        // Wait for auth message — auto-close after 5s if not authenticated
        const authTimeout = setTimeout(() => {
          if (!wsExt.authenticated) {
            ws.close(4001, 'Unauthorized');
          }
        }, 5000);

        ws.once('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'auth' && typeof msg.api_key === 'string' && validateApiKey(msg.api_key)) {
              wsExt.authenticated = true;
              clearTimeout(authTimeout);
              ws.send(JSON.stringify({ type: 'connected', payload: { timestamp: new Date().toISOString() } }));
            } else {
              clearTimeout(authTimeout);
              ws.close(4001, 'Unauthorized');
            }
          } catch {
            clearTimeout(authTimeout);
            ws.close(4001, 'Unauthorized');
          }
        });
        return; // Don't send 'connected' yet — wait for auth
      }
    }

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err);
    });

    // Send initial heartbeat (only when already authenticated)
    ws.send(JSON.stringify({ type: 'connected', payload: { timestamp: new Date().toISOString() } }));
  });

  // Heartbeat: send data heartbeat + ping/pong to detect zombie connections
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const wsAlive = ws as WebSocket & { isAlive: boolean };
      // Terminate zombie connections that didn't respond to last ping
      if (wsAlive.isAlive === false) {
        console.log('[WS] Terminating zombie connection');
        return ws.terminate();
      }
      wsAlive.isAlive = false;
      ws.ping();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat', payload: { timestamp: new Date().toISOString() } }));
      }
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}

export function broadcast(wss: WebSocketServer, message: WSMessage): void {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    const wsExt = client as WebSocket & { authenticated?: boolean };
    if (client.readyState === WebSocket.OPEN && wsExt.authenticated !== false) {
      client.send(data);
    }
  });
}
