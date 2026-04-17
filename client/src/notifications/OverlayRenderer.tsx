import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from '@phosphor-icons/react';
import type { OverlayData } from './types';

interface OverlayRendererProps {
  /** The current overlay data, or null when idle. */
  data: OverlayData | null;
  /** Controls visibility. When false, triggers exit animation then notifies onExited. */
  visible: boolean;
  /** User swipe/X button dismiss. Consumer should flip visible to false. */
  onDismiss: () => void;
  /** Called after exit animation completes. */
  onExited: () => void;
}

const SWIPE_THRESHOLD = 40;
const EXIT_TRANSITION_MS = 550;
const DEFAULT_Z_INDEX = 20;

export default function OverlayRenderer({
  data,
  visible,
  onDismiss,
  onExited,
}: OverlayRendererProps) {
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

  useEffect(() => {
    if (visible) {
      if (exitTimer.current) {
        clearTimeout(exitTimer.current);
        exitTimer.current = null;
      }
      setRendered(true);
      requestAnimationFrame(() => setEntered(true));
    } else if (rendered) {
      setEntered(false);
      clearDismissTimer();
      exitTimer.current = setTimeout(() => {
        setRendered(false);
        onExited();
      }, EXIT_TRANSITION_MS);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const autoDismissMs = data?.autoDismissMs ?? 0;
  const pauseOnHover = data?.pauseOnHover ?? false;

  useEffect(() => {
    if (entered && autoDismissMs > 0) {
      dismissStartedAt.current = Date.now();
      dismissRemaining.current = autoDismissMs;
      dismissTimer.current = setTimeout(() => onDismiss(), autoDismissMs);
      return () => clearDismissTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered, autoDismissMs]);

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
    dismissTimer.current = setTimeout(() => onDismiss(), dismissRemaining.current);
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
    if (deltaY > SWIPE_THRESHOLD) onDismiss();
  }, [onDismiss]);

  if (!rendered || !data) return null;

  const isClickable = !!data.onClick;

  return (
    <div
      className={[
        'notifications-overlay',
        entered && 'notifications-overlay--entered',
        isClickable && 'notifications-overlay--clickable',
        data.className,
      ].filter(Boolean).join(' ')}
      style={{ zIndex: DEFAULT_Z_INDEX }}
      onClick={data.onClick}
      onMouseEnter={pauseOnHover ? handleMouseEnter : undefined}
      onMouseLeave={pauseOnHover ? handleMouseLeave : undefined}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') data.onClick?.(); } : undefined}
    >
      <div className="notifications-overlay-card">
        <div className="notifications-overlay-info">
          <span
            className="notifications-overlay-label"
            style={data.labelColor ? { color: data.labelColor } : undefined}
          >
            {data.label}
          </span>
          <span className="notifications-overlay-title">{data.title}</span>
          {data.subtitle && (
            <span className="notifications-overlay-subtitle">{data.subtitle}</span>
          )}
          {data.meta && (
            <div className="notifications-overlay-meta">{data.meta}</div>
          )}
        </div>
        {data.backdropUrl && (
          <div
            className="notifications-overlay-backdrop"
            style={{ backgroundImage: `url("${data.backdropUrl}")` }}
          />
        )}
        <button
          type="button"
          className="notifications-overlay-close"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          aria-label="Close notification"
        >
          <X size={16} weight="bold" />
        </button>
      </div>
    </div>
  );
}
