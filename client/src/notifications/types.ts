import type { ReactNode } from 'react';

// ── Toast ──────────────────────────────────────────
export type ToastVariant = 'success' | 'error' | 'info' | 'warn';

export interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss after ms. 0 = sticky. Default: 3500. */
  duration?: number;
  /** Provide to update/replace an existing toast in place. */
  id?: string;
}

// ── Confirm ────────────────────────────────────────
export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

// ── Overlay (bottom, priority-queued, view-scoped) ──
export interface OverlayData {
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
  /** Called when the user explicitly dismisses (X button, swipe, auto-dismiss). */
  onDismiss?: () => void;
  /** Make the bar clickable. */
  onClick?: () => void;
}

export interface OverlayApi {
  /** Show or update an overlay. Higher priority wins. */
  show: (id: string, priority: number, data: OverlayData) => void;
  /** Remove an overlay by id. */
  hide: (id: string) => void;
}

// ── Internal shapes ────────────────────────────────
export interface ToastItem {
  id: string;
  message: string;
  variant: ToastVariant;
  duration: number;
  createdAt: number;
}

export interface ConfirmItem {
  id: string;
  options: ConfirmOptions;
  resolve: (value: boolean) => void;
}
