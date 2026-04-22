import { createContext, useCallback, useRef, useState, type ReactNode } from 'react';
import ToastRenderer from './ToastRenderer';
import ConfirmRenderer from './ConfirmRenderer';
import type {
  ToastItem,
  ToastOptions,
  ConfirmItem,
  ConfirmOptions,
} from './types';
import './Notifications.css';

const DEFAULT_TOAST_DURATION = 3500;
const MAX_TOASTS = 4;

interface RootCtx {
  toast: (opts: ToastOptions) => string;
  dismissToast: (id: string) => void;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

export const NotificationRootContext = createContext<RootCtx | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmItem, setConfirmItem] = useState<ConfirmItem | null>(null);
  const idCounter = useRef(0);

  const nextId = useCallback((prefix: string) => {
    idCounter.current += 1;
    return `${prefix}-${Date.now()}-${idCounter.current}`;
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((opts: ToastOptions) => {
    const id = opts.id ?? nextId('toast');
    const item: ToastItem = {
      id,
      message: opts.message,
      variant: opts.variant ?? 'info',
      duration: opts.duration ?? DEFAULT_TOAST_DURATION,
      createdAt: Date.now(),
    };
    setToasts((prev) => {
      const existing = prev.findIndex((t) => t.id === id);
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = item;
        return next;
      }
      const next = [...prev, item];
      // Cap stack size — drop oldest
      if (next.length > MAX_TOASTS) next.splice(0, next.length - MAX_TOASTS);
      return next;
    });
    return id;
  }, [nextId]);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      // If a confirm is already open, auto-cancel it so the new one takes over.
      setConfirmItem((prev) => {
        if (prev) prev.resolve(false);
        return { id: nextId('confirm'), options: opts, resolve };
      });
    });
  }, [nextId]);

  const handleConfirmResolve = useCallback((value: boolean) => {
    setConfirmItem((prev) => {
      prev?.resolve(value);
      return null;
    });
  }, []);

  const ctx: RootCtx = { toast, dismissToast, confirm };

  return (
    <NotificationRootContext.Provider value={ctx}>
      {children}
      <ToastRenderer toasts={toasts} onDismiss={dismissToast} />
      <ConfirmRenderer
        item={confirmItem}
        onResolve={handleConfirmResolve}
      />
    </NotificationRootContext.Provider>
  );
}
