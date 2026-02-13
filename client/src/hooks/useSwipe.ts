import { useCallback, useRef } from 'react';

const SWIPE_THRESHOLD = 50;
/** Require vertical movement to dominate (avoid triggering on diagonal/scroll) */
const VERTICAL_DOMINANCE = 1.5; // |deltaY| must be >= 1.5 * |deltaX|

interface SwipeHandlers {
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  /** When false, swipes are ignored. Default true. */
  enabled?: boolean;
}

export function useSwipe(handlers: SwipeHandlers) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const didSwipeRef = useRef(false);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    didSwipeRef.current = false;
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (start.current === null) return;
    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const deltaX = Math.abs(endX - start.current.x);
    const deltaY = start.current.y - endY;
    start.current = null;

    const { onSwipeUp, onSwipeDown, enabled = true } = handlersRef.current;
    if (!enabled) return;

    // Only trigger if vertical movement dominates (avoids conflict with horizontal scroll)
    if (Math.abs(deltaY) < deltaX * VERTICAL_DOMINANCE) return;
    if (deltaY > SWIPE_THRESHOLD) {
      didSwipeRef.current = true;
      onSwipeUp?.();
      setTimeout(() => { didSwipeRef.current = false; }, 300);
    } else if (deltaY < -SWIPE_THRESHOLD) {
      didSwipeRef.current = true;
      onSwipeDown?.();
      setTimeout(() => { didSwipeRef.current = false; }, 300);
    }
  }, []);

  return { onTouchStart, onTouchEnd, didSwipeRef };
}
