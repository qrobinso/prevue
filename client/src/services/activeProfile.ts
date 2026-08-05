const ACTIVE_PROFILE_KEY = 'prevue_active_profile_id';

/** The device-local active profile id, or null when unset or unreadable. */
export function getActiveProfileId(): number | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY);
    if (!raw) return null;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Persist the device-local active profile id. Pass null to clear it. */
export function setActiveProfileId(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_PROFILE_KEY);
    else localStorage.setItem(ACTIVE_PROFILE_KEY, String(id));
  } catch {
    // localStorage unavailable; the id is ephemeral for this session.
  }
}
