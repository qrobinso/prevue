import { getFocusableChildren, DEFAULT_SELECTOR } from './focusUtils';

export interface FocusGroupOptions {
  orientation?: 'horizontal' | 'vertical';
  wrap?: boolean;
  selector?: string;
}

/**
 * Move focus within a container in the given direction.
 * Returns true if focus was moved, false if at the edge (and wrap is off).
 *
 * This is a pure function — no hooks, no listeners. The zone/layer handler
 * calls this imperatively on each relevant arrow keypress.
 */
export function moveFocus(
  container: HTMLElement,
  direction: 'next' | 'prev',
  options: FocusGroupOptions = {},
): boolean {
  const { wrap = true, selector = DEFAULT_SELECTOR } = options;
  const children = getFocusableChildren(container, selector);
  if (children.length === 0) return false;

  const active = document.activeElement as HTMLElement;
  let idx = children.indexOf(active);

  if (idx === -1) {
    // Active element is not in this group — focus the first/last child
    children[direction === 'next' ? 0 : children.length - 1].focus();
    return true;
  }

  if (direction === 'next') {
    if (idx < children.length - 1) {
      children[idx + 1].focus();
      return true;
    }
    if (wrap) {
      children[0].focus();
      return true;
    }
    return false;
  } else {
    if (idx > 0) {
      children[idx - 1].focus();
      return true;
    }
    if (wrap) {
      children[children.length - 1].focus();
      return true;
    }
    return false;
  }
}

/**
 * Map an arrow direction to next/prev based on orientation.
 * Returns null if the arrow is not relevant for this orientation.
 */
export function arrowToDirection(
  arrow: 'up' | 'down' | 'left' | 'right',
  orientation: 'horizontal' | 'vertical',
): 'next' | 'prev' | null {
  if (orientation === 'horizontal') {
    if (arrow === 'right') return 'next';
    if (arrow === 'left') return 'prev';
    return null;
  } else {
    if (arrow === 'down') return 'next';
    if (arrow === 'up') return 'prev';
    return null;
  }
}
