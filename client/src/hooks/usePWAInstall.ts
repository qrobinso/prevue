import { useState, useEffect, useCallback } from 'react';
import { isIOS } from '../utils/platform';

/** Detect if running as installed PWA (standalone) */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    document.referrer.includes('android-app://')
  );
}

export interface PWAInstallState {
  canInstall: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  prompt: (() => Promise<void>) | null;
}

export function usePWAInstall(): PWAInstallState {
  const [deferredPrompt, setDeferredPrompt] = useState<{ prompt: () => Promise<{ outcome: string }> } | null>(null);
  const [canInstall, setCanInstall] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    setIsInstalled(isStandalone());
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as unknown as { prompt: () => Promise<{ outcome: string }> });
      setCanInstall(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const prompt = useCallback(async () => {
    if (deferredPrompt) {
      const { outcome } = await deferredPrompt.prompt();
      if (outcome === 'accepted') {
        setCanInstall(false);
        setDeferredPrompt(null);
        setIsInstalled(true);
      }
    }
  }, [deferredPrompt]);

  return {
    canInstall: canInstall && !!deferredPrompt,
    isInstalled,
    isIOS: isIOS(),
    prompt: (canInstall && deferredPrompt) ? prompt : null,
  };
}
