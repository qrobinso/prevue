import { useContext, useMemo } from 'react';
import { NotificationRootContext } from './NotificationProvider';
import { NotificationScopeContext } from './NotificationScope';
import type { ConfirmOptions, OverlayApi, ToastOptions } from './types';

interface NoopOverlayApi extends OverlayApi {
  readonly _isNoop: true;
}

const NOOP_OVERLAY: NoopOverlayApi = {
  show: () => {},
  hide: () => {},
  _isNoop: true,
};

/**
 * Unified notification hook. Exposes:
 *   - `toast(opts)` — transient message in app-corner
 *   - `confirm(opts)` — modal confirmation dialog (returns Promise<boolean>)
 *   - `overlay` — priority-queued bottom overlay (view-scoped)
 *
 * `toast` and `confirm` require a `NotificationProvider` at the app root.
 * `overlay` requires a `NotificationScope` in the current subtree (Player,
 * PreviewPanel). Calling overlay outside a scope is a safe no-op.
 */
export function useNotifications() {
  const root = useContext(NotificationRootContext);
  const scope = useContext(NotificationScopeContext);

  if (!root) {
    throw new Error('useNotifications must be used within a <NotificationProvider>');
  }

  return useMemo(
    () => ({
      toast: (opts: ToastOptions) => root.toast(opts),
      dismissToast: (id: string) => root.dismissToast(id),
      confirm: (opts: ConfirmOptions) => root.confirm(opts),
      overlay: scope ?? (NOOP_OVERLAY as OverlayApi),
    }),
    [root, scope],
  );
}
