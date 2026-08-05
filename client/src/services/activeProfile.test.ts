import { describe, it, expect } from 'vitest';
import { getActiveProfileId, setActiveProfileId } from './activeProfile';

describe('activeProfile', () => {
  it('returns null when nothing is stored', () => {
    expect(getActiveProfileId()).toBeNull();
  });

  it('round-trips an id', () => {
    setActiveProfileId(7);
    expect(getActiveProfileId()).toBe(7);
  });

  it('clears the stored id', () => {
    setActiveProfileId(7);
    setActiveProfileId(null);
    expect(getActiveProfileId()).toBeNull();
  });

  it('returns null for a corrupt stored value', () => {
    localStorage.setItem('prevue_active_profile_id', 'not-a-number');
    expect(getActiveProfileId()).toBeNull();
  });

  it('returns null for a non-positive stored value', () => {
    localStorage.setItem('prevue_active_profile_id', '0');
    expect(getActiveProfileId()).toBeNull();
  });
});
