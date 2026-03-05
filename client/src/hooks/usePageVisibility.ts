import { useState, useEffect } from 'react';

/**
 * Returns `true` when the page is visible, `false` when hidden (tab backgrounded).
 * Components can use this to pause expensive work when the user isn't looking.
 */
export function usePageVisibility(): boolean {
  const [visible, setVisible] = useState(!document.hidden);

  useEffect(() => {
    const handler = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  return visible;
}
