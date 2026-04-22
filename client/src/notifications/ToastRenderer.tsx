import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from '@phosphor-icons/react';
import type { ToastItem } from './types';

interface ToastRendererProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export default function ToastRenderer({ toasts, onDismiss }: ToastRendererProps) {
  if (typeof document === 'undefined') return null;
  if (toasts.length === 0) return null;

  return createPortal(
    <div className="notifications-toast-stack" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItemView key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body,
  );
}

interface ToastItemViewProps {
  item: ToastItem;
  onDismiss: (id: string) => void;
}

function ToastItemView({ item, onDismiss }: ToastItemViewProps) {
  useEffect(() => {
    if (item.duration <= 0) return;
    const timer = setTimeout(() => onDismiss(item.id), item.duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, onDismiss]);

  return (
    <div
      className={`notifications-toast notifications-toast--${item.variant}`}
      role={item.variant === 'error' || item.variant === 'warn' ? 'alert' : 'status'}
    >
      <span className="notifications-toast-message">{item.message}</span>
      <button
        type="button"
        className="notifications-toast-close"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  );
}
