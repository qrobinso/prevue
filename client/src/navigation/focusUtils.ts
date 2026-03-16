const DEFAULT_SELECTOR =
  'button:not([disabled]):not([aria-hidden="true"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

/** Query all focusable children inside a container. */
export function getFocusableChildren(
  container: HTMLElement,
  selector: string = DEFAULT_SELECTOR,
): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => el.offsetParent !== null, // visible
  );
}

/** Focus the first focusable child inside a container. */
export function focusFirst(container: HTMLElement, selector?: string): void {
  const children = getFocusableChildren(container, selector);
  if (children.length > 0) {
    children[0].focus();
  }
}

/** Focus a specific child matching a CSS selector. */
export function focusBySelector(container: HTMLElement, sel: string): void {
  const el = container.querySelector<HTMLElement>(sel);
  if (el) el.focus();
}

/** Save the currently focused element. */
export function saveFocus(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** Restore focus to a previously saved element. */
export function restoreFocus(saved: HTMLElement | null): void {
  if (saved && saved.isConnected) {
    saved.focus();
  }
}

export { DEFAULT_SELECTOR };
