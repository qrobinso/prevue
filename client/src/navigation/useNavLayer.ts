import { useEffect, useRef, type RefObject } from 'react';
import { useNavigation, type LayerConfig } from './NavigationContext';

interface UseNavLayerOptions {
  /** Handle directional input within the layer. Return true if handled. */
  onArrow?: (dir: 'up' | 'down' | 'left' | 'right') => boolean;
  /** Handle Enter within the layer. Return true if handled. */
  onEnter?: () => boolean;
  /** Handle other keys within the layer. Return true if handled. */
  onKey?: (key: string) => boolean;
  /** What to focus on mount. Default: 'first' */
  initialFocus?: 'first' | 'none';
}

/**
 * Push a navigation layer (modal/overlay) on mount, pop on unmount.
 * Saves and restores focus automatically.
 */
export function useNavLayer(
  id: string,
  containerRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
  options: UseNavLayerOptions = {},
): void {
  const { pushLayer, popLayer } = useNavigation();
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const config: LayerConfig = {
      id,
      containerRef,
      onEscape: () => onEscapeRef.current(),
      onArrow: (dir) => optionsRef.current.onArrow?.(dir) ?? false,
      onEnter: () => optionsRef.current.onEnter?.() ?? false,
      onKey: (key) => optionsRef.current.onKey?.(key) ?? false,
      initialFocus: optionsRef.current.initialFocus,
    };
    pushLayer(config);
    return () => popLayer(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pushLayer, popLayer]);
}
