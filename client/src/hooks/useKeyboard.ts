import { useEffect, useRef } from 'react';
import type { AppView } from '../App';

interface KeyboardHandlers {
  onEscape?: () => void;
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onEnter?: () => void;
  onLastChannel?: () => void;
  onRandomChannel?: () => void;
  onFullscreen?: () => void;
  onInfo?: () => void;
  onGuide?: () => void;
  onSleepTimer?: () => void;
  onCatchUp?: () => void;
}

export function useKeyboard(view: AppView, handlers: KeyboardHandlers, enabled = true) {
  // Store handlers in a ref so the effect doesn't re-subscribe on every render
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Don't capture if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const h = handlersRef.current;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          h.onEscape?.();
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
          e.preventDefault();
          h.onUp?.();
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          e.preventDefault();
          h.onDown?.();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          h.onLeft?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          h.onRight?.();
          break;
        case 'Enter':
          e.preventDefault();
          h.onEnter?.();
          break;
        case 'Backspace':
        case 'Delete':
          e.preventDefault();
          h.onLastChannel?.();
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          h.onRandomChannel?.();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          h.onFullscreen?.();
          break;
        case 'i':
        case 'I':
          e.preventDefault();
          h.onInfo?.();
          break;
        case 'g':
        case 'G':
          e.preventDefault();
          h.onGuide?.();
          break;
        case 't':
        case 'T':
          e.preventDefault();
          h.onSleepTimer?.();
          break;
        case 'm':
        case 'M':
          if (h.onCatchUp) {
            e.preventDefault();
            h.onCatchUp();
          }
          break;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, enabled]);
}
