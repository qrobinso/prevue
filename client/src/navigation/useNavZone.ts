import { useEffect, useRef } from 'react';
import { useNavigation, type ZoneConfig } from './NavigationContext';

/**
 * Register a navigation zone. The zone is added on mount and removed on unmount.
 * The config is kept up-to-date via a ref so handler changes don't cause re-subscriptions.
 */
export function useNavZone(config: ZoneConfig): void {
  const { registerZone, unregisterZone } = useNavigation();
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    // Wrap config so the registered handlers always call the latest version
    const proxy: ZoneConfig = {
      get id() { return configRef.current.id; },
      onArrow: (dir) => configRef.current.onArrow?.(dir) ?? false,
      onEnter: () => configRef.current.onEnter?.() ?? false,
      onEscape: () => configRef.current.onEscape?.(),
      onKey: (key) => configRef.current.onKey?.(key) ?? false,
      getAdjacentZone: (dir) => configRef.current.getAdjacentZone?.(dir) ?? null,
    };
    registerZone(proxy);
    return () => unregisterZone(config.id);
    // Only re-register if the zone ID changes (which it shouldn't)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.id, registerZone, unregisterZone]);
}
