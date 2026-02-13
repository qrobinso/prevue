import { useCallback, useRef } from 'react';

const SWIPE_THRESHOLD = 50;

interface SwipeHandlers {
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
}

export function useSwipe(handlers: SwipeHandlers) {
  const startY = useRef<number | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startY.current = e.touches[0].clientY;
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (startY.current === null) return;
    const endY = e.changedTouches[0].clientY;
    const deltaY = startY.current - endY;
    startY.current = null;

    const { onSwipeUp, onSwipeDown } = handlersRef.current;
    if (deltaY > SWIPE_THRESHOLD) {
      onSwipeUp?.();
    } else if (deltaY < -SWIPE_THRESHOLD) {
      onSwipeDown?.();
    }
  }, []);

  return { onTouchStart, onTouchEnd };
}
