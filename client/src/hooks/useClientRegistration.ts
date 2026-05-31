import { useEffect } from 'react';
import { metricsRegister } from '../services/api';
import { getClientId } from '../services/clientIdentity';
import { getClientDisplayName, getClientPlatform } from '../utils/clientDisplay';
import { wsClient } from '../services/websocket';

const REGISTER_INTERVAL_MS = 15 * 60 * 1000;

/** Register this browser/device with metrics on load and periodically while open. */
export function useClientRegistration(): void {
  useEffect(() => {
    const register = () => {
      metricsRegister({
        client_id: getClientId(),
        display_name: getClientDisplayName(),
        platform: getClientPlatform(),
      }).catch(() => {});
    };

    register();
    const interval = setInterval(register, REGISTER_INTERVAL_MS);
    const unsub = wsClient.onConnected(register);

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, []);
}
