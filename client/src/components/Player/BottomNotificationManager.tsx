import { createContext, useContext, useCallback, useRef, useState, type ReactNode } from 'react';
import BottomNotification from './BottomNotification';

// ── Public types ────────────────────────────────────

export interface NotificationData {
  label: string;
  /** CSS color for the label text. */
  labelColor?: string;
  title: string;
  subtitle?: string;
  /** Optional extra content rendered below the subtitle (e.g. metadata chips). */
  meta?: ReactNode;
  /** Background image URL for a backdrop thumbnail. */
  backdropUrl?: string;
  /** CSS modifier class on the outer wrapper. */
  className?: string;
  /** Auto-dismiss after this many ms. 0 = stay until dismissed. */
  autoDismissMs?: number;
  /** Pause auto-dismiss on mouse hover. */
  pauseOnHover?: boolean;
  /** Make the bar clickable. */
  onClick?: () => void;
}

interface Registration {
  id: string;
  priority: number;
  data: NotificationData;
}

// ── Context ─────────────────────────────────────────

interface BottomNotificationCtx {
  /** Show or update a notification. Higher priority wins. */
  show: (id: string, priority: number, data: NotificationData) => void;
  /** Remove a notification by id. */
  hide: (id: string) => void;
}

const Ctx = createContext<BottomNotificationCtx>({
  show: () => {},
  hide: () => {},
});

export function useBottomNotifications() {
  return useContext(Ctx);
}

// ── Provider + renderer ─────────────────────────────

export function BottomNotificationProvider({ children }: { children: ReactNode }) {
  const registrations = useRef<Map<string, Registration>>(new Map());
  const dismissedRef = useRef<Set<string>>(new Set());

  // What is currently rendered on screen
  const [displayedId, setDisplayedId] = useState<string | null>(null);
  const [displayedData, setDisplayedData] = useState<NotificationData | null>(null);
  const [visible, setVisible] = useState(false);

  // Refs for transition state machine
  const pendingRef = useRef<Registration | null>(null);
  const exitingRef = useRef(false);
  const displayedIdRef = useRef<string | null>(null);
  displayedIdRef.current = displayedId;

  const pickHighest = useCallback((): Registration | null => {
    let best: Registration | null = null;
    for (const reg of registrations.current.values()) {
      if (dismissedRef.current.has(reg.id)) continue;
      if (!best || reg.priority > best.priority) {
        best = reg;
      }
    }
    return best;
  }, []);

  const reconcile = useCallback(() => {
    const best = pickHighest();
    const currentId = displayedIdRef.current;

    // Case 1: Nothing to show, nothing displayed → no-op
    if (!best && !currentId && !exitingRef.current) {
      pendingRef.current = null;
      return;
    }

    // Case 2: Nothing to show, something displayed → exit
    if (!best) {
      pendingRef.current = null;
      if (currentId && !exitingRef.current) {
        exitingRef.current = true;
        setVisible(false);
      }
      return;
    }

    // Case 3: Same winner as displayed → update data in place (no animation)
    if (best.id === currentId && !exitingRef.current) {
      setDisplayedData(best.data);
      return;
    }

    // Case 4a: Winner arrives while nothing displayed and not exiting → show directly
    if (!currentId && !exitingRef.current) {
      pendingRef.current = null;
      setDisplayedId(best.id);
      setDisplayedData(best.data);
      setVisible(true);
      return;
    }

    // Case 4b: Different winner while something is displayed or exiting → queue transition
    pendingRef.current = best;
    if (!exitingRef.current) {
      exitingRef.current = true;
      setVisible(false); // trigger exit animation on current
    }
    // If already exiting, onExited will pick up the updated pendingRef
  }, [pickHighest]);

  const show = useCallback((id: string, priority: number, data: NotificationData) => {
    dismissedRef.current.delete(id);
    registrations.current.set(id, { id, priority, data });
    reconcile();
  }, [reconcile]);

  const hide = useCallback((id: string) => {
    registrations.current.delete(id);
    dismissedRef.current.delete(id);
    reconcile();
  }, [reconcile]);

  const handleDismiss = useCallback(() => {
    const id = displayedIdRef.current;
    if (id) {
      dismissedRef.current.add(id);
    }
    reconcile();
  }, [reconcile]);

  const handleExited = useCallback(() => {
    exitingRef.current = false;

    const next = pendingRef.current;
    pendingRef.current = null;

    if (next) {
      // Show the queued notification
      setDisplayedId(next.id);
      setDisplayedData(next.data);
      requestAnimationFrame(() => setVisible(true));
    } else {
      // Fully idle
      setDisplayedId(null);
      setDisplayedData(null);
      setVisible(false);
    }
  }, []);

  const ctx = { show, hide };

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {displayedData && (
        <BottomNotification
          key={displayedId}
          visible={visible}
          onDismiss={handleDismiss}
          onExited={handleExited}
          autoDismissMs={displayedData.autoDismissMs}
          pauseOnHover={displayedData.pauseOnHover}
          onClick={displayedData.onClick}
          className={displayedData.className}
        >
          <div className="bottom-notification-info">
            <span
              className="bottom-notification-label"
              style={displayedData.labelColor ? { color: displayedData.labelColor } : undefined}
            >
              {displayedData.label}
            </span>
            <span className="bottom-notification-title">{displayedData.title}</span>
            {displayedData.subtitle && (
              <span className="bottom-notification-subtitle">{displayedData.subtitle}</span>
            )}
            {displayedData.meta && (
              <div className="bottom-notification-meta">{displayedData.meta}</div>
            )}
          </div>
          {displayedData.backdropUrl && (
            <div
              className="bottom-notification-backdrop"
              style={{ backgroundImage: `url("${displayedData.backdropUrl}")` }}
            />
          )}
        </BottomNotification>
      )}
    </Ctx.Provider>
  );
}
