import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { focusFirst, saveFocus, restoreFocus } from './focusUtils';

// ── Types ──────────────────────────────────────────

export interface ZoneConfig {
  id: string;
  /** Handle directional input. Return true if handled. */
  onArrow?: (dir: 'up' | 'down' | 'left' | 'right') => boolean;
  /** Handle Enter/OK. Return true if handled. */
  onEnter?: () => boolean;
  /** Handle Escape/Back. */
  onEscape?: () => void;
  /** Handle other shortcut keys (R, F, I, etc.). Return true if handled. */
  onKey?: (key: string) => boolean;
  /** Which zone to transition to when at the edge of this zone. */
  getAdjacentZone?: (dir: 'up' | 'down' | 'left' | 'right') => string | null;
}

export interface LayerConfig {
  id: string;
  containerRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
  /** Handle directional input within the layer. Return true if handled. */
  onArrow?: (dir: 'up' | 'down' | 'left' | 'right') => boolean;
  /** Handle Enter within the layer. Return true if handled. */
  onEnter?: () => boolean;
  /** Handle other keys within the layer. Return true if handled. */
  onKey?: (key: string) => boolean;
  /** What to focus on mount: 'first' focusable child, or 'none'. Default: 'first' */
  initialFocus?: 'first' | 'none';
}

interface NavigationContextValue {
  activeZone: string;
  setActiveZone: (id: string) => void;
  registerZone: (config: ZoneConfig) => void;
  unregisterZone: (id: string) => void;
  pushLayer: (config: LayerConfig) => void;
  popLayer: (id: string) => void;
  topLayer: string | null;
}

// ── Context ────────────────────────────────────────

const NavigationCtx = createContext<NavigationContextValue | null>(null);

export function useNavigation(): NavigationContextValue {
  const ctx = useContext(NavigationCtx);
  if (!ctx) throw new Error('useNavigation must be used within NavigationProvider');
  return ctx;
}

// ── Provider ───────────────────────────────────────

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [activeZone, setActiveZone] = useState('guide-grid');
  const zonesRef = useRef(new Map<string, ZoneConfig>());

  // Layer stack: last element is the top layer
  const [layerStack, setLayerStack] = useState<LayerConfig[]>([]);
  // Saved focus per layer so we can restore when popping
  const savedFocusRef = useRef(new Map<string, HTMLElement | null>());

  const topLayer = layerStack.length > 0 ? layerStack[layerStack.length - 1].id : null;

  // ── Zone registry ──

  const registerZone = useCallback((config: ZoneConfig) => {
    zonesRef.current.set(config.id, config);
  }, []);

  const unregisterZone = useCallback((id: string) => {
    zonesRef.current.delete(id);
  }, []);

  // ── Layer stack ──

  const pushLayer = useCallback((config: LayerConfig) => {
    savedFocusRef.current.set(config.id, saveFocus());
    setLayerStack((prev) => [...prev, config]);

    // Focus the layer container's first child after a tick (so the DOM has rendered)
    if (config.initialFocus !== 'none') {
      requestAnimationFrame(() => {
        if (config.containerRef.current) {
          focusFirst(config.containerRef.current);
        }
      });
    }
  }, []);

  const popLayer = useCallback((id: string) => {
    setLayerStack((prev) => prev.filter((l) => l.id !== id));
    const saved = savedFocusRef.current.get(id);
    savedFocusRef.current.delete(id);
    // Restore focus after a tick so the layer's DOM has unmounted
    requestAnimationFrame(() => {
      restoreFocus(saved ?? null);
    });
  }, []);

  // ── Global keydown handler ──

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture if user is typing in an input/textarea (unless Escape)
      const isInput =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

      // ── Route to top layer if one is active ──
      if (layerStack.length > 0) {
        const layer = layerStack[layerStack.length - 1];

        if (e.key === 'Escape') {
          e.preventDefault();
          layer.onEscape();
          return;
        }

        // Let inputs handle their own keys (except Escape above)
        if (isInput) return;

        const dir = keyToDirection(e.key);
        if (dir) {
          if (layer.onArrow?.(dir)) {
            e.preventDefault();
            return;
          }
          // If layer didn't handle it, let the browser do default focus traversal
          return;
        }

        if (e.key === 'Enter' || e.key === ' ') {
          if (layer.onEnter?.()) {
            e.preventDefault();
            return;
          }
          // Let default click happen on focused button
          return;
        }

        if (layer.onKey?.(e.key)) {
          e.preventDefault();
          return;
        }

        return;
      }

      // ── No layer — route to active zone ──

      if (isInput) return;

      const zone = zonesRef.current.get(activeZone);
      if (!zone) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        zone.onEscape?.();
        return;
      }

      const dir = keyToDirection(e.key);
      if (dir) {
        e.preventDefault();
        const handled = zone.onArrow?.(dir) ?? false;
        if (!handled) {
          // Try to transition to adjacent zone
          const nextZoneId = zone.getAdjacentZone?.(dir);
          if (nextZoneId) {
            const nextZone = zonesRef.current.get(nextZoneId);
            if (nextZone) {
              setActiveZone(nextZoneId);
              // If the next zone has a container to focus, the zone itself should handle it
              // via its onArrow getting called next time. For DOM-based zones, we need to
              // signal them. We do this by calling their onArrow with the opposite direction's
              // entry — but simpler: just let the zone handle focus on activation.
            }
          }
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        zone.onEnter?.();
        return;
      }

      // Shortcut keys
      if (zone.onKey?.(e.key)) {
        e.preventDefault();
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeZone, layerStack]);

  const value: NavigationContextValue = {
    activeZone,
    setActiveZone,
    registerZone,
    unregisterZone,
    pushLayer,
    popLayer,
    topLayer,
  };

  return <NavigationCtx.Provider value={value}>{children}</NavigationCtx.Provider>;
}

// ── Helpers ────────────────────────────────────────

function keyToDirection(key: string): 'up' | 'down' | 'left' | 'right' | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'up';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}
