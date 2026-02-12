import { useEffect } from 'react';
import { wsClient } from '../services/websocket';
import type { WSEvent } from '../types';

export function useWebSocket(onEvent?: (event: WSEvent) => void) {
  useEffect(() => {
    wsClient.connect();

    let unsubscribe: (() => void) | undefined;
    if (onEvent) {
      unsubscribe = wsClient.subscribe(onEvent);
    }

    return () => {
      unsubscribe?.();
    };
  }, [onEvent]);
}
