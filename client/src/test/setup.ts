import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom doesn't run layout, so `offsetParent` is always null there. Our
// navigation utilities (getFocusableChildren) use offsetParent !== null as a
// cheap "is this visible" check, so polyfill it to reflect the DOM structure
// instead: an element is "visible" if it's attached under a non-display:none
// ancestor. This mirrors the real-browser behavior closely enough for tests.
Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
  get() {
    if (this.style?.display === 'none') return null;
    return this.parentElement;
  },
  configurable: true,
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});
