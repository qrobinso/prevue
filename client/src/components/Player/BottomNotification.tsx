import { useState, useEffect, useRef, useCallback } from 'react';
import { X } from '@phosphor-icons/react';
import './Player.css';

interface BottomNotificationProps {
  /** Controls visibility. When false, triggers exit animation then unmounts. */
  visible: boolean;
  /** Called when user swipes down to dismiss. Consumer should set visible=false. */
  onDismiss?: () => void;
  /** Called after exit animation completes and component unmounts from DOM. */
  onExited?: () => void;
  /** Auto-dismiss after this many ms. Omit or 0 to stay visible indefinitely. */
  autoDismissMs?: number;
  /** Pause auto-dismiss timer on mouse hover. Default: false. */
  pauseOnHover?: boolean;
  /** Make the entire bar clickable. */
  onClick?: () => void;
  /** Extra CSS class on the outer wrapper (e.g. modifier for styling). */
  className?: string;
  /** z-index override. Default: 20. */
  zIndex?: number;
  children: React.ReactNode;
}

const SWIPE_THRESHOLD = 40;
const EXIT_TRANSITION_MS = 550;

export default function BottomNotification({
  visible,
  onDismiss,
  onExited,
  autoDismissMs = 0,
  pauseOnHover = false,
  onClick,
  className,
  zIndex = 20,
  children,
}: BottomNotificationProps) {
  const [rendered, setRendered] = useState(false);
  const [entered, setEntered] = useState(false);

  const touchStartY = useRef<number | null>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissStartedAt = useRef(0);
  const dismissRemaining = useRef(0);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimer.current) {
      clearTimeout(dismissTimer.current);
      dismissTimer.current = null;
    }
  }, []);

  // Enter: mount then trigger slide-in on next frame
  useEffect(() => {
    if (visible) {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      setRendered(true);
      requestAnimationFrame(() => setEntered(true));
    } else if (rendered) {
      // Exit: slide out then unmount
      setEntered(false);
      clearDismissTimer();
      exitTimer.current = setTimeout(() => {
        setRendered(false);
        onExited?.();
      }, EXIT_TRANSITION_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Auto-dismiss timer
  useEffect(() => {
    if (entered && autoDismissMs > 0) {
      dismissStartedAt.current = Date.now();
      dismissRemaining.current = autoDismissMs;
      dismissTimer.current = setTimeout(() => {
        onDismiss?.();
      }, autoDismissMs);
      return () => clearDismissTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered, autoDismissMs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (exitTimer.current) clearTimeout(exitTimer.current);
      clearDismissTimer();
    };
  }, [clearDismissTimer]);

  const handleMouseEnter = useCallback(() => {
    if (!pauseOnHover || !dismissTimer.current) return;
    const elapsed = Date.now() - dismissStartedAt.current;
    dismissRemaining.current = Math.max(0, dismissRemaining.current - elapsed);
    clearDismissTimer();
  }, [pauseOnHover, clearDismissTimer]);

  const handleMouseLeave = useCallback(() => {
    if (!pauseOnHover || dismissRemaining.current <= 0 || !entered) return;
    dismissStartedAt.current = Date.now();
    dismissTimer.current = setTimeout(() => {
      onDismiss?.();
    }, dismissRemaining.current);
  }, [pauseOnHover, entered, onDismiss]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    touchStartY.current = e.touches[0].clientY;
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    if (touchStartY.current === null) return;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;
    touchStartY.current = null;
    if (deltaY > SWIPE_THRESHOLD) {
      onDismiss?.();
    }
  }, [onDismiss]);

  if (!rendered) return null;

  const isClickable = !!onClick;

  return (
    <div
      className={[
        'bottom-notification',
        entered && 'bottom-notification-entered',
        isClickable && 'bottom-notification-clickable',
        className,
      ].filter(Boolean).join(' ')}
      style={{ zIndex }}
      onClick={onClick}
      onMouseEnter={pauseOnHover ? handleMouseEnter : undefined}
      onMouseLeave={pauseOnHover ? handleMouseLeave : undefined}
      onTouchStart={onDismiss ? handleTouchStart : undefined}
      onTouchEnd={onDismiss ? handleTouchEnd : undefined}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(); } : undefined}
    >
      <div className="bottom-notification-card">
        {children}
        {onDismiss && (
          <button
            className="bottom-notification-close"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            aria-label="Close notification"
          >
            <X size={16} weight="bold" />
          </button>
        )}
      </div>
    </div>
  );
}
