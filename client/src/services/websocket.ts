import type { WSEvent } from '../types';
import { getStoredApiKey } from './api';

type WSEventHandler = (event: WSEvent) => void;

class WebSocketClient {
  private ws: WebSocket | null = null;
  private handlers: Set<WSEventHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private connected = false;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const key = getStoredApiKey();
    const qs = key ? `?api_key=${encodeURIComponent(key)}` : '';
    const url = `${protocol}//${window.location.host}/ws${qs}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connected = true;
        this.reconnectDelay = 1000; // Reset backoff
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // Validate expected shape before dispatching
          if (data && typeof data === 'object' && typeof data.type === 'string') {
            this.handlers.forEach(handler => handler(data as WSEvent));
          }
        } catch {
          // Ignore parse errors (heartbeats etc.)
        }
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  subscribe(handler: WSEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }
}

// Singleton instance
export const wsClient = new WebSocketClient();
