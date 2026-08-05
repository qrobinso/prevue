import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  getProfiles as apiGetProfiles,
  getProfilePrefs as apiGetProfilePrefs,
  patchProfilePrefs as apiPatchProfilePrefs,
} from '../services/api';
import { getActiveProfileId, setActiveProfileId } from '../services/activeProfile';
import type { Profile } from '../types';

const FLUSH_DEBOUNCE_MS = 400;

interface ProfileContextValue {
  profiles: Profile[];
  activeProfile: Profile | null;
  loading: boolean;
  prefs: Record<string, unknown>;
  setPref: (key: string, value: unknown) => void;
  switchProfile: (id: number) => Promise<void>;
  refreshProfiles: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null);
  const [prefs, setPrefs] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);

  // Keys changed since the last flush, plus the pending timer.
  const pendingRef = useRef<Record<string, unknown>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdRef = useRef<number | null>(null);
  // Bumped on every loadProfile call; a resolved fetch only applies its result
  // if it's still the most recently requested load, so rapid/overlapping
  // switches can't let a stale response overwrite the current profile's prefs.
  const loadGenRef = useRef(0);

  activeIdRef.current = activeProfile?.id ?? null;

  const flush = useCallback(() => {
    const id = activeIdRef.current;
    const patch = pendingRef.current;
    pendingRef.current = {};
    if (id === null || Object.keys(patch).length === 0) return;

    apiPatchProfilePrefs(id, patch).catch((err) => {
      // Keep the optimistic local value; the user's change is not reverted under them.
      console.error('[Prevue] Failed to save preferences:', err);
    });
  }, []);

  const setPref = useCallback((key: string, value: unknown) => {
    setPrefs(prev => ({ ...prev, [key]: value }));
    pendingRef.current[key] = value;

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flush();
    }, FLUSH_DEBOUNCE_MS);
  }, [flush]);

  const loadProfile = useCallback(async (profile: Profile) => {
    const gen = ++loadGenRef.current;
    setActiveProfile(profile);
    // setActiveProfileId swallows its own storage errors and returns void —
    // it cannot throw, so no try/catch is needed here. Do not re-add one.
    setActiveProfileId(profile.id);
    try {
      const loadedPrefs = await apiGetProfilePrefs(profile.id);
      // Discard if a newer load has started since this one was kicked off —
      // otherwise an out-of-order resolution could overwrite the current
      // profile's prefs with a stale profile's data.
      if (loadGenRef.current !== gen) return;
      setPrefs(loadedPrefs);
    } catch (err) {
      if (loadGenRef.current !== gen) return;
      console.error('[Prevue] Failed to load preferences:', err);
      setPrefs({});
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    const list = await apiGetProfiles();
    setProfiles(list);
  }, []);

  const switchProfile = useCallback(async (id: number) => {
    const target = profiles.find(p => p.id === id);
    if (!target) throw new Error('Profile not found');

    // Flush any pending debounced write for the OUTGOING profile before
    // switching. activeIdRef.current still points at the outgoing profile
    // here (loadProfile hasn't run yet), so flush() attributes the write
    // correctly instead of letting the debounce timer fire later and PATCH
    // the change onto the newly active profile.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      flush();
    }

    await loadProfile(target);
  }, [profiles, loadProfile, flush]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await apiGetProfiles();
        if (cancelled) return;
        setProfiles(list);

        const storedId = getActiveProfileId();
        const target = list.find(p => p.id === storedId) ?? list[0];
        if (target) await loadProfile(target);
      } catch (err) {
        console.error('[Prevue] Failed to load profiles:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [loadProfile]);

  // Flush any pending preference writes on unmount.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    flush();
  }, [flush]);

  return (
    <ProfileContext.Provider
      value={{ profiles, activeProfile, loading, prefs, setPref, switchProfile, refreshProfiles }}
    >
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile must be used within a ProfileProvider');
  return ctx;
}
