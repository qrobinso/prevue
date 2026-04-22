import { createContext, useCallback, useRef, useState, type ReactNode } from 'react';
import OverlayRenderer from './OverlayRenderer';
import type { OverlayApi, OverlayData } from './types';

interface Registration {
  id: string;
  priority: number;
  data: OverlayData;
}

export const NotificationScopeContext = createContext<OverlayApi | null>(null);

/**
 * Scoped overlay provider. Wrap any subtree whose bottom-anchored notifications
 * should render within its own positioned container (the scope's immediate
 * positioned ancestor). Overlays are priority-queued and swipe-dismissable.
 */
export function NotificationScope({ children }: { children: ReactNode }) {
  const registrations = useRef<Map<string, Registration>>(new Map());
  const dismissedRef = useRef<Set<string>>(new Set());

  const [displayedId, setDisplayedId] = useState<string | null>(null);
  const [displayedData, setDisplayedData] = useState<OverlayData | null>(null);
  const [visible, setVisible] = useState(false);

  const pendingRef = useRef<Registration | null>(null);
  const exitingRef = useRef(false);
  const displayedIdRef = useRef<string | null>(null);
  displayedIdRef.current = displayedId;

  const pickHighest = useCallback((): Registration | null => {
    let best: Registration | null = null;
    for (const reg of registrations.current.values()) {
      if (dismissedRef.current.has(reg.id)) continue;
      if (!best || reg.priority > best.priority) best = reg;
    }
    return best;
  }, []);

  const reconcile = useCallback(() => {
    const best = pickHighest();
    const currentId = displayedIdRef.current;

    if (!best && !currentId && !exitingRef.current) {
      pendingRef.current = null;
      return;
    }

    if (!best) {
      pendingRef.current = null;
      if (currentId && !exitingRef.current) {
        exitingRef.current = true;
        setVisible(false);
      }
      return;
    }

    if (best.id === currentId && !exitingRef.current) {
      setDisplayedData(best.data);
      return;
    }

    if (!currentId && !exitingRef.current) {
      pendingRef.current = null;
      setDisplayedId(best.id);
      setDisplayedData(best.data);
      setVisible(true);
      return;
    }

    pendingRef.current = best;
    if (!exitingRef.current) {
      exitingRef.current = true;
      setVisible(false);
    }
  }, [pickHighest]);

  const show = useCallback((id: string, priority: number, data: OverlayData) => {
    // Only clear dismissed state for new registrations, not updates —
    // prevents re-showing a notification the user explicitly closed.
    if (!registrations.current.has(id)) {
      dismissedRef.current.delete(id);
    }
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
      const reg = registrations.current.get(id);
      reg?.data.onDismiss?.();
      dismissedRef.current.add(id);
    }
    reconcile();
  }, [reconcile]);

  const handleExited = useCallback(() => {
    exitingRef.current = false;
    const next = pendingRef.current;
    pendingRef.current = null;

    if (next) {
      setDisplayedId(next.id);
      setDisplayedData(next.data);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setDisplayedId(null);
      setDisplayedData(null);
      setVisible(false);
    }
  }, []);

  const api: OverlayApi = { show, hide };

  return (
    <NotificationScopeContext.Provider value={api}>
      {children}
      <OverlayRenderer
        key={displayedId ?? 'idle'}
        data={displayedData}
        visible={visible}
        onDismiss={handleDismiss}
        onExited={handleExited}
      />
    </NotificationScopeContext.Provider>
  );
}
