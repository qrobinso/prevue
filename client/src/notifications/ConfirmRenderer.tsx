import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ConfirmItem } from './types';

interface ConfirmRendererProps {
  item: ConfirmItem | null;
  onResolve: (value: boolean) => void;
}

export default function ConfirmRenderer({ item, onResolve }: ConfirmRendererProps) {
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!item) return;
    confirmBtnRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onResolve(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [item, onResolve]);

  if (!item || typeof document === 'undefined') return null;

  const { title, message, confirmLabel, cancelLabel, destructive } = item.options;

  return createPortal(
    <div
      className="notifications-confirm-backdrop"
      onClick={() => onResolve(false)}
      role="presentation"
    >
      <div
        className="notifications-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={title ? `confirm-${item.id}-title` : undefined}
        aria-describedby={`confirm-${item.id}-message`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <h2 id={`confirm-${item.id}-title`} className="notifications-confirm-title">
            {title}
          </h2>
        )}
        <p id={`confirm-${item.id}-message`} className="notifications-confirm-message">
          {message}
        </p>
        <div className="notifications-confirm-actions">
          <button
            type="button"
            className="notifications-confirm-btn notifications-confirm-cancel"
            onClick={() => onResolve(false)}
          >
            {cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`notifications-confirm-btn notifications-confirm-ok${destructive ? ' notifications-confirm-ok--destructive' : ''}`}
            onClick={() => onResolve(true)}
          >
            {confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
