import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { WSMessage } from '../types/index.js';

let wssInstance: WebSocketServer | null = null;

export function initWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wssInstance = wss;

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err);
    });

    // Send initial heartbeat
    ws.send(JSON.stringify({ type: 'connected', payload: { timestamp: new Date().toISOString() } }));
  });

  // Heartbeat to keep connections alive
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
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
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
