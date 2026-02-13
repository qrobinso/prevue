import { useEffect } from 'react';
import type { AppView } from '../App';

interface KeyboardHandlers {
  onEscape?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onEnter?: () => void;
}

export function useKeyboard(view: AppView, handlers: KeyboardHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          handlers.onEscape?.();
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
          e.preventDefault();
          handlers.onUp?.();
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          e.preventDefault();
          handlers.onDown?.();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          handlers.onLeft?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          handlers.onRight?.();
          break;
        case 'Enter':
          e.preventDefault();
          handlers.onEnter?.();
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, handlers, enabled]);
}
