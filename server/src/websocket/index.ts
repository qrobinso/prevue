import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type { WSMessage } from '../types/index.js';
import { isAuthEnabled, validateApiKey } from '../middleware/auth.js';
import type { MetricsService } from '../services/MetricsService.js';

let wssInstance: WebSocketServer | null = null;

type WsClient = WebSocket & {
  isAlive: boolean;
  authenticated: boolean;
  metricsClientId?: string;
};

function handleClientRegister(
  metricsService: MetricsService | undefined,
  ws: WsClient,
  payload: Record<string, unknown>
): void {
  const clientId = payload.client_id;
  if (typeof clientId !== 'string' || !clientId) return;

  ws.metricsClientId = clientId;
  if (!metricsService) return;

  metricsService.registerClient({
    client_id: clientId,
    display_name: typeof payload.display_name === 'string' ? payload.display_name : undefined,
    platform: typeof payload.platform === 'string' ? payload.platform : undefined,
    via_websocket: true,
  });
}

function parseWsPayload(data: Buffer | ArrayBuffer | Buffer[]): {
  type?: string;
  api_key?: string;
  payload?: Record<string, unknown>;
  client_id?: string;
  display_name?: string;
  platform?: string;
} | null {
  try {
    return JSON.parse(data.toString()) as {
      type?: string;
      api_key?: string;
      payload?: Record<string, unknown>;
      client_id?: string;
      display_name?: string;
      platform?: string;
    };
  } catch {
    return null;
  }
}

export function initWebSocket(server: Server, metricsService?: MetricsService): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wssInstance = wss;

  wss.on('connection', (ws, req: IncomingMessage) => {
    const wsExt = ws as WsClient;
    wsExt.isAlive = true;
    wsExt.authenticated = !isAuthEnabled();
    ws.on('pong', () => { wsExt.isAlive = true; });

    if (isAuthEnabled()) {
      try {
        const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        const key = url.searchParams.get('api_key');
        if (key && validateApiKey(key)) {
          wsExt.authenticated = true;
        }
      } catch { /* ignore parse errors */ }

      if (!wsExt.authenticated) {
        const authTimeout = setTimeout(() => {
          if (!wsExt.authenticated) {
            ws.close(4001, 'Unauthorized');
          }
        }, 5000);

        ws.on('message', (data) => {
          const msg = parseWsPayload(data);
          if (!msg) return;

          if (!wsExt.authenticated) {
            if (msg.type === 'auth' && typeof msg.api_key === 'string' && validateApiKey(msg.api_key)) {
              wsExt.authenticated = true;
              clearTimeout(authTimeout);
              ws.send(JSON.stringify({ type: 'connected', payload: { timestamp: new Date().toISOString() } }));
            } else {
              clearTimeout(authTimeout);
              ws.close(4001, 'Unauthorized');
            }
            return;
          }

          if (msg.type === 'client_register') {
            handleClientRegister(metricsService, wsExt, msg.payload ?? msg);
          }
        });
      } else {
        ws.on('message', (data) => {
          const msg = parseWsPayload(data);
          if (!msg || msg.type !== 'client_register') return;
          handleClientRegister(metricsService, wsExt, msg.payload ?? msg);
        });
      }
    } else {
      ws.on('message', (data) => {
        const msg = parseWsPayload(data);
        if (!msg || msg.type !== 'client_register') return;
        handleClientRegister(metricsService, wsExt, msg.payload ?? msg);
      });
    }

    ws.on('close', () => {
      if (wsExt.metricsClientId && metricsService) {
        metricsService.setClientOnline(wsExt.metricsClientId, false);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err);
    });

    if (wsExt.authenticated) {
      ws.send(JSON.stringify({ type: 'connected', payload: { timestamp: new Date().toISOString() } }));
    }
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      const wsAlive = ws as WsClient;
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
    const wsExt = client as WsClient;
    if (client.readyState === WebSocket.OPEN && wsExt.authenticated !== false) {
      client.send(data);
    }
  });
}
